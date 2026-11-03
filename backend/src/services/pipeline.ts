import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Entity, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  cachedJson,
  cacheKey,
  readCache,
  writeCache,
  apiLog,
  green,
  red,
  modalProxyHeaders,
  MODAL_PROXY_ENV_HINT,
  userAgentFromEnv,
} from "./httpCache.js";
import { NASDAQ100_TICKERS } from "../data/nasdaq100.js";
import {
  censusBatchGeocode,
  isUsShaped,
  parseUsAddress,
  type ParsedUsAddress,
} from "./censusBatch.js";

// Background pipeline: give ingested SEC entities real coordinates, and route
// shouty/complex names through the Modal Llama worker for normalization.
// "Missing" coordinates means the 0,0 ingest placeholders. Geocoding runs
// where GEOCODE_BACKEND says ("local" default, or "modal" batch worker).
// Every outbound API is rate-limited + cached, every run capped (guardrails).
const MAX_ENTITIES_PER_RUN = 100;
const MAX_MODAL_CALLS_PER_RUN = 25;
const NOMINATIM_MIN_INTERVAL_MS = 1100; // Nominatim usage policy: <= 1 req/s
const MODAL_MIN_INTERVAL_MS = 250;
// Census batch states no limit (built for bulk); 1s politeness costs ~nothing
// at <=500 rows per call.
export const CENSUS_MIN_INTERVAL_MS = 1000;

