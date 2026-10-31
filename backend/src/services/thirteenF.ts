import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey } from "./httpCache.js";

// 13F-HR holdings -> dollar-denominated CapitalFlow arcs (fund -> portfolio
// company). Scoped to three mega-managers for the demo; each yields up to
// TOP_HOLDINGS arcs. Amounts are USD (13F reports value in $thousands).
// CUSIP->company mapping is offline name normalization against placed
// entities (no new API); misses log with CUSIP for audit. BlackRock and
// Berkshire resolve via the ticker map (shared cache, zero new calls after
// ingest); Vanguard has no ticker so its CIK is pinned (verify live).

const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

const MAX_13F_FLOWS = 20000; // guardrail: full holdings for all managers
const SEC_MIN_INTERVAL_MS = 150;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

let lastSecAt = 0;

async function secThrottle(): Promise<void> {
  const waitMs = Math.max(0, lastSecAt + SEC_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastSecAt = Date.now();
}

function secUA(): string {
  return process.env.SEC_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";
}

function nomUA(): string {
  return (
    process.env.NOMINATIM_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)"
  );
}

async function secGet<T>(url: string): Promise<T> {
  await secThrottle();
  const { data } = await axios.get<T>(url, {
    headers: {
      "User-Agent": secUA(),
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });
  return data;
}

interface ManagerSpec {
  label: string;
  name: string;
  tickers: string[];
  pinnedCik: string | null;
  envCik: string | undefined;
}

function managers(): ManagerSpec[] {
  return [
    {
      label: "BlackRock",
      name: "BlackRock, Inc.",
      tickers: ["BLK"],
      pinnedCik: null,
      envCik: process.env.THIRTEENF_BLACKROCK_CIK,
    },
    {
      label: "Vanguard",
      name: "The Vanguard Group, Inc.",
      tickers: [],
      pinnedCik: "102909",
      envCik: process.env.THIRTEENF_VANGUARD_CIK,
    },
    {
      label: "Berkshire",
      name: "Berkshire Hathaway Inc",
      tickers: ["BRK-A", "BRKA", "BRK-B", "BRKB"],
      pinnedCik: "1067983",
      envCik: process.env.THIRTEENF_BERKSHIRE_CIK,
    },
  ];
}

interface TickerEntry {
  cik_str: number;
  ticker: string;
}

async function resolveCik(spec: ManagerSpec): Promise<string> {
  if (spec.envCik?.trim()) {
    return String(Number(spec.envCik.trim()));
  }
  if (spec.tickers.length > 0) {
    // Same cache file the frames ingest uses: zero new calls after ingest.
    const map = await cachedJson<Record<string, TickerEntry>>(
      "sec/company_tickers.json",
      () => secGet<Record<string, TickerEntry>>(TICKER_MAP_URL),
    );
    const want = new Set(spec.tickers.map((t) => t.toUpperCase()));
    for (const entry of Object.values(map)) {
      if (want.has(entry.ticker.toUpperCase())) {
        return String(entry.cik_str);
      }
    }
  }
  if (spec.pinnedCik) {
    return spec.pinnedCik;
  }
  throw new Error(
    `[13f] cannot resolve CIK for ${spec.label} — set THIRTEENF_${spec.label.toUpperCase()}_CIK in backend/.env`,
  );
}

interface RecentFilings {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
}

async function latest13F(
  cik10: string,
  label: string,
): Promise<{ accn: string; filingDate: string; state: string | null }> {
  const doc = await cachedJson<{
    addresses?: {
      business?: Record<string, unknown> | null;
      mailing?: Record<string, unknown> | null;
    } | null;
    filings?: { recent?: RecentFilings } | null;
  }>(`13f/submissions/CIK${cik10}.json`, () =>
    secGet(`${SUBMISSIONS_URL}/CIK${cik10}.json`),
  );
  const recent = doc.filings?.recent;
  const idx = recent?.form.findIndex((f) => f.startsWith("13F-HR")) ?? -1;
  if (!recent || idx < 0) {
    throw new Error(
      `[13f] no 13F-HR filing for ${label} (CIK ${cik10}) — wrong CIK? Set THIRTEENF_${label.toUpperCase()}_CIK.`,
    );
  }
  const biz = doc.addresses?.business ?? doc.addresses?.mailing ?? null;
  const state = biz?.stateOrCountry;
  return {
    accn: recent.accessionNumber[idx],
    filingDate: recent.filingDate[idx],
    state: typeof state === "string" ? state : null,
  };
}

async function infoTableXml(cikNum: string, accn: string): Promise<string> {
  const stub = accn.replace(/-/g, "");
  const base = `${ARCHIVE_URL}/${cikNum}/${stub}`;
  const listing = await cachedJson<{ directory?: { item?: { name: string }[] } }>(
    `13f/filings/${cikNum}/${stub}/index.json`,
    () => secGet(`${base}/index.json`),
  );
  const names = (listing.directory?.item ?? []).map((i) => i.name);
  const doc =
    names.find((n) => n.toLowerCase().includes("info") && n.endsWith(".xml")) ??
    names.find((n) => n.endsWith(".xml"));
  if (!doc) {
    throw new Error(`[13f] no information table in ${base}/index.json`);
  }
  return cachedJson<string>(`13f/filings/${cikNum}/${stub}/${doc}`, async () => {
    await secThrottle();
    const { data } = await axios.get<string>(`${base}/${doc}`, {
      headers: { "User-Agent": secUA(), Accept: "application/xml, text/xml" },
      responseType: "text",
    });
    return data;
  });
}

export interface Holding {
  issuer: string;
  classTitle: string;
  cusip: string;
  valueUsd: number;
  shares: number;
}

// Same function normalizes both sides (13F issuers and our entity names),
// so over-stripping is harmless: only asymmetric matches would be wrong.
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(
      /\b(INC|CORP|CORPORATION|LLC|LTD|LIMITED|PLC|CO|COMPANY|HOLDINGS|HOLDING|GROUP|NV|SA|AG|SE|SPA|LP|LLP|TRUST|BANCORP|FINANCIAL|SERVICES|SYSTEMS|TECHNOLOGIES|TECHNOLOGY|PHARMACEUTICALS|COMMUNICATIONS|ENERGY|CAPITAL|PARTNERS|ENTERPRISE|ENTERPRISES|INDUSTRIES|INTERNATIONAL|NATIONAL|THE)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// parseTagValue stays off so CUSIPs keep leading zeros; numbers convert manually.
export function parseInfoTable(xml: string): Holding[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
  });
  const doc = parser.parse(xml) as {
    informationTable?: { infoTable?: unknown };
  };
  const tables = doc.informationTable?.infoTable;
  const rows = Array.isArray(tables) ? tables : tables ? [tables] : [];
  const out: Holding[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const issuer = typeof row.nameOfIssuer === "string" ? row.nameOfIssuer : "";
    const cusip = typeof row.cusip === "string" ? row.cusip : "";
    const value = Number(row.value);
    const shrs = row.shrsOrPrnAmt as { sshPrnamt?: unknown } | undefined;
    if (!issuer || !cusip || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    out.push({
      issuer,
      classTitle: typeof row.titleOfClass === "string" ? row.titleOfClass : "",
      cusip,
      valueUsd: value * 1000, // 13F reports $thousands
      shares: Number(shrs?.sshPrnamt ?? 0) || 0,
    });
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd);
}

async function geocodeManager(name: string): Promise<{ lat: number; lng: number }> {
  return cachedJson(`13f/manager-geo-${cacheKey(name)}.json`, async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS),
    );
    const { data } = await axios.get<{ lat: string; lon: string }[]>(
      "https://nominatim.openstreetmap.org/search",
      {
        params: { format: "jsonv2", limit: 1, q: `${name} headquarters` },
        headers: { "User-Agent": nomUA(), Accept: "application/json" },
      },
    );
    if (!data[0]) {
      throw new Error(`[13f] could not geocode ${name}`);
    }
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  });
}

