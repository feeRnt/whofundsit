import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// SEC EDGAR Frames API: one funding-relevant concept per frame, Q2 2026
// (last fully-filed quarter). Payloads are parsed in memory only — raw JSON is
// never written to disk (ground-rules §4).
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
];

// Hard ceiling per frame: never ingest more than this many rows per frame
// per run (ground-rules guardrail 1). Total rows <= frames x MAX_PER_FRAME.
const MAX_PER_FRAME = 500;

// SEC fair access asks for < 10 requests/second; 150 ms keeps us well under that.
const MIN_INTERVAL_MS = 150;

// Back off (never hammer) on rate limits and server errors.
const SEC_MAX_RETRIES = 3;

// TODO(SIC): type below is the placeholder "Company". The submissions payload
// already carries sicDescription — wire it in when the SIC TODO is picked up.
// See whofundsit/TODO.md.

interface SecFrameRow {
  accn: string; // SEC filing (accession) number validating this datapoint, e.g. "0001104659-19-016320"
  cik: number; // SEC Central Index Key -> part of Entity.id
  entityName: string; // -> Entity.name
  loc: string; // state code, e.g. "US-IL" -> Entity.rawAddressText
  end: string; // balance-sheet date, e.g. "2019-02-28" -> Entity.financialDate
  val: number; // -> Entity.fundsVolume
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
  addresses?: {
    business?: SecAddress | null;
    mailing?: SecAddress | null;
  } | null;
}

export interface FrameSummary {
  tag: string;
  fetched: number;
  upserted: number;
}

export interface IngestSummary {
  frames: FrameSummary[];
  fetched: number; // rows considered (<= frames x MAX_PER_FRAME)
  upserted: number; // rows written
  skipped: number; // malformed rows skipped (fetched = upserted + skipped)
  withAddress: number; // rows that also got a businessAddress
  pruned: number; // stale rows from other frames removed
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
  // SEC requires a declared User-Agent. Override via SEC_USER_AGENT if needed.
  return process.env.SEC_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";
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
async function fetchBusinessAddress(cik: number): Promise<string | null> {
  const padded = String(cik).padStart(10, "0");
  const data = await secGet<SecSubmissions>(`${SUBMISSIONS_URL}/CIK${padded}.json`);
  const addr = data.addresses?.business ?? data.addresses?.mailing ?? null;
  if (!addr) {
    return null;
  }
  const parts = [
    addr.street1,
    addr.street2,
    addr.city,
    addr.stateOrCountry,
    addr.zipCode,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
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
    const current = FRAMES.map((f) => f.ccp);
    const pruned = await prisma.entity.deleteMany({
      where: {
        OR: [{ sourceTimeFrame: null }, { sourceTimeFrame: { notIn: current } }],
      },
    });

    const frames: FrameSummary[] = [];
    let fetched = 0;
    let upserted = 0;
    let skipped = 0;
    let withAddress = 0;

    for (const frame of FRAMES) {
      const url = `${FRAME_API}/${frame.taxonomy}/${frame.tag}/${frame.uom}/${frame.ccp}.json`;
      const payload = await secGet<SecFramesPayload>(url);
      const rows = payload.data.slice(0, MAX_PER_FRAME);
      let frameUpserted = 0;

      for (const row of rows) {
        if (!row.entityName || !Number.isFinite(row.val) || !row.end) {
          skipped += 1;
          continue;
        }

        let businessAddress: string | null = null;
        try {
          businessAddress = await fetchBusinessAddress(row.cik);
        } catch (err) {
          if (err instanceof SecBlockedError) {
            throw err; // fatal: stop the run instead of burning calls
          }
          businessAddress = null;
        }

        await prisma.entity.upsert({
          where: { id: `${row.cik}:${frame.tag}` },
          create: {
            id: `${row.cik}:${frame.tag}`,
            name: row.entityName,
            type: "Company", // placeholder — see TODO(SIC) above
            lat: 0, // placeholder — see pipeline.ts geocoding
            lng: 0,
            fundsVolume: row.val,
            rawAddressText: row.loc,
            businessAddress,
            conceptTag: frame.tag,
            secFilingNumber: row.accn,
            sourceTimeFrame: payload.ccp,
            financialDate: new Date(row.end),
          },
          update: {
            name: row.entityName,
            fundsVolume: row.val,
            rawAddressText: row.loc,
            businessAddress,
            conceptTag: frame.tag,
            secFilingNumber: row.accn,
            sourceTimeFrame: payload.ccp,
            financialDate: new Date(row.end),
          },
        });
        upserted += 1;
        frameUpserted += 1;
        if (businessAddress) {
          withAddress += 1;
        }
      }

      fetched += rows.length;
      frames.push({ tag: frame.tag, fetched: rows.length, upserted: frameUpserted });
    }

    return { frames, fetched, upserted, skipped, withAddress, pruned: pruned.count };
  } finally {
    await prisma.$disconnect();
  }
}
