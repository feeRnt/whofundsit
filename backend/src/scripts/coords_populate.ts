import "dotenv/config";
import { runPipeline } from "../services/pipeline.js";

// Coordinates only, no AI cost: `npm run coords_populate` geocodes pending
// entities (<= 100/run) via GEOCODE_BACKEND ("local" default, or "modal").
const summary = await runPipeline({ normalize: false });
console.log(summary);
