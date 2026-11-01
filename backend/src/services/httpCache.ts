import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// File-backed JSON cache for every outbound API (SEC, OpenAlex, Nominatim,
// Modal): read-through, so repeat runs and testing never re-download what a
// previous run already fetched. Cache lives in gitignored backend/data/cache
// (ground-rules §4: raw downloads stay out of Git). Set CACHE_REFRESH=1 to
// re-fetch. Only successful responses are written.

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, "..", "..", "data", "cache");

export function cacheKey(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

// Audit trail for ToS conformity: one timestamped line per real outbound
// call (cache hits stay silent by design). Call at every axios site.
// Optional note (e.g. company name) correlates lookups with entities.
export function apiLog(method: string, url: string, note?: string): void {
  console.log(
    `[API] ${new Date().toISOString()} ${method} ${url}${note ? ` (${note})` : ""}`,
  );
}

export function readCache<T>(relPath: string): T | undefined {
  if (process.env.CACHE_REFRESH) {
    return undefined;
  }
  const dest = path.join(CACHE_DIR, relPath);
  if (!fs.existsSync(dest)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(dest, "utf8")) as T;
}

export function writeCache(relPath: string, data: unknown): void {
  const dest = path.join(CACHE_DIR, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data));
}

export async function cachedJson<T>(
  relPath: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = readCache<T>(relPath);
  if (hit !== undefined) {
    return hit;
  }
  const data = await fetcher();
  writeCache(relPath, data);
  return data;
}

// Day-scoped cache for SEC ingest responses (frames, submissions,
// companyfacts): keys are namespaced by UTC date, so every calendar day
// re-fetches fresh while intraday reruns stay free. Old day-dirs linger on
// disk (gitignored; wipe by hand when stale). Everything else stays on
// plain cachedJson: nothing is ever pruned automatically.
export async function cachedJsonDaily<T>(
  relPath: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  return cachedJson<T>(
    `daily/${new Date().toISOString().slice(0, 10)}/${relPath}`,
    fetcher,
  );
}
