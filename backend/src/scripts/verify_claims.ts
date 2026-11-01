import "dotenv/config";
import { runVerify } from "../services/claimsVerify.js";

// Stochastic methodology audit: `npm run verify:claims` samples 25 rows
// per source/region/index/flow cell (VERIFY_SAMPLE, VERIFY_SEED) against
// live SEC + Nominatim and writes data/verification-report.json.
const { cells, overall, reportPath } = await runVerify();
for (const c of cells) {
  console.log(
    `[verify] ${c.cell}: ${c.pctVerified}% verified (${c.passed}/${c.tested} passed, mean ${c.mean})`,
  );
  for (const f of c.flags.slice(0, 3)) {
    console.log(`[verify]   flag: ${f}`);
  }
}
console.log(
  `[verify] OVERALL: ${overall.pctVerified}% verified (${overall.passed}/${overall.tested} passed, mean ${overall.mean})`,
);
console.log(`[verify] report: ${reportPath}`);
