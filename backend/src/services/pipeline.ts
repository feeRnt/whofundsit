import axios from "axios";
import { PrismaClient, type Entity } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Background pipeline: give ingested SEC entities real coordinates, and route
// shouty/complex names through the Modal Llama worker for normalization.
// "Missing" coordinates means the 0,0 ingest placeholders. Both outbound APIs
// are gated by in-memory rate limiters + a geocode cache, and every run is
// capped (ground-rules guardrails 1 & 2, Address Engine caching rule).
const MAX_ENTITIES_PER_RUN = 100;
const MAX_MODAL_CALLS_PER_RUN = 25;
const NOMINATIM_MIN_INTERVAL_MS = 1100; // Nominatim usage policy: <= 1 req/s
const MODAL_MIN_INTERVAL_MS = 250;

// Minimal in-memory rate limiter: one outbound call at a time, spaced out.
function createRateLimiter(minIntervalMs: number) {
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

const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

interface NominatimHit {
  lat: string;
  lon: string;
}

// rawAddressText is currently just a state code (e.g. "US-IL"), so first-pass
// hits land on state centroids; real addresses are the TODO.md follow-up.
async function geocode(
  rawAddressText: string,
): Promise<{ lat: number; lng: number } | null> {
  const cached = geocodeCache.get(rawAddressText);
  if (cached !== undefined) {
    return cached;
  }
  const result = await nominatim(async () => {
    const { data } = await axios.get<NominatimHit[]>(
      "https://nominatim.openstreetmap.org/search",
      {
        params: { format: "jsonv2", limit: 1, q: rawAddressText },
        headers: {
          // Nominatim requires a declared User-Agent. Override via env if needed.
          "User-Agent":
            process.env.NOMINATIM_USER_AGENT ??
            "WhoFundsIt/0.1 (contact: dev@example.com)",
          Accept: "application/json",
        },
      },
    );
    const hit = data[0];
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  });
  geocodeCache.set(rawAddressText, result);
  return result;
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
  try {
    const { data } = await modal(() =>
      axios.post(
        url,
        { text: `${entity.name} (${entity.rawAddressText})` },
        { headers: { "Content-Type": "application/json" }, timeout: 60000 },
      ),
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
  scanned: number; // entities considered (<= MAX_ENTITIES_PER_RUN)
  geocoded: number; // rows updated with real lat/lng
  normalized: number; // rows renamed by the Llama worker
  skipped: number; // no coordinates and no rename (scanned = updated + skipped)
}

export async function runPipeline(): Promise<PipelineSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const entities = await prisma.entity.findMany({
      where: { lat: 0, lng: 0 },
      take: MAX_ENTITIES_PER_RUN,
      orderBy: { fundsVolume: "desc" },
    });

    let geocoded = 0;
    let normalized = 0;
    let skipped = 0;
    let modalCalls = 0;

    for (const entity of entities) {
      const coords = await geocode(entity.rawAddressText);

      let canonicalName: string | null = null;
      if (
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

    return { scanned: entities.length, geocoded, normalized, skipped };
  } finally {
    await prisma.$disconnect();
  }
}
