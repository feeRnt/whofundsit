import axios from "axios";
import { apiLog, readCache, writeCache } from "./httpCache.js";
import { createRateLimiter } from "./pipeline.js";

// Shared OpenFIGI client (FIGI symbology is public-domain dedicated; see
// DATASETS.md). One limiter for every job in the process: the keyless cap is
// per-IP, so two limiters would double it. Lookup keys (CUSIPs, ISINs — US
// ISINs embed a CUSIP) stay in the gitignored cache, never committed.
//
// NOTE on limits (verified 2026-11-02): the legal Terms of Service say
// nothing about throttling (pure public-domain dedication), but the API
// documentation publishes a technically-enforced throttle — mapping API:
// 25 req/min x 10 jobs keyless, 250 x 100 with a free key, per IP/key in 60s
// windows, signaled by 429s + ratelimit-* headers. Liberal reading = run AT
// the documented ceiling (~96%), never past it: keyless neighbors on a
// shared (carrier-NAT) IP count against the same 25/min, so prefer a key.
// postMapping retries 429/5xx below, honoring the reset headers.
export const OPENFIGI_KEYLESS_INTERVAL_MS = 2500;
export const OPENFIGI_KEYED_INTERVAL_MS = 250;
export const openfigiLimit = createRateLimiter(
  process.env.OPENFIGI_API_KEY
    ? OPENFIGI_KEYED_INTERVAL_MS
    : OPENFIGI_KEYLESS_INTERVAL_MS,
);

const MAPPING_URL = "https://api.openfigi.com/v3/mapping";

export interface FigiHit {
  ticker?: unknown;
  exchCode?: unknown;
  securityType?: unknown;
}

// One batched mapping POST; results align 1:1 with the request batch.
// Retries 429/5xx (3 tries), honoring the reset headers — a bare throw here
// used to kill the whole 13F run.
export async function postMapping(
  batch: { idType: "ID_CUSIP" | "ID_ISIN"; idValue: string }[],
): Promise<FigiHit[][]> {
  const key = process.env.OPENFIGI_API_KEY;
  for (let attempt = 1; ; attempt += 1) {
    try {
      apiLog("POST", MAPPING_URL);
      const { data } = await openfigiLimit(() =>
        axios.post<{ data?: FigiHit[] }[]>(MAPPING_URL, batch, {
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "X-OPENFIGI-APIKEY": key } : {}),
          },
          timeout: 60000,
        }),
      );
      return data.map((r) => r.data ?? []);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const retryable =
        status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= 3) {
        throw err;
      }
      const reset = Number(
        axios.isAxiosError(err)
          ? (err.response?.headers?.["retry-after"] ??
            err.response?.headers?.["ratelimit-reset"])
          : NaN,
      );
      const waitMs =
        Number.isFinite(reset) && reset > 0 && reset <= 120
          ? reset * 1000
          : 15000 * attempt;
      console.warn(
        `[openfigi] HTTP ${status}, retry ${attempt}/3 in ${waitMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ISIN listings span every exchange worldwide: prefer common stock anywhere,
// else the first tickered row. (CUSIP-side picking stays US-biased in
// thirteenF's pickTicker.)
export function pickIsinTicker(
  results: FigiHit[],
): { ticker: string; exchCode: string } | null {
  const rows = results.filter(
    (r): r is { ticker: string; exchCode: string; securityType: unknown } =>
      typeof r.ticker === "string" &&
      r.ticker.length > 0 &&
      typeof r.exchCode === "string" &&
      r.exchCode.length > 0,
  );
  if (rows.length === 0) {
    return null;
  }
  const best =
    rows.find((r) => r.securityType === "Common Stock") ?? rows[0];
  return { ticker: best.ticker, exchCode: best.exchCode };
}

const ISIN_MAP_CACHE = "openfigi/isin-map.json";

type IsinEntry = { ticker: string; exchCode: string } | null;

// ISIN -> primary listing via OpenFIGI. Ephemeral keys, persisted map:
// ISINs are only ever lookup keys, never committed anywhere new.
export async function resolveIsinTickers(
  isins: string[],
): Promise<Map<string, IsinEntry>> {
  const map = new Map<string, IsinEntry>(
    Object.entries(readCache<Record<string, IsinEntry>>(ISIN_MAP_CACHE) ?? {}),
  );
  const missing = [...new Set(isins)].filter(
    (c) => c.length > 0 && !map.has(c),
  );
  if (missing.length === 0) {
    return map;
  }
  const batchSize = process.env.OPENFIGI_API_KEY ? 100 : 10;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const pages = await postMapping(
      batch.map((c) => ({ idType: "ID_ISIN", idValue: c })),
    );
    batch.forEach((c, j) => {
      map.set(c, pickIsinTicker(pages[j] ?? []));
    });
    writeCache(ISIN_MAP_CACHE, Object.fromEntries(map));
  }
  return map;
}
