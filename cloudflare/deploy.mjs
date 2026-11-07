// Loads cloudflare/.env_wrangler (dotenv not a dependency out here, so a
// minimal KEY=VALUE reader: strips `export `, quotes, and # comments),
// then runs `wrangler deploy` with values as --var flags (wrangler has no
// dotenv support). Run from anywhere: `node cloudflare/deploy.mjs`.
// ORIGIN is a public endpoint URL, not a secret — real secrets go via
// `wrangler secret put`, never this file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, ".env_wrangler");

let loaded = false;
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const clean = line.replace(/^\s*export\s+/, "").trim();
    if (!clean || clean.startsWith("#")) {
      continue;
    }
    const eq = clean.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = clean.slice(0, eq).trim();
    let val = clean.slice(eq + 1).trim();
    const hash = val.search(/(?<!\\)#/);
    if (hash !== -1 && !/^(['"]).*\1$/.test(val)) {
      val = val.slice(0, hash).trim();
    }
    const quoted = val.match(/^(['"])(.*)\1$/);
    if (quoted) {
      val = quoted[2];
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
  loaded = true;
}
const origin = process.env.ORIGIN;
console.error(
  `[deploy-edge] env ${loaded ? `loaded from ${envPath}` : `NOT loaded from ${envPath}`}; ` +
    `ORIGIN=${origin ? "set" : "NOT SET — copy .env_wrangler.example to .env_wrangler"}`,
);
if (!origin) {
  process.exit(2);
}
const result = spawnSync("npx", ["wrangler", "deploy", "--var", `ORIGIN:${origin}`], {
  stdio: "inherit",
  cwd: here,
});
process.exit(result.status ?? 1);
