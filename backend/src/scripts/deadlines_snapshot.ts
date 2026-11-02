import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Maintainer tool: `npm run deadlines:snapshot` copies the local dead-lines
// accumulation into the committed seed (src/data/dead-lines.json) so fresh
// clones skip known-junk addresses with zero API calls. Commit the seed
// afterwards. Safe to publish: our own address strings + outcome facts,
// no Nominatim response data.
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheFile = path.join(
  here,
  "..",
  "..",
  "data",
  "cache",
  "geo",
  "dead-lines.json",
);
const seedFile = path.join(here, "..", "data", "dead-lines.json");
if (!fs.existsSync(cacheFile)) {
  throw new Error("no local dead-lines yet — run coords:populate first");
}
const lines = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as unknown;
if (!Array.isArray(lines)) {
  throw new Error("local dead-lines.json is not an array");
}
const sorted = [...new Set(lines.filter((t): t is string => typeof t === "string"))].sort();
fs.writeFileSync(seedFile, JSON.stringify(sorted, null, 2));
console.log({ lines: sorted.length, seedFile });
