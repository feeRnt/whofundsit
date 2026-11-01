import "dotenv/config";
import {
  resolveFunderIds,
  runOpenAlexFlows,
} from "../services/openalexFlows.js";

// One-shot runner: `npm run flows:openalex` loads grant arcs for every
// funder in OPENALEX_FUNDER_IDS (comma-separated F-URLs; default Colgate)
// into CapitalFlow.
const ids = resolveFunderIds();
const funders = [];
let works = 0;
let institutions = 0;
let flows = 0;
let costUsd = 0;
for (const [i, id] of ids.entries()) {
  console.log(`[flows] funder ${i + 1}/${ids.length}: ${id}`);
  const s = await runOpenAlexFlows(id);
  funders.push(s.funder);
  works += s.works;
  institutions += s.institutions;
  flows += s.flows;
  costUsd += s.costUsd;
}
console.log({ funders, works, institutions, flows, costUsd });
