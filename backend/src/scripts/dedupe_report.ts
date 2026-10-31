import "dotenv/config";
import { runDedupeReport } from "../services/dedupe.js";

// Read-only runner: `npm run dedupe:report` prints candidate duplicate
// groups for human review. Merging stays explicit per group:
// `npm run merge -- <keepId> <dropId>`.
await runDedupeReport();
