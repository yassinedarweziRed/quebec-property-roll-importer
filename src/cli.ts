// Usage: npm run import -- <file.xml | folder> [more...] [--index <indexRole.csv>] [--force]
//   --index  official index CSV, used to fill municipality names (optional)
//   --force  re-import even if the same file content was already imported
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./db.js";
import { parseIndex } from "./indexCsv.js";
import { importFile } from "./load.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const indexPos = args.indexOf("--index");
const indexFile = indexPos >= 0 ? args[indexPos + 1] : undefined;
const inputs = args.filter(
  (a, i) => a !== "--force" && !(indexPos >= 0 && (i === indexPos || i === indexPos + 1)),
);

if (inputs.length === 0 || (indexPos >= 0 && !indexFile)) {
  console.error("Usage: npm run import -- <file.xml | folder> [--index <indexRole.csv>] [--force]");
  process.exit(1);
}

const files = inputs.flatMap((input) =>
  statSync(input).isDirectory()
    ? readdirSync(input).filter((f) => f.toLowerCase().endsWith(".xml")).sort().map((f) => join(input, f))
    : [input],
);

if (indexFile) {
  const entries = [...parseIndex(readFileSync(indexFile, "utf8")).values()];
  await pool.query(
    `INSERT INTO municipality (code, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
    [entries.map((e) => e.code), entries.map((e) => e.name)],
  );
  console.log(`Municipality names loaded from index: ${entries.length}`);
}

let failed = 0;
for (const file of files) {
  const start = Date.now();
  const r = await importFile(file, force);
  if (r.status === "failed") failed++;
  console.log(
    `${r.status.toUpperCase().padEnd(7)} ${r.file}  read=${r.read} loaded=${r.loaded} rejected=${r.rejected}` +
      `  ${Date.now() - start} ms${r.message ? `  -> ${r.message}` : ""}`,
  );
}
await pool.end();
// Exit code 1 if any file failed: useful for automation (n8n, cron...) to detect a problem.
process.exitCode = failed ? 1 : 0;
