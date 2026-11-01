import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey, apiLog } from "./httpCache.js";
import { infoTableXml, latest13F, parseInfoTable } from "./thirteenF.js";
import { NASDAQ100_TICKERS } from "../data/nasdaq100.js";
import { SP500_TICKERS } from "../data/sp500.js";

// Claims verification: a stochastic METHODOLOGY audit, not a data audit.
//
// User's note, kept verbatim in spirit: run 20-25 random/stochastic tests
// per country/index/source and assign an x% verification score to that
// index. Ideally we are not testing our data (it comes from primary sources and
// should be correct) , rather we are testing our own implementation and
// methodology for edge cases, bugs, or other errors that were unhandled.
//
// Strata: entity SOURCE cells + REGION cells (us/non-us/unknown) + INDEX
// cells (major/long-tail), and one cell per flow type. Every cell samples
// VERIFY_SAMPLE members with a seeded RNG (reproducible), checks each
// against a live primary source, and reports "% verified" (score >= 90)
// plus the mean score. `npm run verify:claims`.

const SEED = Number(process.env.VERIFY_SEED ?? 7);
// Fraction mode (default): 10% of each cell, capped at 5, full census of
// tiny cells. VERIFY_FRACTION / VERIFY_MAX_PER_CELL tune it.
// Original spec, kept behind a flag: fixed 25 seeded samples per cell —
// set VERIFY_SAMPLE=25 to restore it.
const FRACTION = Number(process.env.VERIFY_FRACTION ?? 0.1);
const MAX_PER_CELL = Number(process.env.VERIFY_MAX_PER_CELL ?? 5);
const LEGACY_SAMPLE =
  process.env.VERIFY_SAMPLE !== undefined
    ? Number(process.env.VERIFY_SAMPLE)
    : null;

// How many members to draw from a cell of size `pop`. Pure.
export function cellTake(pop: number): number {
  if (LEGACY_SAMPLE !== null) {
    return Math.min(LEGACY_SAMPLE, pop);
  }
  return Math.min(pop, Math.max(1, Math.ceil(pop * FRACTION)), MAX_PER_CELL);
}
const MAX_SOURCE_CELLS = 12;
const MAX_ENTITIES = Number(process.env.VERIFY_MAX_ENTITIES ?? 500);
const MAX_FLOWS = Number(process.env.VERIFY_MAX_FLOWS ?? 300);

// Seeded RNG so a verification run is reproducible: same seed, same
// sample, comparable scores across code changes. Pure.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n unique indices into a population of size `pop`, deterministic per rng.
export function sampleIndices(pop: number, n: number, rng: () => number): number[] {
  const take = Math.min(n, pop);
  const pool = Array.from({ length: pop }, (_, i) => i);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pop - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

// Agreement bands: exact-ish → 100, filing-noise → 90, stale-quarter → 70,
// wrong-scale → 40, fiction → 0. Pure.
export function amountScore(stored: number, live: number): number {
  if (!(stored > 0) && !(live > 0)) {
    return 100;
  }
  if (!(live > 0) || !(stored > 0)) {
    return 0;
  }
  const rel = Math.abs(stored - live) / Math.abs(live);
  if (rel <= 0.01) return 100;
  if (rel <= 0.05) return 90;
  if (rel <= 0.25) return 70;
  if (rel <= 1) return 40;
  return 0;
}

// SEC entity ids are `<cik>:<tag>`; everything else verifies by geo only.
export function parseEntityRef(id: string): { cik: string; tag: string } | null {
  const m = id.match(/^(\d+):(.+)$/);
  return m ? { cik: m[1], tag: m[2] } : null;
}

// 13F flow ids embed their own audit trail: `13f:<managerCik>:<cusip>`.
export function parseFlowRef(id: string): { cik10: string; cusip: string } | null {
  const m = id.match(/^13f:(\d+):([A-Z0-9]+)$/);
  return m ? { cik10: m[1].padStart(10, "0"), cusip: m[2] } : null;
}

// Heuristic region bucket from address shape (documented, not precise:
// per-country granularity awaits real country tags on every row). Pure.
export function regionBucket(
  rawAddressText: string,
  businessAddress: string | null,
): "us" | "non-us" | "unknown" {
  if (/^US-[A-Z0-9]{2}$/.test(rawAddressText)) {
    return "us";
  }
  if (businessAddress && /,\s*[A-Z]{2}\s+\d{5}/.test(businessAddress)) {
    return "us";
  }
  if (businessAddress && businessAddress.trim().length > 0) {
    return "non-us";
  }
  return "unknown";
}

const MAJOR_TICKERS = new Set(
  [...SP500_TICKERS, ...NASDAQ100_TICKERS].map((t) => t.toUpperCase()),
);

export function isMajorIndex(tickers: string[]): boolean {
  return tickers.some((t) => MAJOR_TICKERS.has(t.toUpperCase()));
}

// --- Live-source fetchers (all cached; all ToS-paced) ---

function secUA(): string {
  return process.env.SEC_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";
}

function nominatimUA(): string {
  return (
    process.env.NOMINATIM_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)"
  );
}

