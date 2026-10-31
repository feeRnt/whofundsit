import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, readCache, writeCache } from "./httpCache.js";
import {
  ADDRESS_MAP_CACHE,
  jsonEntries,
  type BulkAddress,
} from "./bulkLoad.js";
import { geocodeLocal } from "./pipeline.js";

// 13F-HR holdings -> dollar-denominated CapitalFlow arcs (fund -> portfolio
// company). Full-filer scale-up: every 13F-HR filer in the local bulk archive
// is discovered (cached) with the three curated managers first. XML values
// are whole USD (verified live: value / shares == market price). CUSIP->
// company mapping is offline name normalization against placed entities;
// funds with zero matches skip the entity + geocode entirely (lazy).

const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

const MAX_13F_FLOWS = 100000; // guardrail: matched flows only, still bounded
const MANAGERS_CACHE = "13f/managers.json";
const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
);
const SEC_MIN_INTERVAL_MS = 150;

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
  const listing = await cachedJson<{
    directory?: { item?: { name: string; size?: unknown }[] };
  }>(`13f/filings/${cikNum}/${stub}/index.json`, () =>
    secGet(`${base}/index.json`),
  );
  // The information table dwarfs the primary doc (MBs vs KBs): pick the
  // largest .xml that isn't primary_doc.xml (verified live: Vanguard's table
  // is "13F_<cik>_<date>.xml" with no "info" in the name).
  const tables = (listing.directory?.item ?? [])
    .filter((i) => i.name.endsWith(".xml") && i.name !== "primary_doc.xml")
    .sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  const doc = tables[0]?.name;
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
  /** How many filing sleeves were summed into valueUsd. */
  sleeves: number;
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
      valueUsd: value, // whole dollars (NOT thousands — verified live)
      shares: Number(shrs?.sshPrnamt ?? 0) || 0,
      sleeves: 1,
    });
  }
  // Same-CUSIP lines (other-manager sleeves) sum: last-write-wins kept a
  // $56k fragment of BlackRock's ~$95B Meta position. Sort after merging.
  const merged = new Map<string, Holding>();
  for (const h of out) {
    const prev = merged.get(h.cusip);
    if (prev) {
      prev.valueUsd += h.valueUsd;
      prev.shares += h.shares;
      prev.sleeves += 1;
    } else {
      merged.set(h.cusip, { ...h });
    }
  }
  return [...merged.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}

// Famous HQs pinned at city precision (plenty for a globe; these never move
// and Nominatim lookups for fund names are flaky). Unknown future managers
// try Nominatim once; total failure returns null (skip, don't crash).
const MANAGER_COORDS: Record<string, { lat: number; lng: number }> = {
  "BlackRock, Inc.": { lat: 40.75, lng: -74.0 },
  "The Vanguard Group, Inc.": { lat: 40.04, lng: -75.51 },
  "Berkshire Hathaway Inc": { lat: 41.26, lng: -95.93 },
};

async function geocodeFund(
  spec: ManagerSpec,
  cikNum: string,
  addrCache: Record<string, BulkAddress> | undefined,
): Promise<{ lat: number; lng: number } | null> {
  const pin = MANAGER_COORDS[spec.name];
  if (pin) {
    return pin;
  }
  // Bulk address when the v2 map is cached, else a bare name query; both go
  // through the shared throttled + cached local geocoder.
  const query = addrCache?.[cikNum]?.address ?? `${spec.name} headquarters`;
  try {
    return await geocodeLocal(query);
  } catch {
    return null;
  }
}

export interface DiscoveredManager {
  cik: string;
  name: string;
  accn: string;
  filingDate: string;
}

