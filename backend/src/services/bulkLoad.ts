import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import * as unzipper from "unzipper";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readCache, writeCache } from "./httpCache.js";

// Bulk base layer: SEC nightly ZIPs parsed locally. Run on good wifi
// (`npm run bulk`), then use `npm run ingest` (frames API) for incremental
// additions. ZIP layout and both JSON shapes were verified against live SEC
// responses (HEAD + Range + aborted-stream peeks, KBs total); the full
// multi-GB download itself is still untested and needs good wifi.

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "..", "data");

const SUBMISSIONS_ZIP_URL =
  "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip";
const COMPANYFACTS_ZIP_URL =
  "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip";

// How far back bulk facts reach (years). One-line change to narrow/widen.
const BULK_YEARS = 2;

// Concepts mirror the frames-API ingest so rows stay comparable.
const TAGS = ["StockholdersEquity", "LongTermDebt", "Assets"] as const;

// Hard ceiling per bulk run (ground-rules guardrail 1).
const MAX_BULK_ROWS = 20000;

function userAgent(): string {
  return process.env.SEC_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";
}

export interface BulkSummary {
  entries: number; // zip entries streamed
  considered: number; // facts inside the date window
  upserted: number; // rows written (<= MAX_BULK_ROWS)
  skipped: number; // malformed or out-of-window rows
  withAddress: number; // rows joined to a submissions address
}

async function ensureArchive(name: string, url: string): Promise<string> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = path.join(DATA_DIR, name);
  if (fs.existsSync(dest) && !process.env.BULK_REFRESH) {
    const mb = fs.statSync(dest).size / 1e6;
    console.log(
      `[bulk] reusing ${name} (${mb.toFixed(0)} MB); set BULK_REFRESH=1 to re-download`,
    );
    return dest;
  }
  console.log(`[bulk] downloading ${name} (submissions is ~1.6 GB)...`);
  const headers = {
    "User-Agent": userAgent(),
    Accept: "application/zip",
    "Accept-Encoding": "gzip, deflate",
  };
  // Verified live: both ZIPs HEAD 200 as application/zip with Content-Length
  // (submissions 1,572,128,284 B; companyfacts 1,414,913,699 B) and no auth
  // wall. The length check below turns a truncated stream into a loud retry
  // error instead of a silently corrupt archive.
  const head = await axios.head(url, { headers });
  const expected = Number(head.headers["content-length"]);
  const response = await axios({ url, method: "GET", responseType: "stream", headers });
  await pipeline(response.data, fs.createWriteStream(`${dest}.part`));
  const actual = fs.statSync(`${dest}.part`).size;
  if (Number.isFinite(expected) && expected > 0 && actual !== expected) {
    fs.rmSync(`${dest}.part`);
    throw new Error(
      `[bulk] truncated download: ${name} got ${actual}B, expected ${expected}B — retry with BULK_REFRESH=1`,
    );
  }
  fs.renameSync(`${dest}.part`, dest);
  return dest;
}

interface ZipJson {
  name: string;
  json: unknown;
}

