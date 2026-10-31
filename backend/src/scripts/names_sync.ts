import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { jsonEntries } from "../services/bulkLoad.js";

// One-shot backfill: `npm run names:sync` rewrites Entity.name to the legal
// filer name from the local submissions archive (offline, no reseed).
// Only numeric-CIK rows change; openalex/13f rows keep their own names.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(here, "..", "..", "data", "submissions.zip");

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
  for (const row of rows) {
    const m = /^(\d+):/.exec(row.id);
    if (!m) {
      continue;
    }
    const want = names.get(Number(m[1]));
    if (want && want !== row.name) {
      changed.set(Number(m[1]), want);
    }
  }
  let updated = 0;
  for (const [cik, name] of changed) {
    const r = await prisma.entity.updateMany({
      where: { id: { startsWith: `${cik}:` } },
      data: { name },
    });
    updated += r.count;
  }
  console.log({
    scanned: rows.length,
    ciksChanged: changed.size,
    rowsUpdated: updated,
  });
} finally {
  await prisma.$disconnect();
}
