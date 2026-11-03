import "dotenv/config";
import { runPipeline } from "../services/pipeline.js";

// One-shot runner: `npm run pipeline` geocodes pending entities (<= 100/run).
const summary = await runPipeline();
console.log(summary);
