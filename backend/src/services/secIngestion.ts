import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { NASDAQ100_TICKERS } from "../data/nasdaq100.js";
import { SP500_TICKERS } from "../data/sp500.js";
import { cachedJson, cachedJsonQuarterly, apiLog, userAgentFromEnv } from "./httpCache.js";

// SEC EDGAR Frames API: one funding-relevant concept per frame, Q2 2026
// (last fully-filed quarter). Responses are file-cached under gitignored
// backend/data/cache (ground-rules §4); CACHE_REFRESH=1 re-fetches.
const FRAME_API = "https://data.sec.gov/api/xbrl/frames";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions";

interface FrameSpec {
  taxonomy: string;
  tag: string;
  uom: string;
  ccp: string;
}

const FRAMES: FrameSpec[] = [
  { taxonomy: "us-gaap", tag: "StockholdersEquity", uom: "USD", ccp: "CY2026Q2I" },
  { taxonomy: "us-gaap", tag: "LongTermDebt", uom: "USD", ccp: "CY2026Q2I" },
  { taxonomy: "us-gaap", tag: "Assets", uom: "USD", ccp: "CY2026Q2I" },
  // Duration concepts use quarterly (non-instantaneous) frames.
  { taxonomy: "us-gaap", tag: "Revenues", uom: "USD", ccp: "CY2026Q2" },
  { taxonomy: "us-gaap", tag: "NetIncomeLoss", uom: "USD", ccp: "CY2026Q2" },
  // Share counts (10-K cover, dei taxonomy): true-% ownership denominator.
  // Never mapped — see the /api/entities + pipeline exclusions.
  {
    taxonomy: "dei",
    tag: "EntityCommonStockSharesOutstanding",
    uom: "shares",
    ccp: "CY2026Q2I",
  },
];

// Hard ceiling per frame: never ingest more than this many rows per frame
// per run (ground-rules guardrail 1). Total rows <= frames x MAX_PER_FRAME.
const MAX_PER_FRAME = 500;

// SEC fair access asks for < 10 requests/second; 150 ms keeps us well under that.
const MIN_INTERVAL_MS = 150;

// Back off (never hammer) on rate limits and server errors.
const SEC_MAX_RETRIES = 3;

interface SecFrameRow {
  accn: string; // SEC filing (accession) number validating this datapoint, e.g. "0001104659-19-016320"
  cik: number; // SEC Central Index Key -> part of Entity.id
  entityName: string; // -> Entity.name
  loc: string; // state code, e.g. "US-IL" -> Entity.rawAddressText
  end: string; // balance-sheet date, e.g. "2019-02-28" -> Entity.financialDate
  val: number; // -> Entity.fundsVolume
  form?: unknown; // e.g. "10-Q" -> Entity.form (when the frame carries it)
  filed?: unknown; // e.g. "2026-07-30" -> Entity.filed
}

interface SecFramesPayload {
  taxonomy: string; // "us-gaap"
  tag: string; // e.g. "StockholdersEquity" -> Entity.conceptTag
  ccp: string; // frame, e.g. "CY2026Q2I" -> Entity.sourceTimeFrame
  uom: string; // "USD"
  data: SecFrameRow[];
}

interface SecAddress {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  stateOrCountry?: string | null;
  zipCode?: string | null;
}

interface SecSubmissions {
  name?: unknown; // legal filer name -> Entity.name (unflattened)
  addresses?: {
    business?: SecAddress | null;
    mailing?: SecAddress | null;
  } | null;
  tickers?: unknown;
  sicDescription?: unknown;
  exchanges?: unknown; // e.g. ["Nasdaq"] -> Entity.exchanges
  category?: unknown; // filer size, e.g. "Large accelerated filer" -> Entity.category
  formerNames?: unknown; // [{name, from, to}] -> Entity.formerNames (names only)
}

export interface FrameSummary {
  tag: string;
  fetched: number;
  upserted: number;
  indexMembers: number;
}

