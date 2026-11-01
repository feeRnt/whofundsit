import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey, apiLog } from "./httpCache.js";
import { gleifEntity } from "./globalSync.js";

// Taiwan financial facts from TWSE OpenAPI (gov open-data license: use the
// official API only, attribute, keep data intact — see DATASETS.md). Balance
// sheets per industry -> Assets onto lei: entities, joined TWSE-code -> LEI
// through Wikidata (ticker + LEI + TWSE/TPEx listing). Ticker-joined LEIs
// missing from the DB are created via GLEIF (legal name + HQ address, same
// cache global:sync uses), so this loader is self-sufficient — it never
// depends on global:sync's random company sample covering Taiwan. Values
// are NTD thousands (verified by magnitude: TSMC row => ~NT$9.4T ~= US$300B).
// Row ceiling: TWSE_LIMIT (default 2000).
// NOTE: the endpoints serve the CURRENT quarter only; early in a quarter
// (e.g. 46 rows on Nov 1) most companies haven't filed yet — rerun later.

const TWSE = "https://openapi.twse.com.tw/v1/opendata";
const SPARQL = "https://query.wikidata.org/sparql";
const UA =
  process.env.WIKIDATA_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";

// ROC year 115 + quarter -> Gregorian quarter-end date.
export function rocQuarterEnd(rocYear: string, quarter: string): string | null {
  const y = Number(rocYear);
  const q = Number(quarter);
  if (!Number.isInteger(y) || ![1, 2, 3, 4].includes(q)) {
    return null;
  }
  const lastDay = q === 1 ? "31" : q === 2 ? "30" : q === 3 ? "30" : "31";
  return `${y + 1911}-${String(q * 3).padStart(2, "0")}-${lastDay}`;
}

export interface TwseBalanceRow {
  code: string;
  name: string;
  assets: number;
  date: string | null;
}

// TWSE balance-sheet row (Chinese keys, NTD thousands).
export function parseTwseBalance(row: Record<string, unknown>): TwseBalanceRow | null {
  const code = typeof row["公司代號"] === "string" ? row["公司代號"].trim() : "";
  const name = typeof row["公司名稱"] === "string" ? row["公司名稱"].trim() : "";
  const assets = Number(row["資產總計"]);
  if (!code || !Number.isFinite(assets)) {
    return null;
  }
  const date =
    typeof row["年度"] === "string" && typeof row["季別"] === "string"
      ? rocQuarterEnd(row["年度"], row["季別"])
      : null;
  return { code, name, assets: assets * 1000, date };
}

// Light CJK-tolerant name key (uppercase, no spaces/punct; no EN suffix
// stripping — thirteenF's normalizer would mangle these names).
export function twNameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[\s\p{P}]/gu, "")
    .replace(/(COMPANY|LIMITED|CORPORATION|INCORPORATED|CO|INC|LTD)$/, "");
}

// Join a TWSE code to a lei: id: Wikidata ticker map first, normalized
// company-name fallback second. Pure + unit-tested.
export function joinTwseCode(
  code: string,
  name: string,
  tickerToLei: Map<string, string>,
  nameToLei: Map<string, string>,
): { lei: string; via: "ticker" | "name" } | null {
  const byTicker = tickerToLei.get(code);
  if (byTicker) {
    return { lei: byTicker, via: "ticker" };
  }
  const byName = nameToLei.get(twNameKey(name));
  if (byName) {
    return { lei: byName, via: "name" };
  }
  return null;
}

const BALANCE_ENDPOINTS = [
  "t187ap07_L_ci", // general
  "t187ap07_L_fh", // financial holdings
  "t187ap07_L_ins", // insurance
  "t187ap07_L_bd", // securities/futures
  "t187ap07_L_mim", // mixed
  "t187ap07_L_basi", // banks
];

async function twseGet(endpoint: string): Promise<Record<string, unknown>[]> {
  return cachedJson<Record<string, unknown>[]>(
    `regional/twse-${endpoint}.json`,
    async () => {
      await new Promise((r) => setTimeout(r, 500)); // polite, cached anyway
      apiLog("GET", `${TWSE}/${endpoint}`);
      return (
        await axios.get(`${TWSE}/${endpoint}`, {
          headers: { "User-Agent": UA },
          timeout: 120000,
        })
      ).data;
    },
  );
}

