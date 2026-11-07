// Loads backend/.env, then runs `modal deploy <worker>` with that env, so
// the Python workers (which never read dotenv themselves) see MODAL_*
// values from the same file as everything else.
// Run from anywhere: npm run setup:modal-<name>-worker --prefix backend
// (the .env path is anchored to this file, not the shell's cwd — dotenv
// fails silently when the file isn't found, which used to fall back to
// the default secret name with no warning).
import "dotenv/config";
import dotenv from "dotenv";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
const loaded = dotenv.config({ path: envPath });
// Never print values: only whether the deploy-relevant name is present.
const secretName = process.env.MODAL_HF_SECRET_NAME;
console.error(
  `[modal-deploy] env ${loaded.error ? `NOT loaded from ${envPath}` : `loaded from ${envPath}`}; ` +
    `MODAL_HF_SECRET_NAME=${secretName ? "set" : "NOT SET, worker falls back to huggingface-secret"}`,
);

const [, , worker] = process.argv;
if (!worker || worker.includes("..") || worker.includes("/")) {
  console.error("usage: node scripts/modal-deploy.mjs <worker.py>");
  process.exit(2);
}
const result = spawnSync("modal", ["deploy", worker], { stdio: "inherit" });
process.exit(result.status ?? 1);
