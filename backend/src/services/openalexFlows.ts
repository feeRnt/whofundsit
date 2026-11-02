import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  cachedJson,
  cacheKey,
  apiLog,
  isRetryableHttpStatus,
  readCache,
  writeCache,
  userAgentFromEnv,
} from "./httpCache.js";

// Grant flows from OpenAlex: funder -> funded works -> grantee institutions.
// One funder per run (OPENALEX_FUNDER_ID, default Colgate-Palmolive, the parent
// under which Hill's Pet Nutrition grants are recorded). Amounts are funded-
// works counts — OpenAlex exposes no reliable dollar figures — so flowType
// "grant" means works, not USD. Polite: sequential calls, >=150 ms apart
// (keyless budget is 10/s shared; a key raises it).

const API = "https://api.openalex.org";
const DEFAULT_FUNDER = "https://openalex.org/F4320307808"; // Colgate-Palmolive Company

const WORKS_PER_PAGE = 200; // OpenAlex max
const MAX_FLOW_TARGETS = 100; // guardrail: top institutions per run
const MIN_INTERVAL_MS = 150;

let lastCallAt = 0;

async function throttle(): Promise<void> {
  const waitMs = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastCallAt = Date.now();
}

function contact(): string {
  // *_USER_AGENT matches the other services; OPENALEX_CONTACT is legacy.
  // Empty strings fall through (deliberately ||, not ??).
  return (
    process.env.OPENALEX_USER_AGENT ||
    process.env.OPENALEX_CONTACT ||
    userAgentFromEnv("OPENALEX_USER_AGENT")
  );
}

