import "dotenv/config";
import { runRegionalTwse } from "../services/regionalTwse.js";

// One-shot runner: `npm run regional:twse` attaches Taiwan balance-sheet
// Assets (native TWD) to lei: entities via TWSE OpenAPI + a Wikidata
// code->LEI map. Row ceiling: TWSE_LIMIT (default 2000). Needs `db:push`
// for the currency column first.
const summary = await runRegionalTwse();
console.log(summary);
