import "dotenv/config";
import { ingestSecFrames } from "../services/secIngestion.js";

// One-shot runner: `npm run ingest` fetches the SEC frame and upserts <= 500 rows.
// DATABASE_URL comes from backend/.env (never printed or logged).
const summary = await ingestSecFrames();
console.log(summary);
