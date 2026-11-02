import "dotenv/config";
import { runGlobalCoords } from "../services/globalSync.js";

// One-shot runner: `npm run coords:global` backfills lat/lng on unplaced
// lei: rows from Wikidata (direct P625, else the HQ-hop P159/P625).
// Batched VALUES queries, cached, gated — same shape as industry:global.
// Run BEFORE coords:populate: every row placed here skips Nominatim.
// Row ceiling: COORDS_GLOBAL_LIMIT (0 = all unplaced lei: rows).
const summary = await runGlobalCoords();
console.log(summary);
