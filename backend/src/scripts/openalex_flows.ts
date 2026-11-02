import "dotenv/config";
import {
  recordSkippedFunder,
  resolveFunderIds,
  runOpenAlexFlows,
} from "../services/openalexFlows.js";

// One-shot runner: `npm run flows:openalex` loads grant arcs for every
// funder in OPENALEX_FUNDER_IDS (comma-separated F-URLs; default Colgate)
// into CapitalFlow.
const ids = resolveFunderIds();
const funders = [];
const skipped: string[] = [];
let works = 0;
let institutions = 0;
let flows = 0;
let costUsd = 0;
for (const [i, id] of ids.entries()) {
  console.log(`[flows] funder ${i + 1}/${ids.length}: ${id}`);
  let s;
  try {
    s = await runOpenAlexFlows(id);
  } catch (err) {
    // One bad funder (junk API payload, DB hiccup) must not kill the rest.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[flows] funder ${id} failed, continuing (${reason})`);
    recordSkippedFunder(id, reason);
    skipped.push(id);
    continue;
  }
  if (s.skipped) {
    skipped.push(id);
  }
  funders.push(s.funder);
  works += s.works;
  institutions += s.institutions;
  flows += s.flows;
  costUsd += s.costUsd;
}
console.log({ funders, skipped, works, institutions, flows, costUsd });
