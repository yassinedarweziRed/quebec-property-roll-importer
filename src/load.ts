// Import one XML file into the database: read -> validate/transform -> load, with an audit log.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type pg from "pg";
import { pool } from "./db.js";
import { readUnits, type XmlNode } from "./parse.js";
import {
  buildMatricule,
  checkHeader,
  FieldError,
  transformUnit,
  type AddressRow,
  type FileInfo,
  type PropertyRow,
} from "./transform.js";

const BATCH_SIZE = 1000; // units inserted per SQL statement
const MAX_REJECTED_RATIO = 0.05; // above 5% rejected, we suspect a format change and fail the file

const PROPERTY_COLUMNS: (keyof PropertyRow)[] = [
  "matricule", "matricule18", "borough_code", "usage_code", "file_number", "neighborhood_unit",
  "frontage", "land_area", "agricultural_zone_code", "max_floors", "construction_year",
  "construction_year_estimated", "floor_area", "dwelling_count", "market_reference_date",
  "land_value", "building_value", "total_value", "previous_total_value",
  "is_serviced_vacant_land", "non_residential_class",
];
const ADDRESS_COLUMNS: (keyof AddressRow)[] = [
  "position", "number_from", "number_from_suffix", "number_to", "number_to_suffix",
  "street_type_code", "link_code", "street_name", "direction", "apartment", "apartment_suffix",
];

interface ValidUnit {
  property: PropertyRow;
  addresses: AddressRow[];
  raw: XmlNode;
}

export interface ImportResult {
  file: string;
  status: "success" | "failed" | "skipped";
  read: number;
  loaded: number;
  rejected: number;
  message?: string;
}

export async function importFile(filePath: string, force = false): Promise<ImportResult> {
  const fileName = basename(filePath);
  const hash = await sha256(filePath);
  const counts = { read: 0, loaded: 0, rejected: 0 };

  // 1. Is this exact content what is currently loaded for its municipality and year?
  //    (= a successful run with the same hash, and no newer successful run for the same scope)
  //    Then skip it, unless --force.
  if (!force) {
    const done = await pool.query(
      `SELECT r.id FROM import_run r
       WHERE r.file_sha256 = $1 AND r.status = 'success'
         AND NOT EXISTS (
           SELECT 1 FROM import_run newer
           WHERE newer.status = 'success' AND newer.id > r.id
             AND newer.municipality_code = r.municipality_code AND newer.roll_year = r.roll_year)
       LIMIT 1`,
      [hash],
    );
    if (done.rowCount) {
      const message = `same content already imported (run ${done.rows[0].id})`;
      await pool.query(
        `INSERT INTO import_run (file_name, file_sha256, status, error_message, finished_at)
         VALUES ($1, $2, 'skipped', $3, now())`,
        [fileName, hash, message],
      );
      return { file: fileName, status: "skipped", ...counts, message };
    }
  }

  // 2. Open a run in the log. It is written outside the transaction, so it survives a rollback.
  const { rows } = await pool.query(
    "INSERT INTO import_run (file_name, file_sha256, status) VALUES ($1, $2, 'running') RETURNING id",
    [fileName, hash],
  );
  const runId: number = rows[0].id;
  let info: FileInfo | null = null;

  // 3. Everything for this file happens in ONE transaction: all or nothing.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let batch: ValidUnit[] = [];

    for await (const { header, unit } of readUnits(filePath)) {
      if (!info) {
        info = checkHeader(header); // bad header => whole file fails
        await client.query("INSERT INTO municipality (code) VALUES ($1) ON CONFLICT DO NOTHING", [
          info.municipalityCode,
        ]);
        // The file is the full truth for this municipality and roll year:
        // remove what we had before, then insert the new content.
        await client.query("DELETE FROM property_unit WHERE municipality_code = $1 AND roll_year = $2", [
          info.municipalityCode,
          info.rollYear,
        ]);
      }
      counts.read++;
      try {
        batch.push({ ...transformUnit(unit), raw: unit });
      } catch (err) {
        if (!(err instanceof FieldError)) throw err;
        counts.rejected++;
        await logRejectedUnit(runId, counts.read, unit, err);
      }
      if (batch.length >= BATCH_SIZE) {
        counts.loaded += await insertBatch(client, info, runId, batch);
        batch = [];
      }
    }
    if (!info) throw new Error("no property unit found in the file");
    counts.loaded += await insertBatch(client, info, runId, batch);

    if (counts.rejected / counts.read > MAX_REJECTED_RATIO) {
      throw new Error(
        `too many rejected units (${counts.rejected}/${counts.read}): the format may have changed`,
      );
    }
    await client.query("COMMIT");
    await finishRun(runId, "success", info, counts, null);
    return { file: fileName, status: "success", ...counts };
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    counts.loaded = 0; // rolled back: nothing from this file was kept
    await finishRun(runId, "failed", info, counts, message);
    return { file: fileName, status: "failed", ...counts, message };
  } finally {
    client.release();
  }
}

async function insertBatch(client: pg.PoolClient, info: FileInfo, runId: number, batch: ValidUnit[]) {
  if (batch.length === 0) return 0;

  const inserted = await insertRows(
    client,
    "property_unit",
    ["municipality_code", "roll_year", "import_run_id", "raw", ...PROPERTY_COLUMNS],
    batch.map(({ property, raw }) => [
      info.municipalityCode,
      info.rollYear,
      runId,
      JSON.stringify(raw),
      ...PROPERTY_COLUMNS.map((c) => property[c]),
    ]),
    "RETURNING id, matricule",
  );
  const idByMatricule = new Map(inserted.map((r) => [r.matricule, r.id]));

  await insertRows(
    client,
    "property_address",
    ["property_unit_id", ...ADDRESS_COLUMNS],
    batch.flatMap(({ property, addresses }) =>
      addresses.map((a) => [idByMatricule.get(property.matricule), ...ADDRESS_COLUMNS.map((c) => a[c])]),
    ),
  );
  return batch.length;
}

/** Multi-row INSERT. Split in chunks to stay under Postgres' limit of 65535 parameters. */
async function insertRows(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  returning = "",
) {
  const result: any[] = [];
  const chunkSize = Math.floor(60000 / columns.length);
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(
      (_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(", ")})`,
    );
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")} ${returning}`,
      chunk.flat(),
    );
    result.push(...res.rows);
  }
  return result;
}

async function logRejectedUnit(runId: number, position: number, unit: XmlNode, err: FieldError) {
  let matricule: string | null = null;
  try {
    matricule = buildMatricule(unit);
  } catch {
    // the matricule itself is invalid: keep null
  }
  await pool.query(
    "INSERT INTO import_error (import_run_id, unit_position, matricule, field, message) VALUES ($1, $2, $3, $4, $5)",
    [runId, position, matricule, err.field, err.message],
  );
}

async function finishRun(
  runId: number,
  status: "success" | "failed",
  info: FileInfo | null,
  counts: { read: number; loaded: number; rejected: number },
  message: string | null,
) {
  await pool.query(
    `UPDATE import_run SET status = $2, municipality_code = $3, roll_year = $4, xml_version = $5,
       units_read = $6, units_loaded = $7, units_rejected = $8, error_message = $9, finished_at = now()
     WHERE id = $1`,
    [runId, status, info?.municipalityCode, info?.rollYear, info?.xmlVersion,
     counts.read, counts.loaded, counts.rejected, message],
  );
}

function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
