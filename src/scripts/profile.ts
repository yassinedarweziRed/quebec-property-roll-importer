// Data profiling: for each file, how often each field is present.
// Usage: npm run profile -- data/raw/2026/RL01042_2026.xml [more files...]
import { basename } from "node:path";
import { readUnits, type XmlNode, type XmlValue } from "../parse.js";

// Adds every non-empty leaf path of a unit to `paths` (e.g. "RL0101.RL0101x.RL0101Gx").
function collectPaths(value: XmlValue, prefix: string, paths: Set<string>): void {
  if (typeof value === "string") {
    if (value !== "") paths.add(prefix);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectPaths(item, prefix, paths));
  } else {
    for (const [tag, child] of Object.entries(value)) {
      collectPaths(child, prefix ? `${prefix}.${tag}` : tag, paths);
    }
  }
}

for (const file of process.argv.slice(2)) {
  const start = Date.now();
  let peakMb = 0;
  let units = 0;
  let header = {};
  const presence = new Map<string, number>(); // path -> number of units having it

  for await (const item of readUnits(file)) {
    header = item.header;
    units++;
    const paths = new Set<string>();
    collectPaths(item.unit as XmlNode, "", paths);
    for (const p of paths) presence.set(p, (presence.get(p) ?? 0) + 1);
    if (units % 1000 === 0) peakMb = Math.max(peakMb, process.memoryUsage().rss / 1e6);
  }
  peakMb = Math.max(peakMb, process.memoryUsage().rss / 1e6);

  console.log(`\n=== ${basename(file)} ${JSON.stringify(header)}`);
  console.log(`units: ${units} | time: ${Date.now() - start} ms | peak memory: ${peakMb.toFixed(0)} MB`);
  for (const [path, count] of [...presence].sort()) {
    console.log(`${path.padEnd(32)} ${String(count).padStart(7)}  ${((100 * count) / units).toFixed(1)}%`);
  }
}
