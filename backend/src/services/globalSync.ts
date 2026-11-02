import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey, apiLog, userAgentFromEnv } from "./httpCache.js";
import { createRateLimiter } from "./pipeline.js";

// International backbone: Wikidata SPARQL lists listed companies worldwide
// (ISIN + LEI + exchange + HQ, CC0, no key), then GLEIF resolves each LEI to
// a legal HQ address (CC0, no key) and direct children (full records with
// addresses — ownership arcs need no per-country filings). Companies come in
// per-region quotas (a single LIMIT 500 came back US-heavy and near-empty
// for Asia); the US is excluded everywhere because SEC data already covers
// it. Within each region, sitelink count surfaces the biggest companies.
// Row ceilings: GLOBAL_LIMIT companies total (default 500, split by quota),
// GLOBAL_MAX_CHILDREN direct children per parent (default 50). Cached.

const GLEIF = "https://api.gleif.org/api/v1";
const SPARQL = "https://query.wikidata.org/sparql";
const UA = userAgentFromEnv("WIKIDATA_USER_AGENT");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ground-rule-2 gates: every outbound call in this module goes through one.
// Wikidata requires a descriptive UA + reasonable load (User-Agent policy,
// no req/s number): 5s is our conservative courtesy posture. GLEIF publishes
// 60 req/min/user (official API docs): 1100ms paces ~55/min with margin.
// Promise-chained: they hold under concurrent callers, where bare sleeps
// would not. The SPARQL gate coincides with existing pauses; the GLEIF gate
// sets the pace (≈10x slower than the old 100ms sleep — the price of the
// published cap; cached reruns are unaffected).
export const SPARQL_MIN_INTERVAL_MS = 5000;
export const GLEIF_MIN_INTERVAL_MS = 1100;
export const sparqlLimit = createRateLimiter(SPARQL_MIN_INTERVAL_MS);
export const gleifLimit = createRateLimiter(GLEIF_MIN_INTERVAL_MS);

// Flaky-connection detector: GLEIF drops sockets mid-sync (ECONNRESET /
// "socket hang up"). Only these retry; anything else throws immediately.
function isConnReset(err: unknown): boolean {
  return (
    axios.isAxiosError(err) &&
    (err.code === "ECONNRESET" || /socket hang up/i.test(err.message))
  );
}

// One GLEIF GET: polite pacing plus up to 3 tries with backoff on dropped
// connections. Only successful responses are cached (by the caller).
async function gleifGet<T>(url: string, params: Record<string, unknown>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      apiLog("GET", url);
      return await gleifLimit(async () => {
        const res = await axios.get<T>(url, {
          params,
          headers: { "User-Agent": UA },
          timeout: 60000,
        });
        return res.data;
      });
    } catch (err) {
      // Dropped connections retry fast; a 429/5xx backs off and honors
      // Retry-After (never observed from GLEIF — defensive). Else throw.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const throttled =
        status === 429 || (status !== undefined && status >= 500);
      if ((!isConnReset(err) && !throttled) || attempt >= 3) {
        throw err;
      }
      const retryAfter = Number(
        axios.isAxiosError(err) ? err.response?.headers?.["retry-after"] : NaN,
      );
      const waitMs =
        throttled && Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 120
          ? retryAfter * 1000
          : (throttled ? 5000 : 1000) * attempt;
      const why = throttled ? `HTTP ${status}` : "connection reset";
      console.warn(
        `[global] ${url}: ${why}, retry ${attempt}/3 in ${waitMs / 1000}s`,
      );
      await sleep(waitMs);
    }
  }
}

interface GleifRecordDoc {
  data?: {
    attributes?: { entity?: { legalName?: { name?: unknown } } & Record<
      string,
      unknown
    > };
  };
}

interface GleifChildrenDoc {
  data?: {
    id?: unknown;
    attributes?: { entity?: { legalName?: { name?: unknown } } & Record<
      string,
      unknown
    > };
  }[];
  meta?: { pagination?: { lastPage?: number } };
}

export interface GlobalCompany {
  name: string;
  isin: string;
  lei: string;
  exchanges: string[];
  hq: string | null;
}

// Wikidata continent QIDs (Europe/Asia/North+South America/Africa/Oceania).
// A wrong QID yields zero rows, never wrong rows (nothing matches), and
// cross-region dupes (transcontinental countries) dedupe by LEI downstream.
export const GLOBAL_REGIONS: { name: string; qid: string; share: number }[] = [
  { name: "europe", qid: "Q46", share: 0.36 },
  { name: "asia", qid: "Q48", share: 0.36 },
  { name: "north-america", qid: "Q49", share: 0.1 },
  { name: "south-america", qid: "Q18", share: 0.08 },
  { name: "africa", qid: "Q15", share: 0.06 },
  { name: "oceania", qid: "Q55643", share: 0.04 },
];

