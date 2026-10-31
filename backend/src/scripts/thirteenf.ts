import "dotenv/config";
import { runThirteenF } from "../services/thirteenF.js";

// One-shot runner: `npm run flows:13f` loads dollar-denominated holdings arcs
// for BlackRock, Vanguard, and Berkshire into CapitalFlow.
const summary = await runThirteenF();
console.log(summary);