// Minimal in-memory rate limiter: one outbound call at a time, spaced out.
// Promise-chained, so it holds under concurrent callers (ToS-safe).
export function createRateLimiter(minIntervalMs: number) {
  let lastAt = 0;
  let tail: Promise<void> = Promise.resolve();
  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const waitMs = Math.max(0, lastAt + minIntervalMs - Date.now());
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      try {
        return await fn();
      } finally {
        lastAt = Date.now();
      }
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const nominatim = createRateLimiter(NOMINATIM_MIN_INTERVAL_MS);
const modal = createRateLimiter(MODAL_MIN_INTERVAL_MS);
const census = createRateLimiter(CENSUS_MIN_INTERVAL_MS);

interface Coords {
  lat: number;
  lng: number;
}

const geocodeCache = new Map<string, Coords | null>();

interface NominatimHit {
  lat: string;
  lon: string;
}

function nominatimUserAgent(): string {
  // Nominatim requires a declared User-Agent (warns when unconfigured).
  return userAgentFromEnv("NOMINATIM_USER_AGENT");
}

// SPARQL-shaped retry for Nominatim: 429/5xx/network errors retry in-run
// (3 attempts, 15s steps). What still fails is failed, not pending — a
// rerun would fail the same way. Pure.
export function isRetryableGeoStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

// Terminal decision after retries are spent: a 5xx or network blip must
// never kill a multi-hour coords run (row failed, run continues). 4xx
// still throws — a 403/429 means our usage is the problem and must be
// heard. Pure.
export function shouldSwallowGeoError(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

// Queries that errored after full retry this run: still DB-failed (skip
// IS failed), but NEVER dead-lined — a 5xx is not a miss, and dead-lines
// must mean "known-bad address". Cleared per runPipeline call.
const transientTexts = new Set<string>();

// Next geoStatus after an attempt: placed on coords, failed on anything
// else. No pending limbo — misses are deterministic, and errors already
// survived 3 in-run retries. The only ways out of failed are the LLM
// pass, coords:global (P625), and --census-failed. Pure — the LLM repair
// pass will query geoStatus = "failed".
export function nextGeoStatus(found: boolean): string {
  return found ? "placed" : "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Direct Nominatim calls from this machine: memory, then file cache, then
// one rate-limited call (misses cache too, so they never re-query).
function geoPath(text: string): string {
  return `geo/nominatim-${cacheKey(text)}.json`;
}

export async function geocodeLocal(
  text: string,
  note?: string,
): Promise<Coords | null> {
  const cached = geocodeCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  let result: Coords | null;
  try {
    result = await cachedJson<Coords | null>(geoPath(text), async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await nominatim(async () => {
            apiLog(
              "GET",
              `https://nominatim.openstreetmap.org/search?q=${text}`,
              note,
            );
            const { data } = await axios.get<NominatimHit[]>(
              "https://nominatim.openstreetmap.org/search",
              {
                params: { format: "jsonv2", limit: 1, q: text },
                headers: {
                  "User-Agent": nominatimUserAgent(),
                  Accept: "application/json",
                  "Accept-Encoding": "gzip, deflate",
                },
              },
            );
            const hit = data[0];
            return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
          });
        } catch (err) {
          const status = axios.isAxiosError(err)
            ? err.response?.status
            : undefined;
          if (isRetryableGeoStatus(status) && attempt < 3) {
            const waitMs = 15000 * attempt;
            console.warn(
              `[coords] Nominatim HTTP ${status ?? "network"} for ${JSON.stringify(text)}, retry ${attempt}/3 in ${waitMs / 1000}s`,
            );
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
      }
    });
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 400) {
      // Over-long queries (e.g. multi-line HQ addresses) 400 forever: a
      // permanent miss, not a run-killer. Dead-lined like any other miss.
      console.warn(
        `[coords] Nominatim 400 for ${JSON.stringify(text)} — skipping (query too long?)`,
      );
      missLog.add(text);
      geocodeCache.set(text, null);
      return null;
    }
    if (!shouldSwallowGeoError(status)) {
      if (status === 403 || status === 429) {
        throw new Error(
          `[coords] Nominatim denied access (HTTP ${status}) — IP blocked or over limit. ` +
            "Pause all runs and manual queries for an hour or two, then retry.",
        );
      }
      throw err;
    }
    console.warn(
      `[coords] Nominatim ${status ?? "network"} error for ${JSON.stringify(text)} — marking failed (3 attempts spent)`,
    );
    transientTexts.add(text);
    return null;
  }
  geocodeCache.set(text, result);
  return result;
}

// One batch to the Modal geocoder (see backend/geocode_worker.py).
async function geocodeRemote(texts: string[]): Promise<Map<string, Coords | null>> {
  const url = process.env.MODAL_GEOCODE_URL;
  if (!url) {
    throw new Error("MODAL_GEOCODE_URL is not set (see backend/.env.example)");
  }
  const auth = modalProxyHeaders();
  if (!auth) {
    throw new Error(`Modal proxy auth is not configured — ${MODAL_PROXY_ENV_HINT}`);
  }
  const unique = [...new Set(texts)];
  apiLog("POST", url);
  let data: unknown;
  try {
    ({ data } = await modal(() =>
      axios.post(
        url,
        { texts: unique, userAgent: nominatimUserAgent() },
        {
          headers: { "Content-Type": "application/json", ...auth },
          timeout: 120000,
        },
      ),
    ));
  } catch (err) {
    if (
      axios.isAxiosError(err) &&
      (err.response?.status === 401 || err.response?.status === 403)
    ) {
      throw new Error(`Modal proxy auth rejected — ${MODAL_PROXY_ENV_HINT}`);
    }
    throw err;
  }
  if (!Array.isArray(data) || data.length !== unique.length) {
    throw new Error("Modal geocoder returned a malformed batch");
  }
  const out = new Map<string, Coords | null>();
  unique.forEach((text, i) => {
    const hit = data[i] as { lat?: unknown; lng?: unknown } | null;
    out.set(
      text,
      hit && typeof hit.lat === "number" && typeof hit.lng === "number"
        ? { lat: hit.lat, lng: hit.lng }
        : null,
    );
  });
  return out;
}

// Raw state codes ("US-IL") expand to full names: Nominatim resolves
// "Illinois, United States" (state centroid) but not the code. Placeholders
// ("—") and empties resolve to null with zero API calls. Unknown codes pass
// through and miss rather than misplace; bare 2-letter codes are NOT mapped
// ("CA" could be Canada, not California).
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
  MP: "Northern Mariana Islands", AS: "American Samoa",
};