// Paged calls (offset !== undefined) add a ?lei tiebreaker so page
// boundaries are deterministic; the unpaged text stays byte-identical,
// preserving every existing cache entry.
export function buildCompanyQuery(
  limit: number,
  continentQid?: string,
  offset?: number,
): string {
  const region = continentQid
    ? `  ?company wdt:P17 ?country.\n  ?country wdt:P30 wd:${continentQid}.\n  FILTER(?country != wd:Q30).\n`
    : "";
  const order =
    offset === undefined
      ? "ORDER BY DESC(?links)"
      : "ORDER BY DESC(?links) ?lei";
  const off = offset ? ` OFFSET ${offset}` : "";
  return `SELECT ?companyLabel ?isin ?lei ?exchangeLabel ?hqLabel (COUNT(?sl) AS ?links) WHERE {
  ?company wdt:P946 ?isin; wdt:P1278 ?lei; wdt:P414 ?exchange.
${region}  ?sl schema:about ?company.
  OPTIONAL { ?company wdt:P159 ?hq. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?companyLabel ?isin ?lei ?exchangeLabel ?hqLabel ${order} LIMIT ${limit}${off}`;
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

async function sparqlRegion(
  region: string,
  query: string,
): Promise<GlobalCompany[]> {
  const doc = await cachedJson<{ results?: { bindings?: SparqlBinding[] } }>(
    `global/wikidata-companies-${region}-${cacheKey(query)}.json`,
    async () => {
      // Heavy region queries 504/429 under load: 3 tries with backoff.
      // Only successes cache, so a failed page retries clean next run.
      for (let attempt = 1; ; attempt += 1) {
        try {
          apiLog("GET", SPARQL);
          return await sparqlLimit(async () => {
            const res = await axios.get(SPARQL, {
              params: { format: "json", query },
              headers: { "User-Agent": UA },
              timeout: 120000,
            });
            return res.data;
          });
        } catch (err) {
          const status = axios.isAxiosError(err)
            ? err.response?.status
            : undefined;
          const retryable =
            status === 429 || (status !== undefined && status >= 500);
          if (!retryable || attempt >= 3) {
            throw err;
          }
          const waitMs = 15000 * attempt;
          console.warn(
            `[global] region ${region}: HTTP ${status}, retry ${attempt}/3 in ${waitMs / 1000}s`,
          );
          await sleep(waitMs);
        }
      }
    },
  );
  return parseCompanyRows(doc);
}

// Single-query page size: 500-row region queries pass reliably while
// 1800-row ones 504 inside Wikidata's 60s cap (proven 2026-11-01: europe
// 504, asia 429 at GLOBAL_LIMIT=5000). Quotas above a page go out as
// LIMIT/OFFSET chunks, each cached separately.
const SPARQL_PAGE_SIZE = 500;
const SPARQL_REGION_PAUSE_MS = 5000; // don't stack six heavy queries back-to-back
const SPARQL_PAGE_PAUSE_MS = 10000;

export async function sparqlCompanies(limit: number): Promise<GlobalCompany[]> {
  const byLei = new Map<string, GlobalCompany>();
  for (const [ri, r] of GLOBAL_REGIONS.entries()) {
    const quota = Math.max(5, Math.round(limit * r.share));
    if (ri > 0) {
      await sleep(SPARQL_REGION_PAUSE_MS);
    }
    // One query when it fits the proven page (byte-identical text, so old
    // caches still hit); LIMIT/OFFSET chunks above it.
    const queries =
      quota <= SPARQL_PAGE_SIZE
        ? [buildCompanyQuery(quota, r.qid)]
        : Array.from(
            { length: Math.ceil(quota / SPARQL_PAGE_SIZE) },
            (_, p) =>
              buildCompanyQuery(
                Math.min(SPARQL_PAGE_SIZE, quota - p * SPARQL_PAGE_SIZE),
                r.qid,
                p * SPARQL_PAGE_SIZE,
              ),
          );
    let batch: GlobalCompany[];
    try {
      batch = [];
      for (const [pi, q] of queries.entries()) {
        if (pi > 0) {
          await sleep(SPARQL_PAGE_PAUSE_MS);
        }
        batch.push(...(await sparqlRegion(r.name, q)));
      }
    } catch (err) {
      // Retries inside sparqlRegion already failed: skip the region with a
      // warning instead of losing the whole run. Cached pages survive.
      console.warn(`[global] region ${r.name}: query failed, skipping (${err})`);
      continue;
    }
    let fresh = 0;
    for (const c of batch) {
      const prev = byLei.get(c.lei);
      if (prev) {
        // Cross-page or transcontinental dupe: merge, don't drop.
        for (const ex of c.exchanges) {
          if (!prev.exchanges.includes(ex)) {
            prev.exchanges.push(ex);
          }
        }
        prev.hq = prev.hq ?? c.hq;
        continue;
      }
      byLei.set(c.lei, c);
      fresh += 1;
    }
    console.log(`[global] region ${r.name}: ${fresh} companies`);
  }
  return [...byLei.values()];
}

export async function gleifEntity(lei: string): Promise<{
  name: string;
  address: GleifAddress | null;
} | null> {
  const doc = await cachedJson<GleifRecordDoc>(
    `global/gleif/${lei}.json`,
    () =>
      gleifGet<GleifRecordDoc>(`${GLEIF}/lei-records/${lei}`, {
        "fields[lei-records]": "entity",
      }),
  );
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
    const doc = await cachedJson<GleifChildrenDoc>(
      `global/gleif-children/${lei}-p${page}.json`,
      () =>
        gleifGet<GleifChildrenDoc>(
          `${GLEIF}/lei-records/${lei}/direct-children`,
          {
            "page[size]": 100,
            "page[number]": page,
            "fields[lei-records]": "entity",
          },
        ),
    );
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
    Number(process.env.GLOBAL_MAX_CHILDREN ?? 50),
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
      let g: { name: string; address: GleifAddress | null } | null;
      try {
        g = await gleifEntity(c.lei);
      } catch (err) {
        console.warn(`[global] ${c.lei}: record fetch failed, skipping (${err})`);
        continue;
      }
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
      let children: GleifChild[];
      try {
        children = await gleifChildren(c.lei, maxChildren);
      } catch (err) {
        console.warn(
          `[global] ${c.lei}: children fetch failed, keeping parent only (${err})`,
        );
        children = [];
      }
      for (const child of children) {
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
            amount: 0, // stake qty. n/a per GLEIF
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
