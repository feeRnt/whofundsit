import axios from "axios";
import { apiLog, readCache, writeCache } from "./httpCache.js";

// Day-change quotes via Stooq's free CSV (no key; free for personal/demo
// use). Cached 15 minutes: fresh enough for a demo, polite to the free
// tier. Failures yield null (popup hides the row); a stale cache beats
// nothing when the network fails.

const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface Quote {
  changePct: number;
  close: number;
  date: string;
}

export function stooqSymbol(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(t)) {
    return null;
  }
  return `${t.toLowerCase().replace(/\./g, "-")}.us`;
}

export function parseStooqCsv(
  text: string,
): { open: number; close: number; date: string } | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) {
    return null;
  }
  const fields = (lines[1] ?? "").split(",");
  const date = fields[1] ?? "";
  const open = Number(fields[3]);
  const close = Number(fields[6]);
  if (!date || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0) {
    return null;
  }
  return { open, close, date };
}

export function changePct(open: number, close: number): number | null {
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) {
    return null;
  }
  return ((close - open) / open) * 100;
}

interface QuoteCache {
  at: number;
  quote: Quote | null;
}

export async function getQuote(ticker: string): Promise<Quote | null> {
  const symbol = stooqSymbol(ticker);
  if (!symbol) {
    return null;
  }
  const rel = `quotes/${symbol}.json`;
  const hit = readCache<QuoteCache>(rel);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) {
    return hit.quote;
  }
  const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`;
  apiLog("GET", url, ticker);
  let quote: Quote | null = null;
  try {
    const res = await axios.get<string>(url, { timeout: 10000 });
    const parsed = parseStooqCsv(res.data);
    if (parsed) {
      const pct = changePct(parsed.open, parsed.close);
      if (pct !== null) {
        quote = { changePct: pct, close: parsed.close, date: parsed.date };
      }
    }
  } catch {
    if (hit) {
      return hit.quote;
    }
    return null;
  }
  writeCache(rel, { at: Date.now(), quote });
  return quote;
}
