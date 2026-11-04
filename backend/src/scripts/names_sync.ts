import "dotenv/config";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { jsonEntries } from "../services/bulkLoad.js";
import {
  loadSkipped,
  partitionChanged,
  saveSkipped,
  type SkippedMap,
} from "../services/namesCache.js";

// One-shot backfill: `npm run names:sync` rewrites Entity.name to the legal
// filer name from the local submissions archive (offline, no reseed).
// Only numeric-CIK rows change; openalex/13f rows keep their own names.
// Nothing writes before an interactive yes: the scan is read-only, the log
// shows exactly how many CIKs and rows would change, and the prompt defaults
// to no. `--yes` approves non-interactively (overnight chain); without a TTY
// and without --yes the script aborts instead of guessing. `--list` prints
// every affected CIK as old -> legal name (read-only detail, no prompt skip).
// Declined CIKs are remembered in gitignored data/cache/names-sync.json, so
// repeat runs stop re-asking; `--cached` lists those past skips for review
// (and applies them on yes), `--cached --yes` applies them directly.
async function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(here, "..", "..", "data", "submissions.zip");
const CACHE = path.join(here, "..", "..", "data", "cache", "names-sync.json");

const names = new Map<number, string>();
for await (const { json } of jsonEntries(ZIP)) {
  const doc = json as { cik?: unknown; name?: unknown };
  const cik =
    typeof doc.cik === "string" ? Number(doc.cik) : (doc.cik as number);
  if (
    typeof cik === "number" &&
    Number.isFinite(cik) &&
    typeof doc.name === "string" &&
    doc.name.length > 0
  ) {
    names.set(cik, doc.name);
  }
}
console.log(`[names] ${names.size} filer names from the archive`);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
try {
  const rows = await prisma.entity.findMany({
    select: { id: true, name: true },
  });
  const changed = new Map<number, string>();
  const current = new Map<number, string>();
  for (const row of rows) {
    const m = /^(\d+):/.exec(row.id);
    if (!m) {
      continue;
    }
    const cik = Number(m[1]);
    if (!current.has(cik)) {
      current.set(cik, row.name);
    }
    const want = names.get(cik);
    if (want && want !== row.name) {
      changed.set(cik, want);
    }
  }
  const args = process.argv.slice(2);
  const cachedMode = args.includes("--cached");
  const skipped: SkippedMap = loadSkipped(CACHE);
  const { fresh, revisit, stale } = partitionChanged(changed, current, skipped);
  const targets = cachedMode
    ? new Map(revisit.map((r) => [r.cik, r.want]))
    : fresh;
  // Affected rows, counted from the same read (no second query).
  const prefixes = new Set([...targets.keys()].map((cik) => `${cik}:`));
  let affected = 0;
  for (const row of rows) {
    const m = /^(\d+):/.exec(row.id);
    if (m && prefixes.has(`${m[1]}:`)) {
      affected += 1;
    }
  }
  console.log({
    scanned: rows.length,
    ciksChanged: changed.size,
    rowsAffected: affected,
    skippedBefore: revisit.length,
  });
  if (args.includes("--list")) {
    // Dry-run detail: one old -> legal line per CIK, sorted. Read-only.
    if (cachedMode) {
      for (const r of [...revisit].sort((a, b) => a.cik - b.cik)) {
        console.log(`[names] ${r.cik}: ${r.old} -> ${r.want}`);
      }
    } else {
      const skippedCiks = new Set(revisit.map((r) => r.cik));
      for (const [cik, want] of [...changed.entries()].sort((a, b) => a[0] - b[0])) {
        const mark = skippedCiks.has(cik) ? " (skipped before)" : "";
        console.log(`[names] ${cik}: ${current.get(cik)} -> ${want}${mark}`);
      }
    }
  }
  if (!cachedMode && revisit.length > 0) {
    console.log(
      `[names] ${revisit.length} previously-skipped (re-run with --cached to review)`,
    );
  }
  let approved = args.includes("--yes");
  if (!approved && targets.size > 0) {
    if (!process.stdin.isTTY) {
      console.log("[names] non-interactive without --yes: no rows written");
    } else {
      const question = cachedMode
        ? `[names] apply ${targets.size} previously-skipped renames (${affected} rows)? [y/N] `
        : `[names] rename ${affected} rows across ${targets.size} CIKs to legal filer names? [y/N] `;
      approved = await askConfirm(question);
      if (!approved) {
        console.log("[names] aborted: no rows written");
        // Remember the decline so the next run stops re-asking.
        const at = new Date().toISOString();
        for (const [cik, want] of targets) {
          skipped[String(cik)] = {
            old: current.get(cik) ?? "",
            want,
            at,
          };
        }
        for (const key of stale) {
          delete skipped[key];
        }
        saveSkipped(CACHE, skipped);
      }
    }
  }
  let updated = 0;
  if (approved) {
    for (const [cik, name] of targets) {
      const r = await prisma.entity.updateMany({
        where: { id: { startsWith: `${cik}:` } },
        data: { name },
      });
      updated += r.count;
    }
    if (cachedMode && updated > 0) {
      for (const cik of targets.keys()) {
        delete skipped[String(cik)];
      }
      for (const key of stale) {
        delete skipped[key];
      }
      saveSkipped(CACHE, skipped);
    }
  }
  console.log({ rowsUpdated: updated });
} finally {
  await prisma.$disconnect();
}
