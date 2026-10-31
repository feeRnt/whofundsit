import "dotenv/config";
import { runPipeline } from "../services/pipeline.js";

// One-shot runner: `npm run pipeline` geocodes pending entities (<= 100/run)
// and normalizes complex names via Modal when MODAL_WEBHOOK_URL is set.
const summary = await runPipeline();
console.log(summary);
