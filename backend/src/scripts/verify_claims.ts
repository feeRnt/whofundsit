import "dotenv/config";
import { clearHistory, runVerify } from "../services/claimsVerify.js";

// Stochastic methodology audit: `npm run verify:claims` rolls fixed-seed
// members per source/region/index/flow cell against live SEC + Nominatim
// and writes
// data/verification-report.json plus the committed prisma/seed-data/
// verification.json snapshot (trust badges: rolling per-arm averages).
// `--clean` wipes the accumulated history first (averages restart here).
if (process.argv.includes("--clean")) {
  console.log(
    clearHistory()
      ? "[verify] history cleared: averages restart from this run"
      : "[verify] no history file: nothing to clear",
  );
}
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
