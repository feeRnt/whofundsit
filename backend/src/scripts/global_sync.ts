import "dotenv/config";
import { runGlobalSync } from "../services/globalSync.js";

// One-shot runner: `npm run global:sync` loads international companies
// (Wikidata SPARQL -> GLEIF addresses) plus ownership arcs. Row ceilings:
// GLOBAL_LIMIT (default 500), GLOBAL_MAX_CHILDREN per parent (default 200).
const summary = await runGlobalSync();
console.log(summary);