// Canonical OpenAlex ids (https://openalex.org/F...) are human web pages,
// not JSON: normalize any id form to its api.openalex.org entity route.
// Plain API paths ("/works") pass through untouched.
export function apiUrl(pathOrUrl: string, params: Record<string, string>): string {
  const ENTITY: Record<string, string> = {
    F: "funders",
    I: "institutions",
    W: "works",
  };
  let target = pathOrUrl;
  const id = target.match(/^(?:https:\/\/(?:api\.)?openalex\.org\/)?([A-Z]\d+)$/);
  if (id) {
    const entity = ENTITY[id[1][0]];
    if (!entity) {
      throw new Error(`[flows] unsupported OpenAlex id: ${pathOrUrl}`);
    }
    target = `${API}/${entity}/${id[1]}`;
  }
  const url = new URL(target.startsWith("http") ? target : `${API}${target}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const key = process.env.OPENALEX_API_KEY;
  if (key) {
    url.searchParams.set("api_key", key);
  }
  return url.toString();
}

async function oaGet<T>(url: string): Promise<T> {
  // 3 tries on 429/5xx (15s steps, Retry-After honored): one transient
  // blip must not cost a whole funder.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await throttle();
      apiLog("GET", url);
      const { data } = await axios.get<T>(url, {
        headers: { "User-Agent": contact(), Accept: "application/json" },
      });
      return data;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (!isRetryableHttpStatus(status) || attempt >= 3) {
        throw err;
      }
      const retryAfter = Number(
        axios.isAxiosError(err) ? err.response?.headers?.["retry-after"] : NaN,
      );
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 120
          ? retryAfter * 1000
          : 15000 * attempt;
      console.warn(
        `[openalex] HTTP ${status}, retry ${attempt}/3 in ${waitMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const shortId = (url: string): string => url.replace("https://openalex.org/", "");

// Empty/whitespace env values fall back to the default: `??` alone let ""
// through, which queried the API root and crashed downstream in geocoding.
export function resolveFunderId(
  env: string | undefined = process.env.OPENALEX_FUNDER_ID,
): string {
  return env?.trim() || DEFAULT_FUNDER;
}

// Large ingestions: comma-separated OPENALEX_FUNDER_IDS (full F-URLs or bare
// F... ids); falls back to the single-funder var, then the default.
export function resolveFunderIds(
  env: string | undefined = process.env.OPENALEX_FUNDER_IDS,
): string[] {
  const list = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [resolveFunderId()];
}

export interface Funder {
  id: string;
  display_name: string;
  country_code: string | null;
  works_count: number;
}

interface WorkPage {
  meta?: { next_cursor?: string | null; count?: number; cost_usd?: number };
  results: {
    id: string;
    authorships: {
      institutions: {
        id: string;
        display_name: string;
        country_code: string | null;
        type: string;
      }[];
    }[];
  }[];
}

interface Institution {
  display_name: string;
  country_code: string | null;
  type: string;
  geo: { latitude: number; longitude: number } | null;
}

// Fail loud on a junk funder payload (wrong id, API-root object, stale cache)
// instead of crashing later in geocoding with "undefined".
export function assertValidFunder(funder: Funder, funderId: string): void {
  if (
    typeof funder.display_name !== "string" ||
    typeof funder.works_count !== "number"
  ) {
    throw new Error(
      `[flows] OpenAlex returned no funder for ${funderId} — check OPENALEX_FUNDER_ID in backend/.env (want a full https://openalex.org/F... URL), then retry with CACHE_REFRESH=1`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// LLM-repair target for unplaceable funders: src/data/funder-coords.json maps
// funder ids (bare F-code or full URL) to { lat, lng }. Missing file means no
// rows, not a crash; an unparseable file throws loud (fail fast, fix once).
// Bad-lat/lng rows warn and fall through to Nominatim.
const FUNDER_COORDS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "funder-coords.json",
);

export function readFunderCoords(): Map<string, { lat: number; lng: number }> {
  const map = new Map<string, { lat: number; lng: number }>();
  if (!fs.existsSync(FUNDER_COORDS_FILE)) {
    return map;
  }
  const doc = JSON.parse(fs.readFileSync(FUNDER_COORDS_FILE, "utf8")) as {
    mapping?: Record<string, { lat: unknown; lng: unknown }>;
  };
  for (const [key, row] of Object.entries(doc.mapping ?? {})) {
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn(`[flows] funder-coords.json: skipping ${key} (bad lat/lng)`);
      continue;
    }
    map.set(shortId(key), { lat, lng });
  }
  return map;
}

// The funder needs map coordinates for arcs. Env pin wins, then the coords
// file above, otherwise Nominatim gets two tries (headquarters query first).
// Throws when unplaceable — dead arcs help nobody.
async function funderCoords(
  funderId: string,
  name: string,
): Promise<{ lat: number; lng: number }> {
  const lat = process.env.FUNDER_LAT;
  const lng = process.env.FUNDER_LNG;
  if (lat !== undefined && lng !== undefined) {
    return { lat: Number(lat), lng: Number(lng) };
  }
  const pinned = readFunderCoords().get(shortId(funderId));
  if (pinned) {
    console.log(
      `[flows] funder coords from file: ${name} (${pinned.lat}, ${pinned.lng})`,
    );
    return pinned;
  }
  for (const q of [`${name} headquarters`, name]) {
    const data = await cachedJson<{ lat: string; lon: string }[]>(
      `openalex/funder-coords-${cacheKey(q)}.json`,
      async () => {
        apiLog("GET", `https://nominatim.openstreetmap.org/search?q=${q}`);
        const { data } = await axios.get<{ lat: string; lon: string }[]>(
          "https://nominatim.openstreetmap.org/search",
          {
            params: { format: "jsonv2", limit: 1, q },
            headers: {
              "User-Agent": userAgentFromEnv("NOMINATIM_USER_AGENT"),
              Accept: "application/json",
            },
          },
        );
        return data;
      },
    );
    if (data[0]) {
      return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
    }
    await sleep(1100);
  }
  throw new Error(
    `could not geocode funder "${name}" — add ${shortId(funderId)} to backend/src/data/funder-coords.json (or set FUNDER_LAT/FUNDER_LNG in backend/.env)`,
  );
}

export interface SkippedFunder {
  id: string;
  reason: string;
  at: string;
}

const SKIPPED_FUNDERS_CACHE = "openalex/skipped-funders.json";

// Dead-lines-style work queue for the future LLM repair pass: funders the
// pipeline skipped (geocode miss, junk payload). Gitignored local cache like
// geo/dead-lines.json; entries accumulate, first reason wins.
export function recordSkippedFunder(id: string, reason: string): void {
  const prev = readCache<SkippedFunder[]>(SKIPPED_FUNDERS_CACHE) ?? [];
  if (prev.some((s) => s.id === id)) {
    return;
  }
  writeCache(SKIPPED_FUNDERS_CACHE, [
    ...prev,
    { id, reason, at: new Date().toISOString() },
  ]);
}

export interface FlowSummary {
  funder: string;
  works: number;
  institutions: number;
  flows: number;
  skippedNoGeo: number;
  costUsd: number;
  skipped: boolean;
}

export async function runOpenAlexFlows(
  funderId: string = resolveFunderId(),
): Promise<FlowSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const funder = await cachedJson<Funder>(
      `openalex/funder-${shortId(funderId)}.json`,
      () => oaGet<Funder>(apiUrl(funderId, {})),
    );
    assertValidFunder(funder, funderId);
    console.log(`[flows] funder: ${funder.display_name} (${funder.works_count} works)`);
    // Unplaceable funder (geocode miss, transient Nominatim error): skip it
    // and let the funder loop continue — one bad funder must not kill the run.
    // Nothing is cached on this path, so the next run retries the geocode.
    let funderAt: { lat: number; lng: number };
    try {
      funderAt = await cachedJson(
        `openalex/funder-geo-${shortId(funderId)}.json`,
        () => funderCoords(funderId, funder.display_name),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[flows] skipping funder ${funder.display_name} (${reason})`);
      recordSkippedFunder(funderId, `${funder.display_name}: ${reason}`);
      return {
        funder: funder.display_name,
        works: 0,
        institutions: 0,
        flows: 0,
        skippedNoGeo: 0,
        costUsd: 0,
        skipped: true,
      };
    }
    const funderKey = shortId(funder.id);
    const funderRowId = `openalex:${funderKey}`;

    // Cursor paging unlocks the full set with a key; keyless stays on the
    // first page. OPENALEX_MAX_WORKS caps the pull (ground-rules guardrail
    // 1); per-call cost_usd is summed so spend stays visible.
    const hasKey = !!process.env.OPENALEX_API_KEY;
    const maxWorks = hasKey
      ? Math.max(WORKS_PER_PAGE, Number(process.env.OPENALEX_MAX_WORKS ?? 5000))
      : WORKS_PER_PAGE;
    const works: WorkPage["results"] = [];
    let cursor: string | null = "*";
    let pageIdx = 0;
    let totalMatching: number | null = null;
    let costUsd = 0;
    while (cursor !== null && works.length < maxWorks) {
      const c = cursor;
      pageIdx += 1;
      let page: WorkPage;
      try {
        page = await cachedJson<WorkPage>(
          `openalex/works-${shortId(funderId)}-p${pageIdx}.json`,
          () =>
            oaGet<WorkPage>(
              apiUrl("/works", {
                filter: `funders.id:${funderId}`,
                "per-page": String(WORKS_PER_PAGE),
                select: "id,display_name,authorships",
                cursor: c,
              }),
            ),
        );
      } catch (err) {
        // Page 2+ can die on a stale cached cursor; keep what we have.
        console.warn(
          `[flows] works page ${pageIdx} failed, keeping ${works.length} works (${err})`,
        );
        break;
      }
      works.push(...page.results);
      costUsd += page.meta?.cost_usd ?? 0;
      if (totalMatching === null && typeof page.meta?.count === "number") {
        totalMatching = page.meta.count;
      }
      cursor = hasKey ? (page.meta?.next_cursor ?? null) : null;
    }

    const byInst = new Map<
      string,
      { name: string; country: string | null; type: string; works: number }
    >();
    for (const work of works) {
      const seen = new Set<string>();
      for (const authorship of work.authorships ?? []) {
        for (const inst of authorship.institutions ?? []) {
          if (seen.has(inst.id)) {
            continue;
          }
          seen.add(inst.id);
          const entry = byInst.get(inst.id) ?? {
            name: inst.display_name,
            country: inst.country_code,
            type: inst.type,
            works: 0,
          };
          entry.works += 1;
          byInst.set(inst.id, entry);
        }
      }
    }
    const top = [...byInst.entries()]
      .sort((a, b) => b[1].works - a[1].works)
      .slice(0, MAX_FLOW_TARGETS);
    console.log(
      `[flows] ${works.length} works${totalMatching !== null ? ` of ${totalMatching}` : ""} -> ${byInst.size} institutions (top ${top.length}, $${costUsd.toFixed(4)})`,
    );

    await prisma.entity.upsert({
      where: { id: funderRowId },
      create: {
        id: funderRowId,
        name: funder.display_name,
        type: "Funder",
        lat: funderAt.lat,
        lng: funderAt.lng,
        fundsVolume: works.length,
        rawAddressText: funder.country_code ?? "—",
        tickers: [],
        source: "openalex",
      },
      update: {
        name: funder.display_name,
        lat: funderAt.lat,
        lng: funderAt.lng,
        fundsVolume: works.length,
        rawAddressText: funder.country_code ?? "—",
        source: "openalex",
      },
    });

    let flows = 0;
    let skippedNoGeo = 0;
    let done = 0;
    for (const [instId, info] of top) {
      const key = shortId(instId);
      const full = await cachedJson<Institution>(
        `openalex/inst-${key}.json`,
        () => oaGet<Institution>(apiUrl(instId, {})),
      );
      if (!full.geo) {
        skippedNoGeo += 1;
        continue;
      }
      const instRowId = `openalex:${key}`;
      await prisma.entity.upsert({
        where: { id: instRowId },
        create: {
          id: instRowId,
          name: info.name,
          type: info.type || "Institution",
          lat: full.geo.latitude,
          lng: full.geo.longitude,
          fundsVolume: info.works,
          rawAddressText: info.country ?? "—",
          tickers: [],
          source: "openalex",
        },
        update: {
          name: info.name,
          type: info.type || "Institution",
          lat: full.geo.latitude,
          lng: full.geo.longitude,
          fundsVolume: info.works,
          rawAddressText: info.country ?? "—",
          source: "openalex",
        },
      });
      await prisma.capitalFlow.upsert({
        where: { id: `openalex:${funderKey}:${key}` },
        create: {
          id: `openalex:${funderKey}:${key}`,
          sourceEntityId: funderRowId,
          targetEntityId: instRowId,
          amount: info.works,
          flowType: "grant",
        },
        update: { amount: info.works, flowType: "grant" },
      });
      flows += 1;
      done += 1;
      if (done % 25 === 0) {
        console.log(`[flows] ${done}/${top.length} institutions...`);
      }
    }

    return {
      funder: funder.display_name,
      works: works.length,
      institutions: byInst.size,
      flows,
      skippedNoGeo,
      costUsd,
      skipped: false,
    };
  } finally {
    await prisma.$disconnect();
  }
}
