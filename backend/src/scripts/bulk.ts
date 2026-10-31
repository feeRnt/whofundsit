import "dotenv/config";
import { runBulkLoad } from "../services/bulkLoad";

// One-shot runner: `npm run bulk` downloads the SEC nightly ZIPs once (skipped
// when present) and loads the last BULK_YEARS of facts. Good wifi required.
const summary = await runBulkLoad();
console.log(summary);
