import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { extractSic, jsonEntries } from "../services/bulkLoad.js";

// One-shot backfill: `npm run industry:sync` writes Entity.industry from the
// local submissions archive (offline, no reseed) and normalizes legacy rows
// whose industry was smuggled inside `type` back to type "Company".
// Only numeric-CIK rows change; openalex/13f/lei rows keep their own types.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(here, "..", "..", "data", "submissions.zip");

const industries = new Map<number, string>();
for await (const { json } of jsonEntries(ZIP)) {
  const doc = json as { cik?: unknown; sic?: unknown; sicDescription?: unknown };
  const cik =
    typeof doc.cik === "string" ? Number(doc.cik) : (doc.cik as number);
  const industry = extractSic(doc);
  if (typeof cik === "number" && Number.isFinite(cik) && industry) {
    industries.set(cik, industry);
  }
}
console.log(`[industry] ${industries.size} filer industries from the archive`);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
try {
  const rows = await prisma.entity.findMany({
    select: { id: true, type: true, industry: true },
  });
  const changed = new Map<string, string>();
  for (const row of rows) {
    const m = /^(\d+):/.exec(row.id);
    if (!m) {
      continue;
    }
    const want = industries.get(Number(m[1]));
    if (!want) {
      continue;
    }
    if (row.industry !== want || row.type !== "Company") {
      changed.set(m[1], want);
    }
  }
  let updated = 0;
  for (const [cik, industry] of changed) {
    const r = await prisma.entity.updateMany({
      where: { id: { startsWith: `${cik}:` } },
      data: { industry, type: "Company" },
    });
    updated += r.count;
  }
  console.log({ scanned: rows.length, ciksChanged: changed.size, rowsUpdated: updated });
} finally {
  await prisma.$disconnect();
}