async function twseCodeToLei(): Promise<Map<string, string>> {
  const query = `SELECT ?ticker ?lei WHERE {
  ?company wdt:P249 ?ticker; wdt:P1278 ?lei; wdt:P414 ?ex.
  ?ex rdfs:label ?el.
  FILTER(LANG(?el) = "en" && (?el = "Taiwan Stock Exchange" || ?el = "Taipei Exchange"))
}`;
  const doc = await cachedJson<{
    results?: { bindings?: { ticker?: { value?: unknown }; lei?: { value?: unknown } }[] };
  }>(`regional/twse-wikidata-${cacheKey(query)}.json`, async () => {
    apiLog("GET", SPARQL);
    return (
      await axios.get(SPARQL, {
        params: { format: "json", query },
        headers: { "User-Agent": UA },
        timeout: 120000,
      })
    ).data;
  });
  const map = new Map<string, string>();
  for (const b of doc.results?.bindings ?? []) {
    if (typeof b.ticker?.value === "string" && typeof b.lei?.value === "string") {
      map.set(b.ticker.value.trim(), b.lei.value);
    }
  }
  return map;
}

// Ticker-joined LEIs are Wikidata-attested, so a DB miss is safe to create
// (GLEIF legal name + HQ address; coords_populate places it later, exactly
// like global:sync rows). GLEIF misses stay missing.
async function ensureLeiEntity(
  prisma: PrismaClient,
  lei: string,
  code: string,
): Promise<"exists" | "created" | "missing"> {
  const found = await prisma.entity.findUnique({
    where: { id: `lei:${lei}` },
    select: { id: true },
  });
  if (found) {
    return "exists";
  }
  let g: Awaited<ReturnType<typeof gleifEntity>>;
  try {
    g = await gleifEntity(lei);
  } catch {
    return "missing";
  }
  if (!g?.name || !g.address) {
    return "missing";
  }
  await prisma.entity.create({
    data: {
      id: `lei:${lei}`,
      name: g.name,
      type: "Company",
      lat: 0,
      lng: 0,
      fundsVolume: 0,
      rawAddressText: g.address.country ?? "—",
      businessAddress: g.address.joined,
      tickers: [code],
      exchanges: [],
      source: "twse",
    },
  });
  return "created";
}

export async function runRegionalTwse(): Promise<{
  rows: number;
  updated: number;
  viaTicker: number;
  viaName: number;
  unmatched: number;
  missing: number;
  created: number;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const limit = Math.max(1, Number(process.env.TWSE_LIMIT ?? 2000));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const leiRows = await prisma.entity.findMany({
      where: { id: { startsWith: "lei:" } },
      select: { id: true, name: true },
    });
    if (leiRows.length === 0) {
      throw new Error("[twse] no lei: entities — run npm run global:sync first");
    }
    const tickerToLei = await twseCodeToLei();
    const nameToLei = new Map(
      leiRows.map((r) => [twNameKey(r.name), r.id.slice("lei:".length)]),
    );
    let rows = 0;
    let updated = 0;
    let viaTicker = 0;
    let viaName = 0;
    let unmatched = 0;
    let missing = 0;
    let created = 0;
    for (const endpoint of BALANCE_ENDPOINTS) {
      const raw = await twseGet(endpoint);
      for (const r of raw) {
        const row = parseTwseBalance(r);
        if (!row) {
          continue;
        }
        rows += 1;
        const join = joinTwseCode(row.code, row.name, tickerToLei, nameToLei);
        if (!join) {
          unmatched += 1;
          continue;
        }
        if (updated >= limit) {
          break;
        }
        // Name joins always hit (built from DB rows); ticker joins may name
        // LEIs global:sync never created — create those via GLEIF.
        if (join.via === "ticker") {
          const state = await ensureLeiEntity(prisma, join.lei, row.code);
          if (state === "missing") {
            missing += 1;
            continue;
          }
          if (state === "created") {
            created += 1;
          }
        }
        // A zero-count write is still a miss, not an update (backstop).
        const res = await prisma.entity.updateMany({
          where: { id: `lei:${join.lei}` },
          data: {
            fundsVolume: row.assets,
            conceptTag: "Assets",
            financialDate: row.date ? new Date(row.date) : null,
            currency: "TWD",
            sourceTimeFrame: row.date,
          },
        });
        if (res.count === 0) {
          missing += 1;
          continue;
        }
        updated += 1;
        if (join.via === "ticker") {
          viaTicker += 1;
        } else {
          viaName += 1;
        }
      }
      if (updated >= limit) {
        break;
      }
    }
    return { rows, updated, viaTicker, viaName, unmatched, missing, created };
  } finally {
    await prisma.$disconnect();
  }
}