// Entry layout verified live via Range probes: flat per-CIK files, e.g.
// submissions.zip -> "CIK0000004926.json", companyfacts.zip ->
// "CIK0000001750.json". Parsed as one sequential stream: random access did
// ~800 docs/s on the 1M-entry archive; streaming is an order of magnitude
// faster. Samples still log as a tripwire. Sidecar "-submissions-*.json"
// entries carry filings only (no cik) and are skipped by callers.
export async function* jsonEntries(zipPath: string): AsyncGenerator<ZipJson> {
  // Pull-based: Parse() emits 'entry' events (nothing reaches the readable
  // side, so for-await sees zero entries). The source stays paused while an
  // entry is handled, so a slow consumer (DB upserts) can't buffer the
  // archive in memory.
  interface RawEntry {
    path: string;
    type: string;
    autodrain: () => void;
    buffer: () => Promise<Buffer>;
  }
  const source = fs.createReadStream(zipPath);
  const parser = source.pipe(unzipper.Parse());
  const pending: RawEntry[] = [];
  let done = false;
  let failure: unknown = null;
  let notify: (() => void) | null = null;
  const wake = (): void => {
    const next = notify;
    notify = null;
    next?.();
  };
  parser.on("entry", (entry: RawEntry) => {
    source.pause();
    pending.push(entry);
    wake();
  });
  parser.on("close", () => {
    done = true;
    wake();
  });
  parser.on("error", (err: unknown) => {
    failure = err;
    done = true;
    wake();
  });

  const samples: string[] = [];
  let count = 0;
  let parseErrors = 0;
  try {
    for (;;) {
      while (pending.length === 0 && !done) {
        source.resume();
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const entry = pending.shift();
      if (!entry) {
        break;
      }
      if (entry.type !== "File" || !entry.path.endsWith(".json")) {
        entry.autodrain();
        continue;
      }
      if (samples.length < 3) {
        samples.push(entry.path);
        if (samples.length === 3) {
          console.log(
            `[bulk] ${path.basename(zipPath)} streaming, e.g. ${samples.join(", ")}`,
          );
        }
      }
      try {
        const buf: Buffer = await entry.buffer();
        const json: unknown = JSON.parse(buf.toString("utf8"));
        count += 1;
        yield { name: entry.path, json };
      } catch {
        parseErrors += 1;
        if (parseErrors <= 3) {
          console.log(`[bulk] unparsable entry skipped: ${entry.path}`);
        }
      }
    }
  } finally {
    source.destroy();
  }
  if (failure) {
    throw failure;
  }
  console.log(
    `[bulk] ${path.basename(zipPath)}: ${count} json entries streamed` +
      (parseErrors > 0 ? ` (${parseErrors} unparsable skipped)` : ""),
  );
}

interface BulkAddress {
  address: string | null;
  state: string | null;
  tickers: string[];
}

function joinAddress(addr: {
  street1?: unknown;
  street2?: unknown;
  city?: unknown;
  stateOrCountry?: unknown;
  zipCode?: unknown;
}): string | null {
  const parts = [addr.street1, addr.street2, addr.city, addr.stateOrCountry, addr.zipCode].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

// Submissions shape verified live against data.sec.gov: {cik, tickers[],
// addresses: {business, mailing}}. Note cik is a zero-padded STRING
// ("0000320193"), unlike companyfacts' number — both are accepted.
const ADDRESS_MAP_CACHE = "sec/address-map.json";

async function loadAddressMap(zipPath: string): Promise<Map<number, BulkAddress>> {
  const hit = readCache<Record<string, BulkAddress>>(ADDRESS_MAP_CACHE);
  if (hit !== undefined) {
    const cached = new Map<number, BulkAddress>();
    for (const [cik, addr] of Object.entries(hit)) {
      cached.set(Number(cik), addr);
    }
    console.log(`[bulk] addresses: ${cached.size} companies (from disk cache)`);
    return cached;
  }
  const map = new Map<number, BulkAddress>();
  let n = 0;
  for await (const { json } of jsonEntries(zipPath)) {
    const doc = json as {
      cik?: unknown;
      tickers?: unknown;
      addresses?: {
        business?: Record<string, unknown> | null;
        mailing?: Record<string, unknown> | null;
      } | null;
    };
    const cik = typeof doc.cik === "string" ? Number(doc.cik) : doc.cik;
    if (typeof cik !== "number" || !Number.isFinite(cik)) {
      continue;
    }
    const business = doc.addresses?.business ?? doc.addresses?.mailing ?? null;
    const state = business?.stateOrCountry;
    map.set(cik, {
      address: business ? joinAddress(business) : null,
      state: typeof state === "string" ? state : null,
      tickers: Array.isArray(doc.tickers)
        ? doc.tickers.filter((t): t is string => typeof t === "string")
        : [],
    });
    n += 1;
    if (n % 2000 === 0) {
      console.log(`[bulk] addresses: ${n}...`);
    }
  }
  const dump: Record<string, BulkAddress> = {};
  for (const [cik, addr] of map) {
    dump[String(cik)] = addr;
  }
  writeCache(ADDRESS_MAP_CACHE, dump);
  console.log(`[bulk] addresses: ${map.size} companies (saved to disk cache)`);
  return map;
}

interface BulkFact {
  end?: unknown;
  val?: unknown;
  accn?: unknown;
  frame?: unknown;
}

// Companyfacts shape verified live: {cik (number), entityName, facts:
// {taxonomy: {tag: {units: {uom: [{end, val, accn, frame?}]}}}}}. `frame` is
// present on most facts but missing on some (e.g. FY 10-K), so the "BULK"
// fallback stays.
async function loadFacts(
  zipPath: string,
  addresses: Map<number, BulkAddress>,
  prisma: PrismaClient,
): Promise<Omit<BulkSummary, "entries">> {
  const cutoff = Date.now() - BULK_YEARS * 365.25 * 24 * 3600 * 1000;
  let considered = 0;
  let upserted = 0;
  let skipped = 0;
  let withAddress = 0;
  let entries = 0;
  // Upserts fly N at a time: sequential round trips dominated the old runtime.
  // The ceiling counts scheduled rows, so it can never overshoot.
  const UPSERT_CONCURRENCY = 8;
  let scheduled = 0;
  let batch: Promise<void>[] = [];

  for await (const { json } of jsonEntries(zipPath)) {
    entries += 1;
    const doc = json as {
      cik?: unknown;
      entityName?: unknown;
      facts?: Record<string, Record<string, { units?: Record<string, BulkFact[]> }>>;
    };
    if (typeof doc.cik !== "number" || typeof doc.entityName !== "string") {
      skipped += 1;
      continue;
    }
    const gaap = doc.facts?.["us-gaap"];
    if (!gaap) {
      continue;
    }
    for (const tag of TAGS) {
      const points = gaap[tag]?.units?.["USD"] ?? [];
      const inWindow = points.filter(
        (p) =>
          typeof p.end === "string" &&
          typeof p.val === "number" &&
          Number.isFinite(p.val) &&
          new Date(p.end).getTime() >= cutoff,
      );
      if (inWindow.length === 0) {
        continue;
      }
      // Latest fact in window wins (snapshot semantics, like frames).
      inWindow.sort((a, b) => (a.end as string).localeCompare(b.end as string));
      const fact = inWindow[inWindow.length - 1];
      considered += 1;

      const info = addresses.get(doc.cik);
      const state = info?.state ?? null;
      const id = `${doc.cik}:${tag}`;
      const hasAddress = !!info?.address;
      batch.push(
        prisma.entity
          .upsert({
            where: { id },
            create: {
              id,
              name: doc.entityName,
              type: "Company",
              lat: 0,
              lng: 0,
              fundsVolume: fact.val as number,
              rawAddressText:
                state && state.length === 2 ? `US-${state}` : (state ?? "—"),
              businessAddress: info?.address ?? null,
              conceptTag: tag,
              tickers: info?.tickers ?? [],
              secFilingNumber: typeof fact.accn === "string" ? fact.accn : null,
              sourceTimeFrame: typeof fact.frame === "string" ? fact.frame : "BULK",
              financialDate: new Date(fact.end as string),
              source: "bulk-zip",
            },
            update: {
              name: doc.entityName,
              fundsVolume: fact.val as number,
              rawAddressText:
                state && state.length === 2 ? `US-${state}` : (state ?? "—"),
              businessAddress: info?.address ?? null,
              conceptTag: tag,
              tickers: info?.tickers ?? [],
              secFilingNumber: typeof fact.accn === "string" ? fact.accn : null,
              sourceTimeFrame: typeof fact.frame === "string" ? fact.frame : "BULK",
              financialDate: new Date(fact.end as string),
              source: "bulk-zip",
            },
          })
          .then(() => {
            upserted += 1;
            if (hasAddress) {
              withAddress += 1;
            }
          }),
      );
      scheduled += 1;
      if (batch.length >= UPSERT_CONCURRENCY) {
        await Promise.all(batch);
        batch = [];
      }
      if (scheduled >= MAX_BULK_ROWS) {
        console.log(`[bulk] row ceiling hit (${MAX_BULK_ROWS}); stopping`);
        await Promise.all(batch);
        return { considered, upserted, skipped, withAddress };
      }
    }
    if (entries % 1000 === 0) {
      console.log(`[bulk] facts: ${entries} entries, ${upserted} rows...`);
    }
  }
  await Promise.all(batch);
  return { considered, upserted, skipped, withAddress };
}

/**
 * Bulk base layer: download both nightly ZIPs once (skipped when present),
 * stream per-CIK entries, keep facts inside the BULK_YEARS window, and upsert
 * rows tagged source "bulk-zip". No index prioritization here by design: bulk
 * is full coverage, so members-first sorting would be pointless — the frames
 * API path (`npm run ingest`) keeps it for incremental top-ups.
 */
export async function runBulkLoad(): Promise<BulkSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const submissionsZip = await ensureArchive("submissions.zip", SUBMISSIONS_ZIP_URL);
    const factsZip = await ensureArchive("companyfacts.zip", COMPANYFACTS_ZIP_URL);
    const addresses = await loadAddressMap(submissionsZip);
    const { considered, upserted, skipped, withAddress } = await loadFacts(
      factsZip,
      addresses,
      prisma,
    );
    return { entries: addresses.size, considered, upserted, skipped, withAddress };
  } finally {
    await prisma.$disconnect();
  }
}
