import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey } from "./httpCache.js";

// International backbone: Wikidata SPARQL lists listed companies worldwide
// (ISIN + LEI + exchange + HQ, CC0, no key), then GLEIF resolves each LEI to
// a legal HQ address (CC0, no key) and direct children (full records with
// addresses — ownership arcs need no per-country filings).
// Row ceilings: GLOBAL_LIMIT companies (default 500), GLOBAL_MAX_CHILDREN
// direct children per parent (default 200). Everything file-cached.

const GLEIF = "https://api.gleif.org/api/v1";
const SPARQL = "https://query.wikidata.org/sparql";
const UA =
  process.env.WIKIDATA_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";

export interface GlobalCompany {
  name: string;
  isin: string;
  lei: string;
  exchanges: string[];
  hq: string | null;
}

export function buildCompanyQuery(limit: number): string {
  return `SELECT ?companyLabel ?isin ?lei ?exchangeLabel ?hqLabel WHERE {
  ?company wdt:P946 ?isin; wdt:P1278 ?lei; wdt:P414 ?exchange.
  OPTIONAL { ?company wdt:P159 ?hq. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
}

interface SparqlBinding {
  companyLabel?: { value?: unknown };
  isin?: { value?: unknown };
  lei?: { value?: unknown };
  exchangeLabel?: { value?: unknown };
  hqLabel?: { value?: unknown };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// One row per (company, exchange); collapse to one company per LEI.
export function parseCompanyRows(doc: {
  results?: { bindings?: SparqlBinding[] };
}): GlobalCompany[] {
  const byLei = new Map<string, GlobalCompany>();
  for (const b of doc.results?.bindings ?? []) {
    const lei = str(b.lei?.value);
    const isin = str(b.isin?.value);
    const name = str(b.companyLabel?.value);
    if (!lei || !isin || !name) {
      continue;
    }
    const got = byLei.get(lei) ?? {
      name,
      isin,
      lei,
      exchanges: [],
      hq: null,
    };
    const ex = str(b.exchangeLabel?.value);
    if (ex && !got.exchanges.includes(ex)) {
      got.exchanges.push(ex);
    }
    got.hq = got.hq ?? str(b.hqLabel?.value);
    byLei.set(lei, got);
  }
  return [...byLei.values()];
}

export interface GleifAddress {
  joined: string;
  country: string | null;
}

// GLEIF entity shape (verified live): attributes.entity.{legalName,
// headquartersAddress|legalAddress{addressLines,city,postalCode,country}}.
export function parseGleifAddress(entity: {
  headquartersAddress?: unknown;
  legalAddress?: unknown;
  [key: string]: unknown;
}): GleifAddress | null {
  const addr = (entity.headquartersAddress ?? entity.legalAddress) as {
    addressLines?: unknown;
    city?: unknown;
    postalCode?: unknown;
    country?: unknown;
  } | null;
  if (!addr) {
    return null;
  }
  const parts = [
    ...(Array.isArray(addr.addressLines)
      ? addr.addressLines.filter(
          (l): l is string => typeof l === "string" && l.length > 0,
        )
      : []),
    [str(addr.postalCode), str(addr.city)].filter(Boolean).join(" "),
    str(addr.country),
  ].filter((p): p is string => !!p && p.length > 0);
  if (parts.length === 0) {
    return null;
  }
  return { joined: parts.join(", "), country: str(addr.country) };
}

export interface GleifChild {
  lei: string;
  name: string;
  address: GleifAddress | null;
}

export function parseGleifChildren(doc: {
  data?: {
    id?: unknown;
    attributes?: { entity?: { legalName?: { name?: unknown } } & Record<
      string,
      unknown
    > };
  }[];
}): GleifChild[] {
  const out: GleifChild[] = [];
  for (const rec of doc.data ?? []) {
    const lei = str(rec.id);
    const entity = rec.attributes?.entity;
    const name = str(entity?.legalName?.name);
    if (!lei || !entity || !name) {
      continue;
    }
    out.push({ lei, name, address: parseGleifAddress(entity) });
  }
  return out;
}

async function sparqlCompanies(limit: number): Promise<GlobalCompany[]> {
  const query = buildCompanyQuery(limit);
  const doc = await cachedJson<{ results?: { bindings?: SparqlBinding[] } }>(
    `global/wikidata-companies-${cacheKey(query)}.json`,
    async () =>
      (
        await axios.get(SPARQL, {
          params: { format: "json", query },
          headers: { "User-Agent": UA },
          timeout: 120000,
        })
      ).data,
  );
  return parseCompanyRows(doc);
}

export async function gleifEntity(lei: string): Promise<{
  name: string;
  address: GleifAddress | null;
} | null> {
  const doc = await cachedJson<{
    data?: {
      attributes?: { entity?: { legalName?: { name?: unknown } } & Record<
        string,
        unknown
      > };
    };
  }>(`global/gleif/${lei}.json`, async () => {
    await new Promise((r) => setTimeout(r, 100)); // polite, cached anyway
    return (
      await axios.get(`${GLEIF}/lei-records/${lei}`, {
        params: { "fields[lei-records]": "entity" },
        headers: { "User-Agent": UA },
        timeout: 60000,
      })
    ).data;
  });
  const entity = doc.data?.attributes?.entity;
  const name = str(entity?.legalName?.name);
  if (!entity || !name) {
    return null;
  }
  return { name, address: parseGleifAddress(entity) };
}

async function gleifChildren(
  lei: string,
  maxChildren: number,
): Promise<GleifChild[]> {
  const out: GleifChild[] = [];
  let page = 1;
  for (;;) {
    const doc = await cachedJson<{
      data?: {
        id?: unknown;
        attributes?: { entity?: { legalName?: { name?: unknown } } & Record<
          string,
          unknown
        > };
      }[];
      meta?: { pagination?: { lastPage?: number } };
    }>(`global/gleif-children/${lei}-p${page}.json`, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return (
        await axios.get(`${GLEIF}/lei-records/${lei}/direct-children`, {
          params: {
            "page[size]": 100,
            "page[number]": page,
            "fields[lei-records]": "entity",
          },
          headers: { "User-Agent": UA },
          timeout: 60000,
        })
      ).data;
    });
    out.push(...parseGleifChildren(doc));
    const lastPage = doc.meta?.pagination?.lastPage ?? 1;
    if (page >= lastPage || out.length >= maxChildren) {
      break;
    }
    page += 1;
  }
  return out.slice(0, maxChildren);
}

export async function runGlobalSync(): Promise<{
  companies: number;
  entities: number;
  flows: number;
  skippedNoAddress: string[];
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const limit = Math.max(1, Number(process.env.GLOBAL_LIMIT ?? 500));
  const maxChildren = Math.max(
    0,
    Number(process.env.GLOBAL_MAX_CHILDREN ?? 200),
  );
  const companies = await sparqlCompanies(limit);
  console.log(`[global] ${companies.length} companies from Wikidata`);

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const skippedNoAddress: string[] = [];
  let entities = 0;
  let flows = 0;
  try {
    for (const c of companies) {
      const g = await gleifEntity(c.lei);
      if (!g?.address) {
        skippedNoAddress.push(`${c.name} (${c.lei})`);
        continue;
      }
      const id = `lei:${c.lei}`;
      await prisma.entity.upsert({
        where: { id },
        create: {
          id,
          name: g.name,
          type: "Company",
          lat: 0,
          lng: 0,
          fundsVolume: 0,
          rawAddressText: g.address.country ?? c.hq ?? "—",
          businessAddress: g.address.joined,
          tickers: [],
          exchanges: c.exchanges,
          source: "global",
        },
        update: {
          name: g.name,
          businessAddress: g.address.joined,
          exchanges: c.exchanges,
          source: "global",
        },
      });
      entities += 1;
      for (const child of await gleifChildren(c.lei, maxChildren)) {
        const childId = `lei:${child.lei}`;
        await prisma.entity.upsert({
          where: { id: childId },
          create: {
            id: childId,
            name: child.name,
            type: "Company",
            lat: 0,
            lng: 0,
            fundsVolume: 0,
            rawAddressText: child.address?.country ?? "—",
            businessAddress: child.address?.joined ?? null,
            tickers: [],
            exchanges: [],
            source: "global",
          },
          update: {
            name: child.name,
            businessAddress: child.address?.joined ?? null,
            source: "global",
          },
        });
        entities += 1;
        await prisma.capitalFlow.upsert({
          where: { id: `global:${c.lei}:${child.lei}` },
          create: {
            id: `global:${c.lei}:${child.lei}`,
            sourceEntityId: id,
            targetEntityId: childId,
            amount: 0, // stake undisclosed by GLEIF
            flowType: "ownership",
          },
          update: {
            sourceEntityId: id,
            targetEntityId: childId,
            amount: 0,
            flowType: "ownership",
          },
        });
        flows += 1;
      }
    }
    return {
      companies: companies.length,
      entities,
      flows,
      skippedNoAddress,
    };
  } finally {
    await prisma.$disconnect();
  }
}
