import "dotenv/config";
import { runRegionalEsef } from "../services/regionalEsef.js";

// One-shot runner: `npm run regional:esef` attaches EU/UK financial facts
// (Assets preferred, Revenue fallback, native currency) to lei: entities.
// Row ceiling: ESEF_LIMIT (default 500). Needs `db:push` for the currency
// column first.
const summary = await runRegionalEsef();
console.log(summary);
