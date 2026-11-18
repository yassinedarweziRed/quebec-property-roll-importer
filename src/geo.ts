// Bonus: load property locations from the official "rôle géoréférencé" GeoPackage.
// Usage: npm run geo -- <Role_2026.gpkg>
// Only the municipalities already imported are loaded (the file covers the whole province).
// Re-runnable: the points of these municipalities are replaced in one transaction.
import Database from "better-sqlite3";
import { basename } from "node:path";
import { pool } from "./db.js";
import { readPoint } from "./gpkg.js";

const BATCH_SIZE = 5000;
const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run geo -- <Role_2026.gpkg>");
  process.exit(1);
}

// A GeoPackage is a SQLite file. Open it read-only.
const gpkg = new Database(file, { readonly: true, fileMustExist: true });
const layer = gpkg
  .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features' AND table_name LIKE 'rol_unite_p%'")
  .pluck()
  .get() as string | undefined;
if (!layer) throw new Error("no 'rol_unite_p' layer found in this GeoPackage");

const codes: string[] = (await pool.query("SELECT DISTINCT municipality_code FROM property_unit")).rows.map(
  (r) => r.municipality_code,
);
if (codes.length === 0) {
  console.error("No roll imported yet: run `npm run import` first.");
  process.exit(1);
}

const start = Date.now();
const client = await pool.connect();
let loaded = 0;
try {
  await client.query("BEGIN");
  await client.query("DELETE FROM property_location WHERE municipality_code = ANY($1)", [codes]);

  const rows = gpkg
    .prepare(`SELECT code_mun, mat18, rejet, geom FROM "${layer}" WHERE code_mun IN (${codes.map(() => "?").join(",")})`)
    .iterate(...codes) as IterableIterator<{ code_mun: string; mat18: string; rejet: number | null; geom: Buffer }>;

  let batch: { code: string; mat18: string; x: number; y: number; quality: number | null }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    // Coordinates are NAD83 (EPSG:4269) in the file; stored as WGS 84 (EPSG:4326, the GPS standard).
    await client.query(
      `INSERT INTO property_location (municipality_code, matricule18, geom, location_quality_code, source_file)
       SELECT code, mat18, ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 4269), 4326), quality, $6
       FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::int[]) AS t(code, mat18, x, y, quality)`,
      [
        batch.map((b) => b.code),
        batch.map((b) => b.mat18),
        batch.map((b) => b.x),
        batch.map((b) => b.y),
        batch.map((b) => b.quality),
        basename(file),
      ],
    );
    loaded += batch.length;
    batch = [];
  };

  for (const row of rows) {
    const [x, y] = readPoint(row.geom);
    batch.push({ code: row.code_mun, mat18: row.mat18, x, y, quality: row.rejet });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  gpkg.close();
}

// Report: how many units of each municipality got a point.
const { rows: report } = await pool.query(
  `SELECT municipality_code, count(*) AS units, count(geom) AS located
   FROM property_unit_map GROUP BY 1 ORDER BY 1`,
);
console.log(`Loaded ${loaded} points from ${basename(file)} (layer ${layer}) in ${Date.now() - start} ms`);
for (const r of report) console.log(`  ${r.municipality_code}: ${r.located}/${r.units} units located`);
await pool.end();