// Bare company/fund names with no locality are unresolvable by design —
// Nominatim needs a place, not a registrant. Junking them here saves up
// to 3 paced queries each (primary + 2 fallbacks ≈ 3.3s). Conservative:
// single short tokens ("Berlin") still query; only obvious registrant
// names (corporate suffix, or long and digit-free) are junked. Pure.
export function junkAddress(text: string): boolean {
  const t = text.trim();
  if (!t || t === "—") {
    return true;
  }
  const parts = t.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length > 1) {
    return false; // has locality structure; let Nominatim try
  }
  // Trailing lookahead, not \b: dotted suffixes ("S.R.O.") end in a
  // non-word char, so \b never matches after them.
  if (
    /\b(INC|CORP|CORPORATION|LLC|LTD|LIMITED|PLC|GMBH|FUND|HOLDINGS|HOLDING|GROUP|B\.V\.|S\.A\.|S\.R\.O\.?|PTY|BV|NV|SA|AG|SE|SPA|LP|LLP|TRUST|BANCORP|FINANCIAL|SERVICES|MANAGEMENT|ADVISORS|CAPITAL|PARTNERS|INVESTMENT|ASSET)(?![A-Za-z])/i.test(
      t,
    )
  ) {
    return true;
  }
  return t.length > 30 && !/\d/.test(t);
}

// Unresolved queries accumulate here per process; flushMissLog() persists
// them next to the geocode cache for inspection (and the future LLM
// miss-repair pass). Service-layer side effect, called by runPipeline.
// The file also preloads once per process, so known-dead rows skip with
// zero API calls. Pure-file read: very fast, one small JSON parse.
const missLog = new Set<string>();
let deadLinesLoaded = false;
let geoSeedLoaded = false;
let deadHits = 0;
let junkHits = 0;
// Running totals across runPipeline batches in this process (coords --all
// calls it repeatedly), so every progress line shows the run so far.
const runTotals = { geocoded: 0, failed: 0 };

// Committed coords seed (geo:snapshot output): preloaded into the memory
// cache so fresh clones resolve known addresses with zero API calls.
function ensureGeoSeed(): void {
  if (geoSeedLoaded) {
    return;
  }
  geoSeedLoaded = true;
  if (process.env.CACHE_REFRESH) {
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const seedFile = path.join(here, "..", "data", "geo-mapping.json");
  if (!fs.existsSync(seedFile)) {
    return;
  }
  try {
    const doc = JSON.parse(fs.readFileSync(seedFile, "utf8")) as {
      mapping?: Record<string, { lat?: unknown; lng?: unknown }>;
    };
    for (const [text, c] of Object.entries(doc.mapping ?? {})) {
      if (typeof c.lat === "number" && typeof c.lng === "number") {
        geocodeCache.set(text, { lat: c.lat, lng: c.lng });
      }
    }
  } catch {
    // Corrupt seed: ignore it, the API remains the source of truth.
  }
}

function ensureDeadLines(): void {
  if (deadLinesLoaded) {
    return;
  }
  deadLinesLoaded = true;
  if (process.env.CACHE_REFRESH) {
    return; // explicit refresh retries everything, dead or not
  }
  // Committed seed first (fresh clones skip junk with zero calls), then
  // the local accumulation. Both are our own address strings + outcome
  // facts — no Nominatim data — so the seed is safe to commit.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const seedFile = path.join(here, "..", "data", "dead-lines.json");
  if (fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf8")) as unknown;
    if (Array.isArray(seed)) {
      for (const t of seed) {
        if (typeof t === "string") {
          missLog.add(t);
        }
      }
    }
  }
  const prev = readCache<string[]>("geo/dead-lines.json");
  if (prev) {
    for (const t of prev) {
      missLog.add(t);
    }
  }
}

export function flushMissLog(): { file: string; lines: number } {
  const rel = "geo/dead-lines.json";
  if (process.env.CACHE_REFRESH) {
    missLog.clear();
    return { file: rel, lines: 0 };
  }
  const prev = readCache<string[]>(rel) ?? [];
  const before = prev.length;
  const merged = [...new Set([...prev, ...missLog])].sort();
  writeCache(rel, merged);
  console.log(
    `[coords] dead-lines: +${merged.length - before} new, ${merged.length} total (${rel})`,
  );
  missLog.clear();
  return { file: rel, lines: merged.length };
}

export function expandLocationText(text: string): string | null {
  if (!text || text === "—") {
    return null;
  }
  const m = text.match(/^US-([A-Z]{2})$/);
  if (m) {
    const full = US_STATES[m[1]];
    if (full) {
      return `${full}, United States`;
    }
  }
  return text;
}

// Nominatim chokes on street lines (PO boxes, suite numbers); the trailing
// city/state/zip alone often resolves, then the trailing pair. SEC
// letter-digit country codes (X0, E9, … — 57k addresses carry them) poison
// every query they touch, so they are dropped first. Pure for testing.
export function fallbackQueries(address: string): string[] {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length <= 3) {
    return [];
  }
  const clean = parts.filter((p) => !/^[A-Z]\d$/.test(p));
  const out: string[] = [];
  if (clean.length >= 3) {
    out.push(clean.slice(-3).join(", "));
  }
  if (clean.length >= 2) {
    // State+zip pairs ("IL, 62701") are intentional: Nominatim usually
    // misses them fast, and when it 503s the caller swallows it per-query
    // (see shouldSwallowGeoError) instead of dying.
    out.push(clean.slice(-2).join(", "));
  }
  return [...new Set(out)];
}

