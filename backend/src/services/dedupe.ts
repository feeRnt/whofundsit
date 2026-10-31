import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Human-in-the-loop duplicate review: groups entities whose names collapse
// to the same key AND come from distinct id groups (same-CIK concept rows
// like 1000045:Assets/1000045:Debt never group). Report-only — merging
// stays an explicit `npm run merge -- keep drop` per group.

export interface DedupeRow {
  id: string;
  name: string;
  type: string;
  source: string;
  tickers: string[];
  lat: number;
  lng: number;
  businessAddress: string | null;
}

// Trailing legal-entity noise stripped so "X CORP" meets "X (United States)".
const SUFFIX =
  /\b(COMPANY|CORPORATION|CORP|INCORPORATED|INC|LLC|LTD|LIMITED|PLC|HOLDINGS|HOLDING|GROUP|CO|TRUST|LP|LLP|NV|SA|AG|SE|SPA)\.?$/;

export function dedupeKey(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SUFFIX, "")
    .replace(/[^A-Z0-9]/g, "");
}

// Same-company rows share a numeric CIK prefix; anything else (openalex:…,
// 13f:…) groups by full id so distinct rows never collapse silently.
export function idGroup(id: string): string {
  const first = id.split(":")[0] ?? "";
  return /^\d+$/.test(first) ? first : id;
}

export function groupDuplicates(rows: DedupeRow[]): DedupeRow[][] {
  const byKey = new Map<string, DedupeRow[]>();
  for (const row of rows) {
    const key = dedupeKey(row.name);
    if (!key) {
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const groups: DedupeRow[][] = [];
  for (const members of byKey.values()) {
    if (new Set(members.map((m) => idGroup(m.id))).size > 1) {
      groups.push(members.sort((a, b) => a.id.localeCompare(b.id)));
    }
  }
  return groups.sort((a, b) => b.length - a.length);
}

export async function runDedupeReport(): Promise<{
  groups: number;
  rows: number;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const rows = await prisma.entity.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        source: true,
        tickers: true,
        lat: true,
        lng: true,
        businessAddress: true,
      },
      orderBy: { id: "asc" },
    });
    const groups = groupDuplicates(rows);
    for (const g of groups) {
      console.log(`\n## ${dedupeKey(g[0].name)} (${g.length} rows)`);
      for (const m of g) {
        console.log(
          `  ${m.id} | ${m.name} | ${m.type} | ${m.source} | [${m.tickers.join(",")}] | ${m.lat},${m.lng} | ${m.businessAddress ?? "—"}`,
        );
      }
      console.log(`  merge: npm run merge -- ${g[0].id} <dropId>`);
    }
    console.log(`\n${groups.length} candidate groups in ${rows.length} rows`);
    return { groups: groups.length, rows: rows.length };
  } finally {
    await prisma.$disconnect();
  }
}
