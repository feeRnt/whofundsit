import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// SEC EDGAR Frames API: Accounts Payable (us-gaap) in USD, instant frame CY2019Q1.
// Payload is parsed in memory only — raw JSON is never written to disk (ground-rules §4).
const FRAME_URL =
  "https://data.sec.gov/api/xbrl/frames/us-gaap/AccountsPayableCurrent/USD/CY2019Q1I.json";

// Hard ceiling: never ingest more than this many rows per run (ground-rules guardrail 1).
const MAX_RECORDS = 500;

// SEC fair access asks for < 10 requests/second; 150 ms keeps us well under that.
const MIN_INTERVAL_MS = 150;

// TODO(SIC): type below is the placeholder "Company". SEC Frames carries no SIC/industry —
// enrich Entity.type later from the SEC submissions API (sicDescription). See whofundsit/TODO.md.
// TODO(GEO): lat/lng are 0 placeholders and rawAddressText holds only the Frames state code
// (e.g. "US-IL"). Real flow: business address per CIK -> Nominatim/OpenStreetMap -> lat/lng.

interface SecFrameRow {
  accn: string; // SEC filing (accession) number validating this datapoint, e.g. "0001104659-19-016320"
  cik: number; // SEC Central Index Key -> Entity.id
  entityName: string; // -> Entity.name
  loc: string; // state code, e.g. "US-IL" -> Entity.rawAddressText
  end: string; // balance-sheet date, e.g. "2019-02-28" -> Entity.financialDate
  val: number; // -> Entity.fundsVolume
}

interface SecFramesPayload {
  taxonomy: string; // "us-gaap"
  tag: string; // "AccountsPayableCurrent"
  ccp: string; // frame, e.g. "CY2019Q1I" -> Entity.sourceTimeFrame
  uom: string; // "USD"
  data: SecFrameRow[];
}

export interface IngestSummary {
  sourceTimeFrame: string;
  fetched: number; // rows considered (<= MAX_RECORDS)
  upserted: number; // rows written
  skipped: number; // malformed rows skipped (fetched = upserted + skipped)
}

// Minimal in-memory rate limiter gating the outbound SEC call (ground-rules guardrail 2):
// one outbound request at a time, spaced by at least MIN_INTERVAL_MS.
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

/**
 * Fetch one SEC Frames payload and upsert Entities from its `data` array.
 * Idempotent: safe to re-run — rows upsert by String(cik) id.
 * Requires DATABASE_URL (read from backend/.env); throws without writing if unset.
 */
export async function ingestSecFrames(): Promise<IngestSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  await throttle();
  let payload: SecFramesPayload;
  try {
    const response = await axios.get<SecFramesPayload>(FRAME_URL, {
      headers: {
        // SEC requires a declared User-Agent. Override via SEC_USER_AGENT if needed.
        "User-Agent":
          process.env.SEC_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)",
        Accept: "application/json",
      },
    });
    payload = response.data;
  } finally {
    throttleDone();
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = payload.data.slice(0, MAX_RECORDS);
    let upserted = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.entityName || !Number.isFinite(row.val) || !row.end) {
        skipped += 1;
        continue;
      }

      await prisma.entity.upsert({
        where: { id: String(row.cik) },
        create: {
          id: String(row.cik),
          name: row.entityName,
          type: "Company", // placeholder — see TODO(SIC) above
          lat: 0, // placeholder — see TODO(GEO) above
          lng: 0,
          fundsVolume: row.val,
          rawAddressText: row.loc,
          secFilingNumber: row.accn,
          sourceTimeFrame: payload.ccp,
          financialDate: new Date(row.end),
        },
        update: {
          name: row.entityName,
          fundsVolume: row.val,
          rawAddressText: row.loc,
          secFilingNumber: row.accn,
          sourceTimeFrame: payload.ccp,
          financialDate: new Date(row.end),
        },
      });
      upserted += 1;
    }

    return { sourceTimeFrame: payload.ccp, fetched: rows.length, upserted, skipped };
  } finally {
    await prisma.$disconnect();
  }
}
