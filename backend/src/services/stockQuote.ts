import axios from "axios";
import { apiLog, readCache, writeCache } from "./httpCache.js";

// Day-change quotes via Yahoo's chart API (no key; tiny demo traffic).
// NOTE — ToS judgment call: Yahoo's terms discourage automated access, but
// this is the same public endpoint every OSS quote widget uses, hit at most
// once per ticker per day and cached below. If it ever 429s, the popup
// just hides the row (null) and the failure is apiLogged.
// (Stooq was the previous source; it now serves bot-wall HTML/JS to
// server-side fetches, so quotes silently vanished.)

const QUOTE_TTL_MS = 24 * 60 * 60 * 1000;
const UA =
  process.env.QUOTE_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";

export interface Quote {
  changePct: number;
  close: number;
  date: string;
}

export function yahooSymbol(ticker: string): string | null {
  const t = ticker.trim().toUpperCase().replace(/\./g, "-");
  if (!/^[A-Z0-9-]{1,12}$/.test(t)) {
    return null;
  }
  return t;
}

export function parseYahooChart(
  json: unknown,
): { previousClose: number; price: number; date: string } | null {
  const meta = (json as { chart?: { result?: [{ meta?: unknown }] } })?.chart
    ?.result?.[0]?.meta as
    | {
        regularMarketPrice?: unknown;
        chartPreviousClose?: unknown;
        regularMarketTime?: unknown;
      }
    | undefined;
  if (!meta) {
    return null;
  }
  const price = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.chartPreviousClose);
  const t = Number(meta.regularMarketTime);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(previousClose) ||
    previousClose <= 0 ||
    !Number.isFinite(t)
  ) {
    return null;
  }
  return {
    previousClose,
    price,
    date: new Date(t * 1000).toISOString().slice(0, 10),
  };
}

export function changePct(open: number, close: number): number | null {
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) {
    return null;
  }
  return ((close - open) / open) * 100;
}

interface QuoteCache {
  at: number;
  quote: Quote;
}

export async function getQuote(ticker: string): Promise<Quote | null> {
  const symbol = yahooSymbol(ticker);
  if (!symbol) {
    return null;
  }
  const rel = `quotes/${symbol}.json`;
  const hit = readCache<QuoteCache>(rel);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) {
    apiLog("CACHE-HIT", rel, ticker);
    return hit.quote;
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  apiLog("GET", url, ticker);
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const parsed = parseYahooChart(res.data);
    const pct = parsed ? changePct(parsed.previousClose, parsed.price) : null;
    if (!parsed || pct === null) {
      apiLog("FAIL", url, `${ticker} (unparseable response)`);
      return null;
    }
    const quote: Quote = {
      changePct: pct,
      close: parsed.price,
      date: parsed.date,
    };
    // Cache wins only: a failure must never poison the cache for 24h.
    writeCache(rel, { at: Date.now(), quote });
    return quote;
  } catch {
    if (hit) {
      apiLog("FAIL", url, `${ticker} (serving stale cache)`);
      return hit.quote;
    }
    apiLog("FAIL", url, `${ticker} (no cache)`);
    return null;
  }
}
