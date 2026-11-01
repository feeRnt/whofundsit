import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cachedJson } from "./httpCache.js";

// EU/UK financial facts from the ESEF repository (filings.xbrl.org): per-LEI
// filing lookup, latest xBRL-JSON facts, Assets preferred, Revenue fallback.
// LEI-native, so it joins global:sync rows directly. No key, no stated rate
// limit; polite + cached anyway. Row ceiling: ESEF_LIMIT (default 500).
// NOTE: repository ToS is unstated (see DATASETS.md) — small-scale use only.

const ESEF = "https://filings.xbrl.org/api";
const UA =
  process.env.WIKIDATA_USER_AGENT ?? "WhoFundsIt/0.1 (contact: dev@example.com)";

export interface EsefFact {
  value: number;
  currency: string;
  periodEnd: string;
}

interface XbrlJsonFact {
  value?: unknown;
  decimals?: unknown;
  dimensions?: {
    concept?: unknown;
    period?: unknown;
    unit?: unknown;
  };
}

// Latest Assets (instant) wins; Revenue (duration) is the fallback. decimals
// scales the value (xBRL spec: value * 10^decimals). Pure + unit-tested.
export function extractEsefFacts(doc: {
  facts?: Record<string, XbrlJsonFact>;
}): { assets?: EsefFact; revenue?: EsefFact } {
  const out: { assets?: EsefFact; revenue?: EsefFact } = {};
  for (const fact of Object.values(doc.facts ?? {})) {
    const concept =
      typeof fact.dimensions?.concept === "string"
        ? fact.dimensions.concept
        : "";
    const slot =
      concept === "ifrs-full:Assets"
        ? "assets"
        : concept === "ifrs-full:Revenue"
          ? "revenue"
          : null;
    if (!slot) {
      continue;
    }
    const raw = Number(fact.value);
    if (!Number.isFinite(raw)) {
      continue;
    }
    const dec = Number(fact.decimals);
    const value = Number.isFinite(dec) ? raw * Math.pow(10, dec) : raw;
    const period =
      typeof fact.dimensions?.period === "string"
        ? fact.dimensions.period
        : "";
    const periodEnd = period.includes("/") ? period.split("/")[1] : period;
    const unit =
      typeof fact.dimensions?.unit === "string" ? fact.dimensions.unit : "";
    const currency = unit.startsWith("iso4217:") ? unit.slice(8) : "";
    if (!periodEnd || !currency) {
      continue;
    }
    const prev = out[slot];
    if (!prev || periodEnd > prev.periodEnd) {
      out[slot] = { value, currency, periodEnd };
    }
  }
  return out;
}

const ESEF_ORIGIN = "https://filings.xbrl.org";

export interface EsefFilingItem {
  json_url?: unknown;
  period_end?: unknown;
}

// ESEF period strings are format-free ("2024", "2024-12-31", ...); unparsable
// ones yield null rather than an Invalid Date that would kill the run.
export function toFinancialDate(periodEnd: string): Date | null {
  const d = new Date(periodEnd);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Latest filing's xBRL-JSON as an absolute URL. Items are JSON:API
// attributes (verified live: relative json_url, period_end sort key).
// Pure + unit-tested.
export function pickLatestJsonUrl(filings: EsefFilingItem[]): string | null {
  let best: { url: string; end: string } | null = null;
  for (const f of filings) {
    if (typeof f.json_url !== "string" || !f.json_url) {
      continue;
    }
    const end = typeof f.period_end === "string" ? f.period_end : "";
    if (!end) {
      continue;
    }
    if (!best || end > best.end) {
      best = { url: f.json_url, end };
    }
  }
  if (!best) {
    return null;
  }
  return best.url.startsWith("http")
    ? best.url
    : `${ESEF_ORIGIN}${best.url}`;
}

async function latestJsonUrl(lei: string): Promise<string | null> {
  const doc = await cachedJson<{
    data?: { attributes?: EsefFilingItem }[];
  }>(`regional/esef-filings/${lei}.json`, async () => {
    await new Promise((r) => setTimeout(r, 250));
    return (
      await axios.get(`${ESEF}/entities/${lei}/filings`, {
        // sort=-date 400s (no such attribute); -period_end verified live.
        params: { "page[size]": 10, sort: "-period_end" },
        headers: {
          "User-Agent": UA,
          Accept: "application/vnd.api+json",
        },
        timeout: 60000,
      })
    ).data;
  });
  if (!Array.isArray(doc.data)) {
    return null;
  }
  return pickLatestJsonUrl(doc.data.map((f) => f.attributes ?? {}));
}

export async function runRegionalEsef(): Promise<{
  considered: number;
  updated: number;
  skipped: string[];
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const limit = Math.max(1, Number(process.env.ESEF_LIMIT ?? 500));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const skipped: string[] = [];
  let updated = 0;
  try {
    const rows = await prisma.entity.findMany({
      where: { id: { startsWith: "lei:" } },
      select: { id: true, name: true },
      take: limit,
    });
    if (rows.length === 0) {
      throw new Error("[esef] no lei: entities — run npm run global:sync first");
    }
    for (const row of rows) {
      const lei = row.id.slice("lei:".length);
      let jsonUrl: string | null;
      try {
        jsonUrl = await latestJsonUrl(lei);
      } catch (err) {
        // 404 = not an ESEF filer (US companies, funds); anything else
        // carries its status so the next failure is diagnosable.
        const status = axios.isAxiosError(err)
          ? err.response?.status
          : undefined;
        skipped.push(
          status === 404
            ? `${row.name} (no ESEF filing)`
            : `${row.name} (filings lookup failed${status ? ` HTTP ${status}` : ""})`,
        );
        continue;
      }
      if (!jsonUrl) {
        skipped.push(`${row.name} (no ESEF filing)`);
        continue;
      }
      let facts: { assets?: EsefFact; revenue?: EsefFact };
      try {
        const doc = await cachedJson<{ facts?: Record<string, XbrlJsonFact> }>(
          `regional/esef-facts/${lei}.json`,
          async () => {
            await new Promise((r) => setTimeout(r, 250));
            return (
              await axios.get(jsonUrl, {
                headers: { "User-Agent": UA },
                timeout: 120000,
              })
            ).data;
          },
        );
        facts = extractEsefFacts(doc);
      } catch {
        skipped.push(`${row.name} (facts download failed)`);
        continue;
      }
      const pick = facts.assets
        ? { ...facts.assets, conceptTag: "Assets" }
        : facts.revenue
          ? { ...facts.revenue, conceptTag: "Revenues" }
          : null;
      if (!pick) {
        skipped.push(`${row.name} (no Assets/Revenue fact)`);
        continue;
      }
      try {
        await prisma.entity.update({
          where: { id: row.id },
          data: {
            fundsVolume: pick.value,
            conceptTag: pick.conceptTag,
            financialDate: toFinancialDate(pick.periodEnd),
            currency: pick.currency,
            sourceTimeFrame: pick.periodEnd.slice(0, 10),
          },
        });
      } catch {
        skipped.push(`${row.name} (DB update failed)`);
        continue;
      }
      updated += 1;
    }
    return { considered: rows.length, updated, skipped };
  } finally {
    await prisma.$disconnect();
  }
}
