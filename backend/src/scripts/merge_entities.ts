import "dotenv/config";
import { runMerge } from "../services/entityMerge.js";

// One-shot runner: `npm run merge -- <keepId> <dropId>` folds a duplicate
// entity into its canonical row (repoints flows, drops self-loops).
// Colgate: npm run merge -- openalex:F4320307808 openalex:I4210135004
const [keepId, dropId] = process.argv.slice(2);
if (!keepId || !dropId) {
  console.error("usage: npm run merge -- <keepId> <dropId>");
  process.exit(2);
}
const summary = await runMerge(keepId, dropId);
console.log(summary);
