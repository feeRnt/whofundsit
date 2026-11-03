import "dotenv/config";
import { runVerify } from "../services/claimsVerify.js";

// Stochastic methodology audit: `npm run verify:claims` samples 25 rows
// per source/region/index/flow cell (VERIFY_SAMPLE, VERIFY_SEED) against
// live SEC + Nominatim and writes data/verification-report.json plus the
// committed prisma/seed-data/verification.json snapshot (trust badges).
const { cells, overall, reportPath, runs } = await runVerify();
const fmt = (v: number | null) => (v === null ? "n/a" : `${v}%`);
for (const c of cells) {
  console.log(
    `[verify] ${c.cell}: ${fmt(c.pctVerified)} verified (${c.passed}/${c.tested} passed, mean ${fmt(c.mean)})`,
  );
  for (const f of c.flags.slice(0, 3)) {
    console.log(`[verify]   flag: ${f}`);
    const d = c.diagnoses.find((x) => x.flag === f);
    if (d) {
      console.log(`[verify]   why: ${d.diagnosis}`);
    }
  }
}
console.log(
  `[verify] OVERALL: ${overall.pctVerified}% verified (${overall.passed}/${overall.tested} passed, mean ${overall.mean})`,
);
console.log(`[verify] report: ${reportPath}`);
console.log(`[verify] snapshot: rolling average over ${runs} run(s)`);
