import "dotenv/config";
import { runGlobalIndustry } from "../services/globalSync.js";

// One-shot runner: `npm run industry:global` backfills Entity.industry on
// lei: rows from Wikidata P452 (batched VALUES queries, cached, gated).
// Runs after `sync:global`: its input is sync:global's own output rows, so
// no discovery query is ever re-run. Row ceiling: INDUSTRY_GLOBAL_LIMIT
// (0 = all lei: rows lacking industry).
const summary = await runGlobalIndustry();
console.log(summary);
