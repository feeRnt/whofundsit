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

// Credential scrubber for the audit trail: query params that carry secrets
// (OpenAlex api_key today; token/secret shapes tomorrow) are masked before
// the URL hits the log, so terminal history and pasted logs stay safe.
export function redactUrlSecrets(url: string): string {
  return url.replace(
    /([?&](?:api_key|apikey|key|token|access_token|auth_token|secret|client_secret|password)=)[^&]*/g,
    "$1***",
  );
}

// Audit trail for ToS conformity: one timestamped line per real outbound
// call (cache hits stay silent by design). Call at every axios site.
// Optional note (e.g. company name) correlates lookups with entities and
// prints as [for: X] — never parentheses, which read as part of the URL.
export function apiLog(method: string, url: string, note?: string): void {
  console.log(
    `[API] ${new Date().toISOString()} ${method} ${redactUrlSecrets(url)}${note ? ` [for: ${note}]` : ""}`,
  );
}

// Outcome colors for address lines (green placed, red missed): ANSI only
// on a live TTY without NO_COLOR, so piped logs and files stay clean.
function paint(code: string, s: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return s;
  }
  return `\x1b[${code}m${s}\x1b[0m`;
}

export const green = (s: string): string => paint("32", s);
export const red = (s: string): string => paint("31", s);

// Retryable HTTP statuses, shared by every API fetcher: 429 (throttled)
// and 5xx (server trouble). Everything else (4xx, network errors without
// a status) throws immediately.
export function isRetryableHttpStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

// Warn-once guard for User-Agent variables: an unset var, an empty one, or
// the "Your Name you@example.com" example placeholder left unfilled can draw
// SEC 403s and Nominatim blocks. Returns the configured value, else the
// fallback. Every service routes its UA through here.
const warnedUA = new Set<string>();
export function userAgentFromEnv(
  name: string,
  fallback = "WhoFundsIt/0.1 (contact: dev@example.com)",
): string {
  const v = process.env[name];
  const bad =
    v === undefined || v.length === 0 || v.includes("example.com");
  if (!bad) {
    return v;
  }
  if (!warnedUA.has(name)) {
    warnedUA.add(name);
    console.warn(
      `[config] ${name} is ${v === undefined || v.length === 0 ? "not set" : "still the example placeholder"} — using fallback UA (SEC 403s and Nominatim blocks trace back to this; set it in backend/.env)`,
    );
  }
  return fallback;
}

export function readCache<T>(relPath: string): T | undefined {
  if (process.env.CACHE_REFRESH) {
    return undefined;
  }
  const dest = path.join(CACHE_DIR, relPath);
  if (!fs.existsSync(dest)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(dest, "utf8")) as T;
  } catch (err) {
    if ((err as { code?: unknown })?.code !== "EIO") {
      throw err;
    }
    // Disk blip: one immediate retry, then treat as a miss (the caller
    // re-fetches or rebuilds) instead of killing the run.
    try {
      return JSON.parse(fs.readFileSync(dest, "utf8")) as T;
    } catch (retryErr) {
      console.warn(`[cache] EIO reading ${relPath}, treating as a miss (${retryErr})`);
      return undefined;
    }
  }
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