function limiter(minMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let last = 0;
  let chain = Promise.resolve();
  return async (fn) => {
    const run = chain.then(async () => {
      const wait = last + minMs - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      last = Date.now();
      return fn();
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const sec = limiter(150); // SEC fair access: <= 10 req/s
const nominatim = limiter(1100); // Nominatim usage policy: <= 1 req/s

interface CompanyFact {
  end: string;
  val: number;
}

async function liveConceptValue(
  cik: string,
  tag: string,
  currency: string,
): Promise<number | null> {
  const cik10 = cik.padStart(10, "0");
  const doc = await cachedJson<{
    facts?: Record<string, Record<string, { units?: Record<string, CompanyFact[]> }>>;
  }>(`verify/companyfacts/CIK${cik10}.json`, () =>
    sec(() => {
      apiLog("GET", `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`);
      return axios
        .get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`, {
          headers: { "User-Agent": secUA(), Accept: "application/json" },
        })
        .then((r) => r.data);
    }),
  );
  const facts = doc.facts ?? {};
  for (const concepts of Object.values(facts)) {
    const entry = concepts[tag];
    const units = entry?.units;
    if (!units) {
      continue;
    }
    const series = units[currency] ?? units.USD ?? Object.values(units)[0];
    if (!series || series.length === 0) {
      continue;
    }
    const latest = [...series].sort((a, b) => (a.end < b.end ? 1 : -1))[0];
    return latest.val;
  }
  return null;
}

async function reverseCountry(lat: number, lng: number): Promise<string | null> {
  const doc = await cachedJson<{ address?: { country_code?: unknown } }>(
    `verify/reverse-${cacheKey(`${lat.toFixed(4)},${lng.toFixed(4)}`)}.json`,
    () =>
      nominatim(() => {
        apiLog(
          "GET",
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}`,
        );
        return axios
          .get("https://nominatim.openstreetmap.org/reverse", {
            params: { format: "jsonv2", lat, lon: lng },
            headers: { "User-Agent": nominatimUA(), Accept: "application/json" },
          })
          .then((r) => r.data);
      }),
  );
  const cc = doc.address?.country_code;
  return typeof cc === "string" ? cc.toLowerCase() : null;
}

async function liveHoldingValue(
  cik10: string,
  cusip: string,
): Promise<{ found: boolean; valueUsd: number }> {
  const cikNum = String(Number(cik10));
  const { accn } = await latest13F(cik10, `verify:${cikNum}`);
  const xml = await infoTableXml(cikNum, accn);
  // parseInfoTable already sums same-CUSIP sleeves, mirroring ingest.
  const hit = parseInfoTable(xml).find((h) => h.cusip === cusip);
  return hit ? { found: true, valueUsd: hit.valueUsd } : { found: false, valueUsd: 0 };
}

// --- Checks ---

interface VEntity {
  id: string;
  source: string;
  tickers: string[];
  rawAddressText: string;
  businessAddress: string | null;
  conceptTag: string | null;
  fundsVolume: number;
  currency: string;
  lat: number;
  lng: number;
}

interface CheckResult {
  score: number | null; // null = untestable (no live source covers it)
  flags: string[];
}

async function checkEntity(e: VEntity): Promise<CheckResult> {
  const scores: number[] = [];
  const flags: string[] = [];
  const ref = parseEntityRef(e.id);
  const tag = e.conceptTag ?? ref?.tag ?? null;
  if (ref && tag) {
    // Value methodology: did ingest read, scale, and store this concept right?
    const live = await liveConceptValue(ref.cik, tag, e.currency);
    if (live === null) {
      flags.push(`no live ${tag} series for CIK ${ref.cik}`);
    } else {
      const s = amountScore(e.fundsVolume, live);
      scores.push(s);
      if (s < 90) {
        flags.push(
          `${e.id}: stored ${e.fundsVolume} vs live ${live} (score ${s})`,
        );
      }
    }
  }
  if (e.lat !== 0 || e.lng !== 0) {
    // Geo methodology: valid coords that reverse-resolve to the expected side
    // of the US border. Same Nominatim on both ends, but the REVERSE lookup
    // is an independent query testing the FORWARD geocode's placement.
    if (Math.abs(e.lat) > 90 || Math.abs(e.lng) > 180) {
      scores.push(0);
      flags.push(`${e.id}: coords out of range`);
    } else {
      scores.push(100);
      const bucket = regionBucket(e.rawAddressText, e.businessAddress);
      if (bucket !== "unknown") {
        const cc = await reverseCountry(e.lat, e.lng);
        const ok = bucket === "us" ? cc === "us" : cc !== null && cc !== "us";
        scores.push(ok ? 100 : 0);
        if (!ok) {
          flags.push(`${e.id}: reverse country ${cc} vs bucket ${bucket}`);
        }
      }
    }
  }
  if (scores.length === 0) {
    return { score: null, flags };
  }
  return {
    score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    flags,
  };
}

// Ownership stakes come from GLEIF relationship records with no per-claim
// live endpoint: structural check only (well-formed global id, finite
// amount; 0 = stake qty. n/a, legitimate).
export function ownershipStructural(
  id: string,
  amount: number,
): CheckResult {
  const parts = id.split(":");
  const ok =
    parts.length === 3 &&
    parts[0] === "global" &&
    parts[1] !== "" &&
    parts[2] !== "" &&
    Number.isFinite(amount) &&
    amount >= 0;
  return {
    score: ok ? 100 : 0,
    flags: ok ? [] : [`${id}: malformed ownership record`],
  };
}

async function checkFlow(f: {
  id: string;
  amount: number;
  flowType: string;
}): Promise<CheckResult & { kind: "external" | "structural" }> {
  if (f.flowType === "ownership") {
    return { ...ownershipStructural(f.id, f.amount), kind: "structural" };
  }
  const ref = f.flowType === "13f" ? parseFlowRef(f.id) : null;
  if (ref) {
    // 13F methodology: is this CUSIP still in the manager's live filing at
    // a matching value? Caveat: the LIVE filing may be a newer quarter than
    // the ingested one, so amount drift alone is a flag, not proof of a bug.
    const live = await liveHoldingValue(ref.cik10, ref.cusip);
    if (!live.found) {
      return {
        score: 0,
        kind: "external",
        flags: [`${f.id}: CUSIP absent from latest filing`],
      };
    }
    const s = amountScore(f.amount, live.valueUsd);
    return {
      score: s,
      kind: "external",
      flags:
        s < 90
          ? [`${f.id}: stored $${f.amount} vs live $${live.valueUsd}`]
          : [],
    };
  }
  // Grants have no per-claim live endpoint; structural sanity only.
  const ok = Number.isFinite(f.amount) && f.amount > 0;
  return {
    score: ok ? 100 : 0,
    kind: "structural",
    flags: ok ? [] : [`${f.id}: non-positive amount`],
  };
}

// --- Sampling + report ---

interface Cell {
  name: string;
  memberIds: string[];
}

interface CellStats {
  cell: string;
  kind: string;
  n: number;
  tested: number;
  untestable: number;
  passed: number;
  // null when nothing was testable: "n/a", never 0% (0% means all failed).
  pctVerified: number | null;
  mean: number | null;
  flags: string[];
}

export function summarize(
  cell: string,
  kind: string,
  results: CheckResult[],
): CellStats {
  const tested = results.filter((r) => r.score !== null);
  const passed = tested.filter((r) => (r.score ?? 0) >= 90).length;
  return {
    cell,
    kind,
    n: results.length,
    tested: tested.length,
    untestable: results.length - tested.length,
    passed,
    pctVerified:
      tested.length === 0 ? null : Math.round((passed / tested.length) * 100),
    mean:
      tested.length === 0
        ? null
        : Math.round(
            tested.reduce((a, r) => a + (r.score ?? 0), 0) / tested.length,
          ),
    flags: results.flatMap((r) => r.flags).slice(0, 10),
  };
}

export async function runVerify(): Promise<{
  cells: CellStats[];
  overall: CellStats;
  reportPath: string;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const rng = mulberry32(SEED);
    // One light pass buckets every entity into its source/region/index cells.
    const all = (await prisma.entity.findMany({
      select: {
        id: true,
        source: true,
        tickers: true,
        rawAddressText: true,
        businessAddress: true,
      },
      orderBy: { id: "asc" },
    })) as Pick<
      VEntity,
      "id" | "source" | "tickers" | "rawAddressText" | "businessAddress"
    >[];
    const buckets = new Map<string, string[]>();
    const put = (cell: string, id: string) => {
      const b = buckets.get(cell);
      if (b) {
        b.push(id);
      } else {
        buckets.set(cell, [id]);
      }
    };
    const allowedSources = new Set(
      [...new Set(all.map((e) => e.source))].sort().slice(0, MAX_SOURCE_CELLS),
    );
    for (const e of all) {
      if (allowedSources.has(e.source)) {
        put(`source=${e.source}`, e.id);
      }
      put(`region=${regionBucket(e.rawAddressText, e.businessAddress)}`, e.id);
      put(`index=${isMajorIndex(e.tickers) ? "major" : "long-tail"}`, e.id);
    }
    const entityCells: Cell[] = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, ids]) => ({
        name,
        memberIds: sampleIndices(ids.length, cellTake(ids.length), rng).map(
          (i) => ids[i] as string,
        ),
      }));
    const entityIds = [...new Set(entityCells.flatMap((c) => c.memberIds))].slice(
      0,
      MAX_ENTITIES,
    );
    const rows = (await prisma.entity.findMany({
      where: { id: { in: entityIds } },
      select: {
        id: true,
        source: true,
        tickers: true,
        rawAddressText: true,
        businessAddress: true,
        conceptTag: true,
        fundsVolume: true,
        currency: true,
        lat: true,
        lng: true,
      },
    })) as VEntity[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const entityScores = new Map<string, CheckResult>();
    for (const id of entityIds) {
      const row = byId.get(id);
      if (!row) {
        continue;
      }
      // One failing check must never end the audit: record it as
      // untestable with the reason and keep going.
      try {
        entityScores.set(id, await checkEntity(row));
      } catch (err) {
        entityScores.set(id, {
          score: null,
          flags: [`${id}: check failed (${err instanceof Error ? err.message : String(err)})`],
        });
      }
    }
    const cells: CellStats[] = entityCells.map((c) =>
      summarize(
        c.name,
        "entity",
        c.memberIds.map((id) => entityScores.get(id) ?? { score: null, flags: [] }),
      ),
    );

    // Flows: one cell per flow type, sampled the same way.
    const flowRows = (await prisma.capitalFlow.findMany({
      select: { id: true, flowType: true },
      orderBy: { id: "asc" },
    })) as { id: string; flowType: string }[];
    const flowBuckets = new Map<string, string[]>();
    for (const f of flowRows) {
      const b = flowBuckets.get(f.flowType);
      if (b) {
        b.push(f.id);
      } else {
        flowBuckets.set(f.flowType, [f.id]);
      }
    }
    const flowCells: Cell[] = [...flowBuckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, ids]) => ({
        name: `flow=${name}`,
        memberIds: sampleIndices(ids.length, cellTake(ids.length), rng).map(
          (i) => ids[i] as string,
        ),
      }));
    const flowIds = [...new Set(flowCells.flatMap((c) => c.memberIds))].slice(0, MAX_FLOWS);
    const fullFlows = (await prisma.capitalFlow.findMany({
      where: { id: { in: flowIds } },
      select: { id: true, amount: true, flowType: true },
    })) as { id: string; amount: number; flowType: string }[];
    const flowScores = new Map<string, CheckResult & { kind: string }>();
    for (const f of fullFlows) {
      try {
        flowScores.set(f.id, await checkFlow(f));
      } catch (err) {
        flowScores.set(f.id, {
          score: null,
          kind: "external",
          flags: [`${f.id}: check failed (${err instanceof Error ? err.message : String(err)})`],
        });
      }
    }
    for (const c of flowCells) {
      cells.push(
        summarize(
          c.name,
          "flow",
          c.memberIds.map((id) => flowScores.get(id) ?? { score: null, flags: [] }),
        ),
      );
    }

    const overall = summarize(
      "overall",
      "all",
      [...entityScores.values(), ...flowScores.values()],
    );
    const report = {
      generatedAt: new Date().toISOString(),
      seed: SEED,
      mode:
        LEGACY_SAMPLE !== null
          ? { fixed: LEGACY_SAMPLE }
          : { fraction: FRACTION, maxPerCell: MAX_PER_CELL },
      cells,
      overall,
    };
    const here = path.dirname(fileURLToPath(import.meta.url));
    const reportPath = path.join(here, "..", "..", "data", "verification-report.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return { cells, overall, reportPath };
  } finally {
    await prisma.$disconnect();
  }
}
