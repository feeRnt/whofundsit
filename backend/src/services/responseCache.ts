// Shared in-memory response cache for the big read-only JSON endpoints
// (/api/entities, /api/flows). Tables only change when an ingest pipeline
// runs (separate process), so one JSON string serves every visitor instead
// of one Prisma fetch + stringify per request. In-flight dedup means ten
// simultaneous first loads run ONE query, not ten. New data appears at
// latest TTL after an ingest; restarting clears it. Size guard: arbitrary
// ?limit= values can't grow the map without bound.
const responseCache = new Map<string, { at: number; body: string }>();
const inflightBuilds = new Map<string, Promise<string>>();

export function clearResponseCache(): void {
  responseCache.clear();
  inflightBuilds.clear();
}

export async function cachedBody(
  key: string,
  ttlMs: number,
  build: () => Promise<unknown>,
): Promise<string> {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.body;
  }
  const running = inflightBuilds.get(key);
  if (running) {
    return running;
  }
  const run = (async () => {
    try {
      const body = JSON.stringify(await build());
      if (responseCache.size > 50) {
        responseCache.clear();
      }
      responseCache.set(key, { at: Date.now(), body });
      return body;
    } finally {
      inflightBuilds.delete(key);
    }
  })();
  inflightBuilds.set(key, run);
  return run;
}
