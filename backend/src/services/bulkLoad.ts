import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
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
const TAGS = [
  "StockholdersEquity",
  "LongTermDebt",
  "Assets",
  "Revenues",
  "NetIncomeLoss",
] as const;

// Hard ceiling per bulk run (ground-rules guardrail 1).
const MAX_BULK_ROWS = 20000;

// Optional testing cap: stop scanning entries after this many (both phases
// honor it; the row ceiling still applies). Unset = full scan. Capped runs
// never write the address-map cache (a partial map must not poison it).
const BULK_MAX_ENTRIES = Math.max(0, Number(process.env.BULK_MAX_ENTRIES ?? 0));

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
// "CIK0000001750.json". Parsed sequentially with yauzl's lazyEntries: true
// pull iteration (one entry at a time, nothing buffered ahead), which the
// old random-access reads (~800 docs/s) and event-stream hacks couldn't do
// safely. Samples still log as a tripwire. Sidecar "-submissions-*.json"
// entries carry filings only (no cik) and are skipped by callers.
function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error(`[bulk] cannot open ${zipPath}`));
      } else {
        resolve(zipfile);
      }
    });
  });
}

function nextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zipfile.removeListener("entry", onEntry);
      zipfile.removeListener("end", onEnd);
      zipfile.removeListener("error", onError);
    };
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    zipfile.once("entry", onEntry);
    zipfile.once("end", onEnd);
    zipfile.once("error", onError);
    zipfile.readEntry();
  });
}

