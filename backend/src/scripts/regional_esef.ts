import "dotenv/config";
import { runRegionalEsef } from "../services/regionalEsef.js";

// One-shot runner: `npm run regional:esef` attaches EU/UK financial facts
// (Assets preferred, Revenue fallback, native currency) to lei: entities.
// Row ceiling: ESEF_LIMIT (default 500). Needs `db:push` for the currency
// column first.
const summary = await runRegionalEsef();
// Full 500-line skip lists flood the terminal; the reasons that matter
// (updates, 429s) already logged above. Print counts + a sample.
console.log({
  considered: summary.considered,
  updated: summary.updated,
  skippedCount: summary.skipped.length,
  skippedSample: summary.skipped.slice(0, 10),
});
