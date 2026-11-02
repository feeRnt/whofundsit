import "dotenv/config";
import fs from "node:fs";
import { formalizeAddresses } from "../services/addressFormalize.js";

// Standalone address formalization: file (one address per line) or stdin
// -> JSON Lines on stdout. Writes NOTHING else: no DB, no cache files,
// no dead-lines edits. Feed the output to Census/Nominatim yourself.
//   npx tsx src/scripts/formalize_addresses.ts addresses.txt > out.jsonl
const arg = process.argv[2];
const input = arg ? fs.readFileSync(arg, "utf8") : fs.readFileSync(0, "utf8");
const texts = input
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);
const results = await formalizeAddresses(texts);
for (const r of results) {
  console.log(JSON.stringify(r));
}
const failed = results.filter((r) => r.failureCause !== null).length;
console.error(`[formalize] ${results.length} addresses, ${failed} with failureCause`);