function entryBuffer(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error(`[bulk] cannot read ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => resolve(Buffer.concat(chunks)));
      stream.once("error", reject);
    });
  });
}

export async function* jsonEntries(zipPath: string): AsyncGenerator<ZipJson> {
  const zipfile = await openZip(zipPath);
  const samples: string[] = [];
  let count = 0;
  let parseErrors = 0;
  try {
    for (;;) {
      const entry = await nextEntry(zipfile);
      if (!entry) {
        break;
      }
      const name = entry.fileName;
      if (name.endsWith("/") || !name.endsWith(".json")) {
        continue;
      }
      if (samples.length < 3) {
        samples.push(name);
        if (samples.length === 3) {
          console.log(
            `[bulk] ${path.basename(zipPath)} streaming, e.g. ${samples.join(", ")}`,
          );
        }
      }
      try {
        const buf = await entryBuffer(zipfile, entry);
        const json: unknown = JSON.parse(buf.toString("utf8"));
        count += 1;
        yield { name, json };
      } catch {
        parseErrors += 1;
        if (parseErrors <= 3) {
          console.log(`[bulk] unparsable entry skipped: ${name}`);
        }
      }
    }
  } finally {
    zipfile.close();
  }
  console.log(
    `[bulk] ${path.basename(zipPath)}: ${count} json entries streamed` +
      (parseErrors > 0 ? ` (${parseErrors} unparsable skipped)` : ""),
  );
}

export interface BulkAddress {
  address: string | null;
  // Legal filer name from submissions ("EXXON MOBIL CORP"), unflattened.
  name: string | null;
  state: string | null;
  tickers: string[];
  exchanges: string[];
  category: string | null;
  formerNames: string[];
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
// v2: carries exchanges/category/formerNames (v1 rows lack them).

// Industry text from a submissions doc: sicDescription wins ("Metal Mining"
// beats "1000"). Empty when the filer never filed one. Pure + unit-tested.
export function extractSic(doc: {
  sic?: unknown;
  sicDescription?: unknown;
}): string | null {
  if (typeof doc.sicDescription === "string" && doc.sicDescription.length > 0) {
    return doc.sicDescription;
  }
  if (typeof doc.sic === "string" && doc.sic.length > 0) {
    return doc.sic;
  }
  return null;
}

export const ADDRESS_MAP_CACHE = "sec/address-map-v3.json";
const ADDRESS_MAP_CACHE_LEGACY = "sec/address-map-v2.json";

// Short map label for an SEC address: US-ST for real two-letter states;
// the trailing city + postcode for foreign filers (their stateOrCountry is
// a letter-digit code like X0, never a US state). "—" only when there is no
// address at all. Pure + unit-tested.
export function locationTag(
  state: string | null,
  address: string | null | undefined,
): string {
  if (state && /^[A-Z]{2}$/.test(state)) {
    return `US-${state}`;
  }
  if (address) {
    const parts = address
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !/^[A-Z]\d$/.test(p));
    if (parts.length > 0) {
      return parts.slice(-2).join(", ");
    }
  }
  return "—";
}

// v3 adds filer names; v2 entries still serve addresses until rebuilt.
export function readAddressMap(): Record<string, BulkAddress> | undefined {
  return (
    readCache<Record<string, BulkAddress>>(ADDRESS_MAP_CACHE) ??
    readCache<Record<string, BulkAddress>>(ADDRESS_MAP_CACHE_LEGACY)
  );
}

async function loadAddressMap(zipPath: string): Promise<Map<number, BulkAddress>> {
  const hit = readAddressMap();
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
      name?: unknown;
      tickers?: unknown;
      exchanges?: unknown;
      category?: unknown;
      formerNames?: unknown;
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
      name:
        typeof doc.name === "string" && doc.name.length > 0 ? doc.name : null,
      state: typeof state === "string" ? state : null,
      tickers: Array.isArray(doc.tickers)
        ? doc.tickers.filter((t): t is string => typeof t === "string")
        : [],
      exchanges: Array.isArray(doc.exchanges)
        ? doc.exchanges.filter((t): t is string => typeof t === "string")
        : [],
      category:
        typeof doc.category === "string" && doc.category.length > 0
          ? doc.category
          : null,
      formerNames: Array.isArray(doc.formerNames)
        ? doc.formerNames
            .map((f) => (f as { name?: unknown })?.name)
            .filter((n): n is string => typeof n === "string" && n.length > 0)
        : [],
    });
    n += 1;
    if (n % 2000 === 0) {
      console.log(`[bulk] addresses: ${n}...`);
    }
    if (BULK_MAX_ENTRIES > 0 && n >= BULK_MAX_ENTRIES) {
      console.log(`[bulk] entry cap hit (${BULK_MAX_ENTRIES}); stopping scan`);
      break;
    }
  }
  if (BULK_MAX_ENTRIES <= 0) {
    const dump: Record<string, BulkAddress> = {};
    for (const [cik, addr] of map) {
      dump[String(cik)] = addr;
    }
    writeCache(ADDRESS_MAP_CACHE, dump);
    console.log(`[bulk] addresses: ${map.size} companies (saved to disk cache)`);
  } else {
    console.log(`[bulk] addresses: ${map.size} companies (capped; cache untouched)`);
  }
  return map;
}

interface BulkFact {
  end?: unknown;
  val?: unknown;
  accn?: unknown;
  frame?: unknown;
  form?: unknown;
  filed?: unknown;
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
    if (BULK_MAX_ENTRIES > 0 && entries > BULK_MAX_ENTRIES) {
      console.log(`[bulk] entry cap hit (${BULK_MAX_ENTRIES}); stopping scan`);
      break;
    }
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
      const form = typeof fact.form === "string" ? fact.form : null;
      const filed =
        typeof fact.filed === "string" ? new Date(fact.filed) : null;
      const hasAddress = !!info?.address;
      batch.push(
        prisma.entity
          .upsert({
            where: { id },
            create: {
              id,
              name: info?.name ?? doc.entityName,
              type: "Company",
              lat: 0,
              lng: 0,
              fundsVolume: fact.val as number,
              rawAddressText: locationTag(state, info?.address),
              businessAddress: info?.address ?? null,
              conceptTag: tag,
              tickers: info?.tickers ?? [],
              secFilingNumber: typeof fact.accn === "string" ? fact.accn : null,
              sourceTimeFrame: typeof fact.frame === "string" ? fact.frame : "BULK",
              financialDate: new Date(fact.end as string),
              source: "bulk-zip",
              form,
              filed,
              exchanges: info?.exchanges ?? [],
              category: info?.category ?? null,
              formerNames: info?.formerNames ?? [],
            },
            update: {
              name: info?.name ?? doc.entityName,
              fundsVolume: fact.val as number,
              rawAddressText: locationTag(state, info?.address),
              businessAddress: info?.address ?? null,
              conceptTag: tag,
              tickers: info?.tickers ?? [],
              secFilingNumber: typeof fact.accn === "string" ? fact.accn : null,
              sourceTimeFrame: typeof fact.frame === "string" ? fact.frame : "BULK",
              financialDate: new Date(fact.end as string),
              source: "bulk-zip",
              form,
              filed,
              exchanges: info?.exchanges ?? [],
              category: info?.category ?? null,
              formerNames: info?.formerNames ?? [],
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
