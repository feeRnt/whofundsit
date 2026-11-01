import axios from "axios";
import { PrismaClient, type Entity } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson, cacheKey, readCache, writeCache } from "./httpCache.js";
import { NASDAQ100_TICKERS } from "../data/nasdaq100.js";

// Background pipeline: give ingested SEC entities real coordinates, and route
// shouty/complex names through the Modal Llama worker for normalization.
// "Missing" coordinates means the 0,0 ingest placeholders. Geocoding runs
// where GEOCODE_BACKEND says ("local" default, or "modal" batch worker).
// Every outbound API is rate-limited + cached, every run capped (guardrails).
const MAX_ENTITIES_PER_RUN = 100;
const MAX_MODAL_CALLS_PER_RUN = 25;
const NOMINATIM_MIN_INTERVAL_MS = 1100; // Nominatim usage policy: <= 1 req/s
const MODAL_MIN_INTERVAL_MS = 250;

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
  // Nominatim requires a declared User-Agent. Override via env if needed.
  return (
    process.env.NOMINATIM_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)"
  );
}

// A 5xx or network blip must never kill a multi-hour coords run: it is a
// miss for THIS run (never cached, retried next time). 4xx still throws —
// a 403 means our usage is the problem and must be heard. Pure.
export function shouldSwallowGeoError(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

// Direct Nominatim calls from this machine: memory, then file cache, then
// one rate-limited call (misses cache too, so they never re-query).
function geoPath(text: string): string {
  return `geo/nominatim-${cacheKey(text)}.json`;
}

export async function geocodeLocal(text: string): Promise<Coords | null> {
  const cached = geocodeCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  let result: Coords | null;
  try {
    result = await cachedJson<Coords | null>(geoPath(text), () =>
      nominatim(async () => {
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
    }),
    );
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (!shouldSwallowGeoError(status)) {
      throw err;
    }
    console.warn(
      `[coords] Nominatim ${status ?? "network"} error for ${JSON.stringify(text)} — skipping this run`,
    );
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
  const unique = [...new Set(texts)];
  const { data } = await modal(() =>
    axios.post(
      url,
      { texts: unique, userAgent: nominatimUserAgent() },
      { headers: { "Content-Type": "application/json" }, timeout: 120000 },
    ),
  );
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
const missLog = new Set<string>();

export function flushMissLog(): { file: string; lines: number } {
  const rel = "geo/dead-lines.json";
  const prev = readCache<string[]>(rel) ?? [];
  const merged = [...new Set([...prev, ...missLog])].sort();
  writeCache(rel, merged);
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
async function geocodeMany(texts: string[]): Promise<Map<string, Coords | null>> {
  const out = new Map<string, Coords | null>();
  const byQuery = new Map<string, string[]>();
  for (const text of new Set(texts)) {
    if (junkAddress(text)) {
      out.set(text, null);
      missLog.add(text);
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
  const results =
    process.env.GEOCODE_BACKEND === "modal"
      ? await geocodeRemoteCached(queries)
      : await geocodeLocalEach(queries);
  // Second phase: missed queries get one cheaper retry each (each
  // fallback runs once, then fans out to every primary that needs it).
  const retry = new Map<string, string[]>();
  for (const q of queries) {
    if ((results.get(q) ?? null) !== null) {
      continue;
    }
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
    const second =
      process.env.GEOCODE_BACKEND === "modal"
        ? await geocodeRemoteCached([...retry.keys()])
        : await geocodeLocalEach([...retry.keys()]);
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
      missLog.add(q);
    }
    for (const o of originals) {
      out.set(o, r);
    }
  }
  return out;
}

async function geocodeLocalEach(
  queries: string[],
): Promise<Map<string, Coords | null>> {
  const out = new Map<string, Coords | null>();
  for (const q of queries) {
    out.set(q, await geocodeLocal(q));
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

async function normalizeWithLlama(
  entity: Pick<Entity, "name" | "rawAddressText">,
): Promise<string | null> {
  const url = process.env.MODAL_WEBHOOK_URL;
  if (!url) {
    return null;
  }
  const input = `${entity.name} (${entity.rawAddressText})`;
  try {
    const data = await cachedJson<unknown>(
      `ai/normalize-${cacheKey(input)}.json`,
      () =>
        modal(async () => {
          const res = await axios.post(
            url,
            { text: input },
            { headers: { "Content-Type": "application/json" }, timeout: 60000 },
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
  geocoded: number; // rows updated with real lat/lng
  normalized: number; // rows renamed by the Llama worker
  skipped: number; // no coordinates and no rename (scanned = updated + skipped)
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
    return await prisma.entity.count({ where: { lat: 0, lng: 0 } });
  } finally {
    await prisma.$disconnect();
  }
}

export async function runPipeline(
  opts: {
    normalize?: boolean;
    take?: number;
    indexOnly?: boolean;
    skip?: number;
  } = {},
): Promise<PipelineSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const entities = await prisma.entity.findMany({
      where: {
        lat: 0,
        lng: 0,
        ...(opts.indexOnly ? { tickers: { hasSome: NASDAQ100_TICKERS } } : {}),
      },
      take: opts.take ?? MAX_ENTITIES_PER_RUN,
      skip: opts.skip ?? 0,
      // Stable paging: id breaks fundsVolume ties so batch boundaries never
      // shift under the --all loop.
      orderBy: [{ fundsVolume: "desc" }, { id: "asc" }],
    });

    let geocoded = 0;
    let normalized = 0;
    let skipped = 0;
    let modalCalls = 0;

    const coordsByText = await geocodeMany(
      entities.map((e) => e.businessAddress ?? e.rawAddressText),
    );

    for (const entity of entities) {
      const coords =
        coordsByText.get(entity.businessAddress ?? entity.rawAddressText) ??
        null;

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

      if (!coords && !canonicalName) {
        skipped += 1;
        continue;
      }

      await prisma.entity.update({
        where: { id: entity.id },
        data: {
          ...(coords ?? {}),
          ...(canonicalName ? { name: canonicalName } : {}),
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
    return { scanned: entities.length, geocoded, normalized, skipped };
  } finally {
    await prisma.$disconnect();
  }
}
