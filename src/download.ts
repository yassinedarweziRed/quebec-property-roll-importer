// Bonus: download roll files from the official index.
// Usage: npm run download -- <municipality code> [more codes...] [--year 2026]
// Files go to data/raw/<year>/; then run `npm run import -- data/raw/<year>`.
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { indexUrl, normalizeCode, parseIndex } from "./indexCsv.js";

const args = process.argv.slice(2);
const yearPos = args.indexOf("--year");
const year = yearPos >= 0 ? Number(args[yearPos + 1]) : 2026;
const codes = args.filter((_, i) => !(yearPos >= 0 && (i === yearPos || i === yearPos + 1)));

if (codes.length === 0 || !Number.isInteger(year)) {
  console.error("Usage: npm run download -- <municipality code> [more codes...] [--year 2026]");
  process.exit(1);
}

// 1. The index gives the link of each municipality's file.
await mkdir(join("data", "raw"), { recursive: true });
const indexFile = join("data", "raw", `indexRole${year}.csv`);
try {
  await download(indexUrl(year), indexFile);
} catch (err) {
  console.error(`FAILED  index ${year}  -> ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const index = parseIndex(await readFile(indexFile, "utf8"));
console.log(`Index ${year}: ${index.size} municipalities`);
const outDir = join("data", "raw", String(year));
await mkdir(outDir, { recursive: true });

// 2. Download each requested file. One failure does not stop the others.
let failed = 0;
for (const input of codes) {
  const entry = index.get(normalizeCode(input));
  if (!entry) {
    failed++;
    console.log(`FAILED  ${input}  -> code not found in index ${year}`);
    continue;
  }
  const target = join(outDir, basename(new URL(entry.url).pathname));
  const start = Date.now();
  try {
    const bytes = await download(entry.url, target);
    console.log(`OK      ${basename(target)}  ${entry.name}  ${(bytes / 1e6).toFixed(1)} MB  ${Date.now() - start} ms`);
  } catch (err) {
    failed++;
    console.log(`FAILED  ${basename(target)}  -> ${err instanceof Error ? err.message : err}`);
  }
}
// Exit code 1 if any file failed: same rule as the import, so a scheduler can detect it.
process.exitCode = failed ? 1 : 0;

/**
 * Streams a URL to a file. Writes to "<file>.part" and renames only when complete,
 * so a cut connection never leaves a half-written file behind.
 */
async function download(url: string, target: string): Promise<number> {
  const part = `${target}.part`;
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(part));
    await rename(part, target);
    return (await stat(target)).size;
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
