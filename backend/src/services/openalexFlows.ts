import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson } from "./httpCache.js";

// Grant flows from OpenAlex: funder -> funded works -> grantee institutions.
// One funder per run (OPENALEX_FUNDER_ID, default Colgate-Palmolive, the parent
// under which Hill's Pet Nutrition grants are recorded). Amounts are funded-
// works counts — OpenAlex exposes no reliable dollar figures — so flowType
// "grant" means works, not USD. Polite: sequential calls, >=150 ms apart
// (keyless budget is 10/s shared; a key raises it).

const API = "https://api.openalex.org";
const DEFAULT_FUNDER = "https://openalex.org/F4320307808"; // Colgate-Palmolive Company

const MAX_FLOW_WORKS = 200; // first page only; cursor paging needs an API key
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
  return process.env.OPENALEX_CONTACT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";
}

function apiUrl(pathOrUrl: string, params: Record<string, string>): string {
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`);
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
  await throttle();
  const { data } = await axios.get<T>(url, {
    headers: { "User-Agent": contact(), Accept: "application/json" },
  });
  return data;
}

const shortId = (url: string): string => url.replace("https://openalex.org/", "");

// Empty/whitespace env values fall back to the default: `??` alone let ""
// through, which queried the API root and crashed downstream in geocoding.
export function resolveFunderId(
  env: string | undefined = process.env.OPENALEX_FUNDER_ID,
): string {
  return env?.trim() || DEFAULT_FUNDER;
}

export interface Funder {
  id: string;
  display_name: string;
  country_code: string | null;
  works_count: number;
}

interface WorkPage {
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

// The funder needs map coordinates for arcs. Env pin wins; otherwise Nominatim
// gets two tries (headquarters query first). Throws when unplaceable — dead
// arcs help nobody.
async function funderCoords(name: string): Promise<{ lat: number; lng: number }> {
  const lat = process.env.FUNDER_LAT;
  const lng = process.env.FUNDER_LNG;
  if (lat !== undefined && lng !== undefined) {
    return { lat: Number(lat), lng: Number(lng) };
  }
  for (const q of [`${name} headquarters`, name]) {
    const { data } = await axios.get<{ lat: string; lon: string }[]>(
      "https://nominatim.openstreetmap.org/search",
      {
        params: { format: "jsonv2", limit: 1, q },
        headers: {
          "User-Agent":
            process.env.NOMINATIM_USER_AGENT ??
            "WhoFundsIt/0.1 (contact: dev@example.com)",
          Accept: "application/json",
        },
      },
    );
    if (data[0]) {
      return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
    }
    await sleep(1100);
  }
  throw new Error(
    `could not geocode funder "${name}" — set FUNDER_LAT/FUNDER_LNG in backend/.env`,
  );
}

export interface FlowSummary {
  funder: string;
  works: number;
  institutions: number;
  flows: number;
  skippedNoGeo: number;
}

export async function runOpenAlexFlows(): Promise<FlowSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const funderId = resolveFunderId();
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const funder = await cachedJson<Funder>(
      `openalex/funder-${shortId(funderId)}.json`,
      () => oaGet<Funder>(apiUrl(funderId, {})),
    );
    assertValidFunder(funder, funderId);
    console.log(`[flows] funder: ${funder.display_name} (${funder.works_count} works)`);
    const funderAt = await cachedJson(
      `openalex/funder-geo-${shortId(funderId)}.json`,
      () => funderCoords(funder.display_name),
    );
    const funderKey = shortId(funder.id);
    const funderRowId = `openalex:${funderKey}`;

    const page = await cachedJson<WorkPage>(
      `openalex/works-${shortId(funderId)}-p1.json`,
      () =>
        oaGet<WorkPage>(
          apiUrl("/works", {
            filter: `funders.id:${funderId}`,
            "per-page": String(MAX_FLOW_WORKS),
            select: "id,display_name,authorships",
          }),
        ),
    );

    const byInst = new Map<
      string,
      { name: string; country: string | null; type: string; works: number }
    >();
    for (const work of page.results) {
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
      `[flows] ${page.results.length} works -> ${byInst.size} institutions (top ${top.length})`,
    );

    await prisma.entity.upsert({
      where: { id: funderRowId },
      create: {
        id: funderRowId,
        name: funder.display_name,
        type: "Funder",
        lat: funderAt.lat,
        lng: funderAt.lng,
        fundsVolume: page.results.length,
        rawAddressText: funder.country_code ?? "—",
        tickers: [],
        source: "openalex",
      },
      update: {
        name: funder.display_name,
        lat: funderAt.lat,
        lng: funderAt.lng,
        fundsVolume: page.results.length,
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
      works: page.results.length,
      institutions: byInst.size,
      flows,
      skippedNoGeo,
    };
  } finally {
    await prisma.$disconnect();
  }
}