export interface IngestSummary {
  frames: FrameSummary[];
  fetched: number; // rows considered (<= frames x MAX_PER_FRAME)
  upserted: number; // rows written
  skipped: number; // malformed rows skipped (fetched = upserted + skipped)
  withAddress: number; // rows that also got a businessAddress
  pruned: number; // stale rows from other frames removed
  indexMembers: number; // rows belonging to S&P 500 / Nasdaq-100
}

// Minimal in-memory rate limiter gating every outbound SEC call
// (ground-rules guardrail 2): one request at a time, spaced by MIN_INTERVAL_MS.
let lastCallAt = 0;
let callInFlight = false;

async function throttle(): Promise<void> {
  if (callInFlight) {
    throw new Error("SEC ingestion already in progress");
  }
  callInFlight = true;
  const waitMs = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function throttleDone(): void {
  lastCallAt = Date.now();
  callInFlight = false;
}

function userAgent(): string {
  // SEC requires a declared User-Agent (warns when unconfigured).
  return userAgentFromEnv("SEC_USER_AGENT");
}

function secStatus(err: unknown): number | null {
  if (axios.isAxiosError(err)) {
    return err.response?.status ?? null;
  }
  return null;
}

// Thrown when SEC blocks us outright: the run must stop, not burn calls.
class SecBlockedError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One throttled, polite SEC GET: declares our User-Agent, asks for gzip,
// aborts the run on 403 (blocked/undeclared), backs off on 429/5xx/network.
async function secGet<T>(url: string): Promise<T> {
  let attempt = 0;
  for (;;) {
    await throttle();
    try {
      apiLog("GET", url);
      const { data } = await axios.get<T>(url, {
        headers: {
          "User-Agent": userAgent(),
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
      });
      return data;
    } catch (err) {
      if (secStatus(err) === 403) {
        throw new SecBlockedError(
          "SEC refused the request (403) — check SEC_USER_AGENT and fair-access compliance, then retry later",
        );
      }
      const status = secStatus(err);
      const retryable =
        status === null || status === 429 || (status >= 500 && status <= 599);
      attempt += 1;
      if (!retryable || attempt > SEC_MAX_RETRIES) {
        throw err;
      }
      await sleep(1000 * 2 ** (attempt - 1));
    } finally {
      throttleDone();
    }
  }
}

// Frames rows carry no street address, so each CIK gets one submissions call
// (business address preferred, mailing as fallback). Best-effort per row:
// a single failure resolves to null instead of failing the whole run.
interface SubmissionsInfo {
  address: string | null;
  // Legal filer name ("ExxonMobil Holdings Corp"), unflattened.
  name: string | null;
  tickers: string[];
  sicDescription: string | null;
  exchanges: string[];
  category: string | null;
  formerNames: string[];
}

// Run-scoped submissions cache: the same CIK appears in several frames, so
// without this we'd re-download identical docs (ingest is a one-shot process,
// so module scope == one run).
const submissionsCache = new Map<number, SubmissionsInfo>();

async function fetchSubmissions(cik: number): Promise<SubmissionsInfo> {
  const cached = submissionsCache.get(cik);
  if (cached !== undefined) {
    return cached;
  }
  const padded = String(cik).padStart(10, "0");
  const data = await cachedJsonQuarterly<SecSubmissions>(
    `sec/submissions/CIK${padded}.json`,
    () => secGet<SecSubmissions>(`${SUBMISSIONS_URL}/CIK${padded}.json`),
  );
  const addr = data.addresses?.business ?? data.addresses?.mailing ?? null;
  const parts = addr
    ? [
        addr.street1,
        addr.street2,
        addr.city,
        addr.stateOrCountry,
        addr.zipCode,
      ].filter((p): p is string => !!p)
    : [];
  const info: SubmissionsInfo = {
    address: parts.length > 0 ? parts.join(", ") : null,
    name:
      typeof data.name === "string" && data.name.length > 0 ? data.name : null,
    tickers: Array.isArray(data.tickers)
      ? data.tickers.filter((t): t is string => typeof t === "string")
      : [],
    sicDescription:
      typeof data.sicDescription === "string" && data.sicDescription.length > 0
        ? data.sicDescription
        : null,
    exchanges: Array.isArray(data.exchanges)
      ? data.exchanges.filter((t): t is string => typeof t === "string")
      : [],
    category:
      typeof data.category === "string" && data.category.length > 0
        ? data.category
        : null,
    formerNames: Array.isArray(data.formerNames)
      ? data.formerNames
          .map((f) => (f as { name?: unknown })?.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
      : [],
  };
  submissionsCache.set(cik, info);
  return info;
}

// S&P 500 + Nasdaq-100 CIKs, resolved live each run via SEC's ticker map so
// the map always covers index members instead of whoever filed first.
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

interface TickerEntry {
  cik_str: number;
  ticker: string;
}

async function fetchIndexCiks(): Promise<Set<number>> {
  // Index membership changes slowly; refresh monthly or via CACHE_REFRESH=1.
  const data = await cachedJson<Record<string, TickerEntry>>(
    "sec/company_tickers.json",
    () => secGet<Record<string, TickerEntry>>(TICKER_MAP_URL),
  );
  const wanted = new Set(
    [...SP500_TICKERS, ...NASDAQ100_TICKERS].map((t) => t.toUpperCase()),
  );
  const ciks = new Set<number>();
  for (const entry of Object.values(data)) {
    if (wanted.has(entry.ticker.toUpperCase())) {
      ciks.add(entry.cik_str);
    }
  }
  return ciks;
}

/**
 * Fetch each configured SEC frame and upsert Entities from its `data` array,
 * enriching each row with its submissions business address. Rows are keyed by
 * composite id `${cik}:${tag}` so one company holds one row per concept.
 * Rows from frames outside the current config are pruned, keeping the dataset
 * to exactly one snapshot. Idempotent: safe to re-run.
 * Requires DATABASE_URL (read from backend/.env); throws without writing if unset.
 */
export async function ingestSecFrames(): Promise<IngestSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    // Drop rows from any frame outside this config (e.g. the old 2019 frame),
    // so the map never mixes snapshots.
    // Prune only frames-api rows outside this config; bulk-zip rows are the
    // base layer and are never touched here.
    const current = FRAMES.map((f) => f.ccp);
    const pruned = await prisma.entity.deleteMany({
      where: {
        source: "frames-api",
        OR: [{ sourceTimeFrame: null }, { sourceTimeFrame: { notIn: current } }],
      },
    });

    const indexCiks = await fetchIndexCiks();
    console.log(`[ingest] tracking ${indexCiks.size} index-member CIKs`);

    const frames: FrameSummary[] = [];
    let fetched = 0;
    let upserted = 0;
    let skipped = 0;
    let withAddress = 0;
    let indexMembers = 0;

    for (const frame of FRAMES) {
      const url = `${FRAME_API}/${frame.taxonomy}/${frame.tag}/${frame.uom}/${frame.ccp}.json`;
      const payload = await cachedJsonQuarterly<SecFramesPayload>(
        `sec/frames/${frame.tag}-${frame.ccp}.json`,
        () => secGet<SecFramesPayload>(url),
      );
      // Members first (stable sort keeps everyone else's order), then cap.
      const rows = [...payload.data]
        .sort(
          (a, b) => Number(indexCiks.has(b.cik)) - Number(indexCiks.has(a.cik)),
        )
        .slice(0, MAX_PER_FRAME);
      const frameIndexRows = rows.filter((r) => indexCiks.has(r.cik)).length;
      console.log(
        `[ingest] ${frame.tag}: ${rows.length} rows (${frameIndexRows} index members; frame holds ${payload.data.length})`,
      );
      let frameUpserted = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.entityName || !Number.isFinite(row.val) || !row.end) {
          skipped += 1;
          continue;
        }

        // Skip the submissions call when a previous run already stored the
        // address and tickers.
        const id = `${row.cik}:${frame.tag}`;
        const existing = await prisma.entity.findUnique({
          where: { id },
          select: {
            businessAddress: true,
            tickers: true,
            type: true,
            industry: true,
            exchanges: true,
            category: true,
            formerNames: true,
          },
        });
        let businessAddress: string | null = existing?.businessAddress ?? null;
        // True SEC name when submissions were fetched anyway; names:sync
        // backfills rows that skipped the fetch.
        let name = row.entityName;
        let tickers: string[] = existing?.tickers ?? [];
        // Legacy rows smuggled the industry inside type; read both.
        let industry: string | null =
          existing?.industry ??
          (existing?.type && existing.type !== "Company" ? existing.type : null);
        let exchanges: string[] = existing?.exchanges ?? [];
        let category: string | null = existing?.category ?? null;
        let formerNames: string[] = existing?.formerNames ?? [];
        // formerNames piggybacks: empty is legitimate (no past names), so it
        // never triggers a fetch on its own.
        if (
          businessAddress === null ||
          tickers.length === 0 ||
          industry === null ||
          exchanges.length === 0 ||
          category === null
        ) {
          try {
            const info = await fetchSubmissions(row.cik);
            businessAddress = businessAddress ?? info.address;
            name = info.name ?? name;
            if (tickers.length === 0) {
              tickers = info.tickers;
            }
            industry = industry ?? info.sicDescription;
            if (exchanges.length === 0) {
              exchanges = info.exchanges;
            }
            category = category ?? info.category;
            if (formerNames.length === 0) {
              formerNames = info.formerNames;
            }
          } catch (err) {
            if (err instanceof SecBlockedError) {
              throw err; // fatal: stop the run instead of burning calls
            }
          }
        }
        const form = typeof row.form === "string" ? row.form : null;
        const filed = typeof row.filed === "string" ? new Date(row.filed) : null;

        await prisma.entity.upsert({
          where: { id },
          create: {
            id,
            name,
            type: "Company",
            industry,
            lat: 0, // placeholder — see pipeline.ts geocoding
            lng: 0,
            fundsVolume: row.val,
            rawAddressText: row.loc,
            businessAddress,
            tickers,
            source: "frames-api",
            conceptTag: frame.tag,
            secFilingNumber: row.accn,
            sourceTimeFrame: payload.ccp,
            financialDate: new Date(row.end),
            form,
            filed,
            exchanges,
            category,
            formerNames,
          },
          update: {
            name,
            type: "Company",
            industry,
            fundsVolume: row.val,
            rawAddressText: row.loc,
            businessAddress,
            tickers,
            source: "frames-api",
            conceptTag: frame.tag,
            secFilingNumber: row.accn,
            sourceTimeFrame: payload.ccp,
            financialDate: new Date(row.end),
            form,
            filed,
            exchanges,
            category,
            formerNames,
          },
        });
        upserted += 1;
        frameUpserted += 1;
        if (businessAddress) {
          withAddress += 1;
        }
        if ((i + 1) % 50 === 0 || i + 1 === rows.length) {
          console.log(
            `[ingest] ${frame.tag}: ${i + 1}/${rows.length} (upserted ${frameUpserted})`,
          );
        }
      }

      indexMembers += frameIndexRows;
      fetched += rows.length;
      frames.push({
        tag: frame.tag,
        fetched: rows.length,
        upserted: frameUpserted,
        indexMembers: frameIndexRows,
      });
    }

    return {
      frames,
      fetched,
      upserted,
      skipped,
      withAddress,
      pruned: pruned.count,
      indexMembers,
    };
  } finally {
    await prisma.$disconnect();
  }
}
