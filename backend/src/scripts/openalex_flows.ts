import "dotenv/config";
import { runOpenAlexFlows } from "../services/openalexFlows";

// One-shot runner: `npm run flows:openalex` loads grant arcs for one funder
// (OPENALEX_FUNDER_ID, default Colgate-Palmolive) into CapitalFlow.
const summary = await runOpenAlexFlows();
console.log(summary);