// Prefers the business street address from SEC submissions; falls back to the
// raw Frames state code, expanded so its hits land on state centroids.
async function geocodeMany(
  texts: string[],
  names?: Map<string, string>,
): Promise<Map<string, Coords | null>> {
  const out = new Map<string, Coords | null>();
  const byQuery = new Map<string, string[]>();
  ensureDeadLines();
  ensureGeoSeed();
  const junkBefore = junkHits;
  const deadBefore = deadHits;
  for (const text of new Set(texts)) {
    if (missLog.has(text)) {
      // Known dead (preloaded file or earlier miss): zero calls, zero wait.
      out.set(text, null);
      deadHits += 1;
      continue;
    }
    if (junkAddress(text)) {
      out.set(text, null);
      missLog.add(text);
      junkHits += 1;
      continue;
    }
    const q = expandLocationText(text);
    if (q === null) {
      out.set(text, null);
      continue;
    }
    const group = byQuery.get(q);
    if (group) {
      group.push(text);
    } else {
      byQuery.set(q, [text]);
    }
  }
  const queries = [...byQuery.keys()];
  // Census pre-pass: US-parseable rows resolve in ONE batch call (free, no
  // key, 10k/call). Hits skip Nominatim; misses and transport failures flow
  // into the normal path below, so a dead Census degrades to status quo.
  const censusRows = new Map<string, ParsedUsAddress>();
  for (const q of queries) {
    if (geocodeCache.has(q)) {
      continue;
    }
    if (readCache<Coords | null>(geoPath(q)) !== undefined) {
      continue;
    }
    const parsed = parseUsAddress(q);
    if (parsed) {
      censusRows.set(q, parsed);
    } else if (isUsShaped(q)) {
      console.log(red(`[census] ${q} -> unparseable`));
    } else {
      console.log(`[census] ${q} -> foreign, skipped`);
    }
  }
  const censusHits = new Map<string, Coords>();
  if (censusRows.size > 0) {
    try {
      const res = await census(() => censusBatchGeocode(censusRows));
      for (const [q, coords] of res) {
        if (coords) {
          censusHits.set(q, coords);
          geocodeCache.set(q, coords);
          writeCache(geoPath(q), coords);
        }
      }
    } catch (err) {
      console.warn(
        `[coords] census batch failed, nominatim covers all (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  console.log(
    `[coords] census: ${censusHits.size}/${censusRows.size} us rows placed` +
      `${censusRows.size === 0 ? " (no api call)" : ""}`,
  );
  const remaining = queries.filter((q) => !censusHits.has(q));
  const results: Map<string, Coords | null> =
    remaining.length > 0
      ? process.env.GEOCODE_BACKEND === "modal"
        ? await geocodeRemoteCached(remaining)
        : await geocodeLocalEach(remaining, "query", names)
      : new Map();
  for (const [q, coords] of censusHits) {
    results.set(q, coords);
  }
  const preRetryHits = [...results.values()].filter((r) => r !== null).length;
  // Second phase: missed queries get one cheaper retry each (each
  // fallback runs once, then fans out to every primary that needs it).
  // Batch evidence 2026-11-02 (GLEIF foreign rows): 173/339 rescued —
  // the pass nearly doubles placement and earns its queries.
  const retry = new Map<string, string[]>();
  for (const q of queries) {
    if ((results.get(q) ?? null) !== null) {
      continue;
    }
    console.log(`[coords] pass-miss: ${q}`);
    for (const f of fallbackQueries(q)) {
      const known = results.get(f);
      if (known) {
        results.set(q, known); // another primary already resolved this
        break;
      }
      if (known === undefined) {
        const group = retry.get(f);
        if (group) {
          group.push(q);
        } else {
          retry.set(f, [q]);
        }
      }
      // known === null: fetched and missed; nothing to gain.
    }
  }
  if (retry.size > 0) {
    // Retry queries inherit the first primary's company name for the log.
    const retryNames = names
      ? new Map(
          [...retry.entries()].flatMap(([f, primaries]) => {
            const n = names.get(primaries[0] as string);
            return n ? [[f, n] as [string, string]] : [];
          }),
        )
      : undefined;
    const second =
      process.env.GEOCODE_BACKEND === "modal"
        ? await geocodeRemoteCached([...retry.keys()])
        : await geocodeLocalEach([...retry.keys()], "retry", retryNames);
    for (const [f, primaries] of retry) {
      for (const q of primaries) {
        if ((results.get(q) ?? null) === null) {
          results.set(q, second.get(f) ?? null);
        }
      }
    }
  }
  for (const [q, originals] of byQuery) {
    const r = results.get(q) ?? null;
    if (r === null) {
      // Errors are failed but never dead-lined: a 5xx is not a miss, and
      // dead-lines must mean "known-bad address" (a retry with fresh
      // methodology must still re-query it).
      const flaky =
        transientTexts.has(q) ||
        fallbackQueries(q).some((f) => transientTexts.has(f));
      if (flaky) {
        console.log(red(`[coords] retry-error: ${q} (failed, not dead-lined)`));
      } else {
        missLog.add(q);
        console.log(red(`[coords] retry-miss: ${q}`));
      }
    } else {
      console.log(green(`[coords] hit: ${q} -> ${r.lat},${r.lng}`));
    }
    for (const o of originals) {
      out.set(o, r);
    }
  }
  // Diagnosability line: every miss class and its count, so the next
  // methodology fix knows exactly where the bodies are.
  const hits = [...results.values()].filter((r) => r !== null).length;
  console.log(
    `[coords] geocode: ${queries.length} queries (${censusHits.size} census, ${preRetryHits} pre-retry), ` +
      `${retry.size} retries (${hits - preRetryHits} rescued), ` +
      `${junkHits - junkBefore} junk, ${deadHits - deadBefore} dead-file`,
  );
  return out;
}

async function geocodeLocalEach(
  queries: string[],
  tag = "query",
  names?: Map<string, string>,
): Promise<Map<string, Coords | null>> {
  const out = new Map<string, Coords | null>();
  let i = 0;
  for (const q of queries) {
    out.set(q, await geocodeLocal(q, names?.get(q)));
    i += 1;
    if (i % 25 === 0 || i === queries.length) {
      // Paced at 1.1s/query, so remaining count converts directly to ETA.
      const remain = Math.round(((queries.length - i) * 1100) / 1000);
      console.log(
        `[coords] ${tag} ${i}/${queries.length}, ~${formatDuration(remain)} left ` +
          `| run: ${runTotals.geocoded} placed, ${runTotals.failed} failed`,
      );
    }
  }
  return out;
}

async function geocodeRemoteCached(
  queries: string[],
): Promise<Map<string, Coords | null>> {
  // Batch only queries missing from both caches; file results back.
  const out = new Map<string, Coords | null>();
  const missing: string[] = [];
  for (const q of queries) {
    const mem = geocodeCache.get(q);
    if (mem !== undefined) {
      out.set(q, mem);
      continue;
    }
    const file = readCache<Coords | null>(geoPath(q));
    if (file !== undefined) {
      geocodeCache.set(q, file);
      out.set(q, file);
      continue;
    }
    missing.push(q);
  }
  if (missing.length > 0) {
    const fresh = await geocodeRemote(missing);
    for (const [q, coords] of fresh) {
      geocodeCache.set(q, coords);
      writeCache(geoPath(q), coords);
      out.set(q, coords);
    }
  }
  return out;
}

// SEC names arrive SHOUTING or punctuated ("AAR CORP."); those earn a Llama pass.
function needsLlama(name: string): boolean {
  return name === name.toUpperCase() || /[^A-Za-z0-9 .,&'-]/.test(name);
}

let warnedModalKey = false;

async function normalizeWithLlama(
  entity: Pick<Entity, "name" | "rawAddressText">,
): Promise<string | null> {
  const url = process.env.MODAL_WEBHOOK_URL;
  if (!url) {
    return null;
  }
  const auth = modalProxyHeaders();
  if (!auth) {
    // Best-effort stays best-effort (never throw here), but a missing
    // token warns once — silent no-op normalization is a misconfig smell.
    if (!warnedModalKey) {
      warnedModalKey = true;
      console.warn(`Modal proxy auth is not configured — skipping AI normalization (${MODAL_PROXY_ENV_HINT})`);
    }
    return null;
  }
  const input = `${entity.name} (${entity.rawAddressText})`;
  try {
    const data = await cachedJson<unknown>(
      `ai/normalize-${cacheKey(input)}.json`,
      () =>
        modal(async () => {
          apiLog("POST", url);
          const res = await axios.post(
            url,
            { text: input },
            {
              headers: { "Content-Type": "application/json", ...auth },
              timeout: 60000,
            },
          );
          return res.data as unknown;
        }),
    );
    const parsed: unknown =
      typeof data === "string" ? JSON.parse(data) : data;
    if (typeof parsed === "object" && parsed !== null) {
      const name = (parsed as { canonicalName?: unknown }).canonicalName;
      return typeof name === "string" && name.length > 0 ? name : null;
    }
    return null;
  } catch {
    return null; // best-effort: never fail the run on AI cleanup
  }
}

export interface PipelineSummary {
  scanned: number; // entities considered (<= take)
  geocoded: number; // rows placed with real lat/lng (scanned = geocoded + failed)
  failed: number; // rows marked failed: misses, junk, errors-after-retry
  normalized: number; // rows renamed by the Llama worker
  dead: number; // of failed: hit the dead-lines file, zero API calls
  junk: number; // of failed: registrant-name pre-filter, zero API calls
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 90) {
    return `${Math.round(totalSeconds)} seconds`;
  }
  const minutes = totalSeconds / 60;
  if (minutes < 90) {
    return `${Math.round(minutes)} minutes`;
  }
  return `${(minutes / 60).toFixed(1)} hours`;
}

export async function countPendingGeocodes(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    return await prisma.entity.count({
      where: { lat: 0, lng: 0, geoStatus: { not: "failed" } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

export interface PendingOpts {
  retryFailed?: boolean;
  censusFailed?: boolean;
  indexOnly?: boolean;
}

// Which unplaced rows a run may touch. Failed rows stay out of reruns (the
// LLM pass owns them); --retry-failed opts back in after methodology
// improvements; --census-failed selects ONLY failed rows for the Census
// repass. Pure for testing.
export function pendingWhere(opts: PendingOpts): Prisma.EntityWhereInput {
  return {
    lat: 0,
    lng: 0,
    // Share-count rows are never mapped: their huge count volumes would
    // sort first and burn Nominatim calls for zero map benefit. The OR
    // keeps NULL-concept rows (global/openalex/13f): plain `not` would
    // drop them via three-valued logic.
    OR: [
      { conceptTag: null },
      { conceptTag: { not: "EntityCommonStockSharesOutstanding" } },
    ],
    ...(opts.censusFailed
      ? { geoStatus: "failed" }
      : opts.retryFailed
        ? {}
        : { geoStatus: { not: "failed" } }),
    ...(opts.indexOnly ? { tickers: { hasSome: NASDAQ100_TICKERS } } : {}),
  };
}

export async function countFailedGeocodes(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    return await prisma.entity.count({
      where: { lat: 0, lng: 0, geoStatus: "failed" },
    });
  } finally {
    await prisma.$disconnect();
  }
}

// One Census POST over failed rows (the --census-failed repass): no
// Nominatim, no retries, no renames. Hits are written + marked placed;
// misses and transport failures stay failed for the LLM queue.
async function runCensusFailedPass(
  prisma: PrismaClient,
  entities: Entity[],
): Promise<PipelineSummary> {
  const t0 = Date.now();
  const rows = new Map<string, ParsedUsAddress>();
  const idsOf = new Map<string, string[]>();
  for (const e of entities) {
    const t = e.businessAddress ?? e.rawAddressText;
    if (!t) {
      continue;
    }
    const parsed = parseUsAddress(t);
    if (parsed) {
      // Keyed by address text (dedupes shared addresses, and the batch
      // log shows addresses instead of entity ids); ids ride along for
      // the updates below.
      rows.set(t, parsed);
      const group = idsOf.get(t);
      if (group) {
        group.push(e.id);
      } else {
        idsOf.set(t, [e.id]);
      }
    } else if (isUsShaped(t)) {
      console.log(red(`[census] ${t} -> unparseable`));
    } else {
      console.log(`[census] ${t} -> foreign, skipped`);
    }
  }
  let geocoded = 0;
  if (rows.size > 0) {
    try {
      const res = await census(() => censusBatchGeocode(rows));
      for (const [addr, coords] of res) {
        if (!coords) {
          continue;
        }
        for (const id of idsOf.get(addr) ?? []) {
          await prisma.entity.update({
            where: { id },
            data: { lat: coords.lat, lng: coords.lng, geoStatus: "placed" },
          });
          geocoded += 1;
        }
      }
    } catch (err) {
      console.warn(
        `[coords] census-failed batch failed, rows stay failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  const failed = entities.length - geocoded;
  runTotals.geocoded += geocoded;
  runTotals.failed += failed;
  console.log(
    `[coords] census-failed: ${geocoded}/${entities.length} placed ` +
      `(${rows.size} us-parseable${rows.size === 0 ? ", no api call" : ""}) in ${formatDuration((Date.now() - t0) / 1000)}`,
  );
  return {
    scanned: entities.length,
    geocoded,
    failed,
    normalized: 0,
    dead: 0,
    junk: 0,
  };
}

export async function runPipeline(
  opts: {
    normalize?: boolean;
    take?: number;
    indexOnly?: boolean;
    skip?: number;
    retryFailed?: boolean;
    censusFailed?: boolean;
  } = {},
): Promise<PipelineSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    transientTexts.clear();
    const entities = await prisma.entity.findMany({
      where: pendingWhere(opts),
      take: opts.take ?? MAX_ENTITIES_PER_RUN,
      skip: opts.skip ?? 0,
      // Stable paging: id breaks fundsVolume ties so batch boundaries never
      // shift under the --all loop.
      orderBy: [{ fundsVolume: "desc" }, { id: "asc" }],
    });
    if (opts.censusFailed) {
      return await runCensusFailedPass(prisma, entities);
    }

    let geocoded = 0;
    let normalized = 0;
    let failed = 0;
    let modalCalls = 0;
    deadHits = 0;
    junkHits = 0;
    const t0 = Date.now();

    // Company name per expanded query (first wins) for lookup log lines.
    const names = new Map<string, string>();
    for (const e of entities) {
      const t = e.businessAddress ?? e.rawAddressText;
      const q = expandLocationText(t) ?? t;
      if (!names.has(q)) {
        names.set(q, e.name);
      }
    }
    const coordsByText = await geocodeMany(
      entities.map((e) => e.businessAddress ?? e.rawAddressText),
      names,
    );

    for (const entity of entities) {
      const addrText = entity.businessAddress ?? entity.rawAddressText;
      const coords = coordsByText.get(addrText) ?? null;

      let canonicalName: string | null = null;
      if (
        opts.normalize !== false &&
        needsLlama(entity.name) &&
        modalCalls < MAX_MODAL_CALLS_PER_RUN &&
        process.env.MODAL_WEBHOOK_URL
      ) {
        modalCalls += 1;
        canonicalName = await normalizeWithLlama(entity);
      }

      // Skip IS failed: every scanned row without coords is marked
      // failed — junk and errors-after-retry included. The only ways out
      // are the LLM pass, coords:global (P625), and --census-failed, so
      // plain reruns only ever see genuinely new rows.
      const status = nextGeoStatus(coords !== null);

      if (status === "failed") {
        console.log(red(`[coords] llm-queue: ${entity.id} (${entity.name})`));
        failed += 1;
      }
      await prisma.entity.update({
        where: { id: entity.id },
        data: {
          ...(coords ?? {}),
          ...(canonicalName ? { name: canonicalName } : {}),
          ...(status ? { geoStatus: status } : {}),
        },
      });
      if (coords) {
        geocoded += 1;
      }
      if (canonicalName) {
        normalized += 1;
      }
    }

    flushMissLog(); // persist dead lines next to the geocode cache
    runTotals.geocoded += geocoded;
    runTotals.failed += failed;
    console.log(
      `[coords] batch: ${entities.length} scanned in ${formatDuration((Date.now() - t0) / 1000)}`,
    );
    return {
      scanned: entities.length,
      geocoded,
      failed,
      normalized,
      dead: deadHits,
      junk: junkHits,
    };
  } finally {
    await prisma.$disconnect();
  }
}