export interface ThirteenFSummary {
  managers: {
    label: string;
    holdings: number;
    matched: number;
    flows: number;
  }[];
  flows: number;
  unmatched: number;
}

export async function runThirteenF(): Promise<ThirteenFSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    // Placed entities by normalized name (prefer the Assets row per company).
    const placed = await prisma.entity.findMany({
      where: { lat: { not: 0 }, lng: { not: 0 } },
      select: { id: true, name: true, conceptTag: true },
    });
    const byName = new Map<string, string>();
    for (const e of placed) {
      const key = normalizeIssuerName(e.name);
      if (!key) {
        continue;
      }
      if (!byName.has(key) || e.conceptTag === "Assets") {
        byName.set(key, e.id);
      }
    }
    console.log(
      `[13f] ${byName.size} matchable companies (${placed.length} placed rows)`,
    );

    const managerStats: ThirteenFSummary["managers"] = [];
    let flows = 0;
    let unmatched = 0;
    for (const spec of managers()) {
      const cikNum = await resolveCik(spec);
      const cik10 = cikNum.padStart(10, "0");
      const filing = await latest13F(cik10, spec.label);
      const xml = await infoTableXml(cikNum, filing.accn);
      const holdings = parseInfoTable(xml);
      console.log(
        `[13f] ${spec.label}: ${holdings.length} holdings (filing ${filing.accn})`,
      );
      const at = await geocodeManager(spec.name);
      const fundId = `13f:${cik10}`;
      const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
      const state = filing.state;
      await prisma.entity.upsert({
        where: { id: fundId },
        create: {
          id: fundId,
          name: spec.name,
          type: "Fund",
          lat: at.lat,
          lng: at.lng,
          fundsVolume: totalUsd,
          rawAddressText:
            state && state.length === 2 ? `US-${state}` : (state ?? "—"),
          tickers: [],
          source: "13f",
        },
        update: {
          name: spec.name,
          lat: at.lat,
          lng: at.lng,
          fundsVolume: totalUsd,
          source: "13f",
        },
      });

      let matched = 0;
      let wrote = 0;
      const missSample: string[] = [];
      for (const h of holdings) {
        const targetId = byName.get(normalizeIssuerName(h.issuer));
        if (!targetId) {
          unmatched += 1;
          if (missSample.length < 5) {
            missSample.push(`${h.issuer} [${h.cusip}]`);
          }
          continue;
        }
        matched += 1;
        // One flow per holding (CUSIP in the id: same company, two classes =
        // two flows, e.g. GOOGL/GOOG).
        await prisma.capitalFlow.upsert({
          where: { id: `13f:${cik10}:${h.cusip}` },
          create: {
            id: `13f:${cik10}:${h.cusip}`,
            sourceEntityId: fundId,
            targetEntityId: targetId,
            amount: h.valueUsd,
            flowType: "13f",
          },
          update: {
            sourceEntityId: fundId,
            targetEntityId: targetId,
            amount: h.valueUsd,
            flowType: "13f",
          },
        });
        wrote += 1;
        flows += 1;
        if (flows >= MAX_13F_FLOWS) {
          break;
        }
      }
      if (missSample.length > 0) {
        console.log(`[13f] ${spec.label} unmatched, e.g. ${missSample.join("; ")}`);
      }
      managerStats.push({
        label: spec.label,
        holdings: holdings.length,
        matched,
        flows: wrote,
      });
      if (flows >= MAX_13F_FLOWS) {
        console.log(`[13f] flow ceiling hit (${MAX_13F_FLOWS}); stopping`);
        break;
      }
    }
    return { managers: managerStats, flows, unmatched };
  } finally {
    await prisma.$disconnect();
  }
}
