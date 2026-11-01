import axios from "axios";
import { apiLog, readCache, writeCache } from "./httpCache.js";
import { createRateLimiter } from "./pipeline.js";

// Shared OpenFIGI client (FIGI symbology is public-domain dedicated; see
// DATASETS.md). One limiter for every job in the process: the rate cap is
// per-IP, so two limiters would double it. Lookup keys (CUSIPs, ISINs — US
// ISINs embed a CUSIP) stay in the gitignored cache, never committed.
export const openfigiLimit = createRateLimiter(
  process.env.OPENFIGI_API_KEY ? 300 : 2500,
);

const MAPPING_URL = "https://api.openfigi.com/v3/mapping";

export interface FigiHit {
  ticker?: unknown;
  exchCode?: unknown;
  securityType?: unknown;
}

// One batched mapping POST; results align 1:1 with the request batch.
export async function postMapping(
  batch: { idType: "ID_CUSIP" | "ID_ISIN"; idValue: string }[],
): Promise<FigiHit[][]> {
  const key = process.env.OPENFIGI_API_KEY;
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
