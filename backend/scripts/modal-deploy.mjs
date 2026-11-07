// Loads backend/.env, then runs `modal deploy <worker>` with that env, so
// the Python workers (which never read dotenv themselves) see MODAL_*
// values from the same file as everything else.
// Run from whofundsit/backend: npm run setup:modal-<name>-worker
import "dotenv/config";
import { spawnSync } from "node:child_process";

const [, , worker] = process.argv;
if (!worker || worker.includes("..") || worker.includes("/")) {
  console.error("usage: node scripts/modal-deploy.mjs <worker.py>");
  process.exit(2);
}
const result = spawnSync("modal", ["deploy", worker], { stdio: "inherit" });
process.exit(result.status ?? 1);