// Local scan of the bulk submissions archive: every filer whose recent
// filings include a 13F-HR, with its latest accession (newest first).
export async function discoverManagers(
  zipPath: string,
): Promise<DiscoveredManager[]> {
  const out: DiscoveredManager[] = [];
  for await (const { json } of jsonEntries(zipPath)) {
    const doc = json as {
      cik?: unknown;
      name?: unknown;
      filings?: { recent?: RecentFilings } | null;
    };
    const cik = typeof doc.cik === "string" ? Number(doc.cik) : doc.cik;
    if (typeof cik !== "number" || !Number.isFinite(cik)) {
      continue;
    }
    if (typeof doc.name !== "string" || !doc.name) {
      continue;
    }
    const recent = doc.filings?.recent;
    const forms = recent?.form ?? [];
    const idx = forms.findIndex(
      (f) => typeof f === "string" && f.startsWith("13F-HR"),
    );
    if (idx < 0) {
      continue;
    }
    const accn = recent?.accessionNumber?.[idx];
    const filingDate = recent?.filingDate?.[idx];
    if (typeof accn !== "string" || typeof filingDate !== "string") {
      continue;
    }
    out.push({ cik: String(cik), name: doc.name, accn, filingDate });
  }
  return out;
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

    // Full-filer discovery: local bulk scan (cached), curated first.
    let discovered = readCache<DiscoveredManager[]>(MANAGERS_CACHE);
    if (discovered === undefined) {
      const zipPath = path.join(DATA_DIR, "submissions.zip");
      if (!fs.existsSync(zipPath)) {
        console.log("[13f] no bulk submissions.zip; curated managers only");
        discovered = [];
      } else {
        console.log("[13f] discovering 13F filers in the bulk archive...");
        discovered = await discoverManagers(zipPath);
        writeCache(MANAGERS_CACHE, discovered);
      }
      console.log(`[13f] discovered ${discovered.length} 13F filers`);
    } else {
      console.log(`[13f] ${discovered.length} 13F filers (from discovery cache)`);
    }
    const addrCache = readCache<Record<string, BulkAddress>>(ADDRESS_MAP_CACHE);
    type Job = {
      spec: ManagerSpec;
      filing: { accn: string; filingDate: string; state: string | null } | null;
    };
    const jobs: Job[] = managers().map((spec) => ({ spec, filing: null }));
    const curated = new Set<string>();
    for (const job of jobs) {
      curated.add(await resolveCik(job.spec));
    }
    for (const d of discovered) {
      if (!curated.has(d.cik)) {
        jobs.push({
          spec: {
            label: d.name,
            name: d.name,
            tickers: [],
            pinnedCik: d.cik,
            envCik: undefined,
          },
          filing: { accn: d.accn, filingDate: d.filingDate, state: null },
        });
      }
    }
    const maxManagers = Math.max(
      0,
      Number(process.env.THIRTEENF_MAX_MANAGERS ?? 0),
    );
    const queue = maxManagers > 0 ? jobs.slice(0, maxManagers) : jobs;
    console.log(`[13f] processing ${queue.length} managers`);

    const managerStats: ThirteenFSummary["managers"] = [];
    let flows = 0;
    let unmatched = 0;
    let done = 0;
    for (const job of queue) {
      const { spec } = job;
      const cikNum = await resolveCik(spec);
      const cik10 = cikNum.padStart(10, "0");
      const filing = job.filing ?? (await latest13F(cik10, spec.label));
      const xml = await infoTableXml(cikNum, filing.accn);
      const holdings = parseInfoTable(xml);
      console.log(
        `[13f] ${spec.label}: ${holdings.length} holdings (filing ${filing.accn})`,
      );
      const fundId = `13f:${cik10}`;
      const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
      const state = filing.state;
      // Match first: funds with no placed holdings skip entity + geocode.
      const matched: { holding: Holding; targetId: string }[] = [];
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
        matched.push({ holding: h, targetId });
      }
      if (matched.length === 0) {
        console.log(`[13f] ${spec.label}: 0/${holdings.length} matched, skipping`);
        managerStats.push({
          label: spec.label,
          holdings: holdings.length,
          matched: 0,
          flows: 0,
        });
        continue;
      }
      const at = await geocodeFund(spec, cikNum, addrCache);
      if (!at) {
        console.log(
          `[13f] ${spec.label}: unplaceable, skipping ${matched.length} matches`,
        );
        managerStats.push({
          label: spec.label,
          holdings: holdings.length,
          matched: 0,
          flows: 0,
        });
        continue;
      }
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

      let wrote = 0;
      for (const { holding: h, targetId } of matched) {
        // One flow per CUSIP (same-company sleeves already summed; different
        // classes keep separate flows, e.g. GOOGL/GOOG).
        await prisma.capitalFlow.upsert({
          where: { id: `13f:${cik10}:${h.cusip}` },
          create: {
            id: `13f:${cik10}:${h.cusip}`,
            sourceEntityId: fundId,
            targetEntityId: targetId,
            amount: h.valueUsd,
            flowType: "13f",
            sleeves: h.sleeves,
          },
          update: {
            sourceEntityId: fundId,
            targetEntityId: targetId,
            amount: h.valueUsd,
            flowType: "13f",
            sleeves: h.sleeves,
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
        matched: matched.length,
        flows: wrote,
      });
      done += 1;
      if (done % 25 === 0) {
        console.log(`[13f] ${done}/${queue.length} managers, ${flows} flows...`);
      }
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
