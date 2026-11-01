import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveIsinTickers } from "../services/openfigi.js";
import { sparqlCompanies } from "../services/globalSync.js";

// Ticker backfill for global (lei:*) rows: Wikidata ISIN -> OpenFIGI primary
// listing -> tickers[]/exchanges[]. ISINs are ephemeral lookup keys (US ISINs
// embed a CUSIP): resolved from cached SPARQL per run, mapped through the
// gitignored isin-map cache, never stored or committed.
// Run with at least the GLOBAL_LIMIT the rows were synced with, or some
// companies won't match. Idempotent: reruns only touch still-untickered rows.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const limit = Math.max(1, Number(process.env.GLOBAL_LIMIT ?? 500));
  const companies = await sparqlCompanies(limit);
  const isinByLei = new Map(companies.map((c) => [c.lei, c.isin]));
  console.log(`[tickers] ${companies.length} companies with ISINs`);

  const rows = await prisma.entity.findMany({
    where: { id: { startsWith: "lei:" }, tickers: { isEmpty: true } },
    select: { id: true },
  });
  const jobs = rows
    .map((r) => ({ id: r.id, isin: isinByLei.get(r.id.slice("lei:".length)) }))
    .filter((j): j is { id: string; isin: string } => !!j.isin);
  console.log(
    `[tickers] ${rows.length} untickered lei rows, ${jobs.length} with ISINs`,
  );

  const map = await resolveIsinTickers(jobs.map((j) => j.isin));
  let updated = 0;
  for (const j of jobs) {
    const hit = map.get(j.isin);
    if (!hit) {
      continue;
    }
    await prisma.entity.update({
      where: { id: j.id },
      data: { tickers: [hit.ticker], exchanges: [hit.exchCode] },
    });
    updated += 1;
  }
  console.log({ considered: jobs.length, updated });
} finally {
  await prisma.$disconnect();
}
