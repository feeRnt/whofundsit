const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  JPY: "¥",
  KRW: "₩",
  TWD: "NT$",
  GBP: "£",
  CHF: "CHF ",
  CNY: "¥",
  HKD: "HK$",
};

// Short location for tooltips: the stored tag (US-CT, LONDON EC2R…), or the
// trailing city + postcode of the street address when the tag is unknown.
export function displayLocation(entity: {
  rawAddressText: string;
  businessAddress: string | null;
}): string {
  if (entity.rawAddressText && entity.rawAddressText !== "—") {
    return entity.rawAddressText;
  }
  if (entity.businessAddress) {
    const parts = entity.businessAddress
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !/^[A-Z]\d$/.test(p));
    if (parts.length > 0) {
      return parts.slice(-2).join(", ");
    }
  }
  return "—";
}

// Native-unit money display (regional facts are never silently USD).
// Abbreviated past thousands: full digit strings ("$6,716,412,097") get
// misread at a glance, so large values render as $6.72B / $423B / $1.20T.
export function formatMoney(amount: number, currency?: string | null): string {
  const code = currency && currency.length > 0 ? currency : "USD";
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  const abs = Math.abs(amount);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [div, suffix] of units) {
    if (abs >= div) {
      const v = amount / div;
      const str = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      return `${symbol}${str}${suffix}`;
    }
  }
  return `${symbol}${amount.toLocaleString("en-US")}`;
}

// One primary metric per company, everywhere (hover, popup, dot size):
// Total assets — the most widely reported concept (5k+ rows, vs ~2k for
// revenue). Funds (purple 13F filers) show holdings value instead;
// OpenAlex rows show funded works. Without an Assets sibling the row's
// own concept is used and honestly labeled.
export function companyGroupKey(id: string): string {
  const head = id.split(":")[0] ?? id;
  return /^\d+$/.test(head) ? head : id;
}

export interface PrimaryMetric {
  label: string;
  text: string;
  volume: number;
}

export function primaryMetric(entity: Entity, pool: Entity[]): PrimaryMetric {
  if (entity.source === "openalex") {
    return {
      label: "Funded works",
      text: entity.fundsVolume.toLocaleString("en-US"),
      volume: entity.fundsVolume,
    };
  }
  if (entity.type === "Fund") {
    return {
      label: "Holdings value",
      text: formatMoney(entity.fundsVolume, entity.currency),
      volume: entity.fundsVolume,
    };
  }
  const key = companyGroupKey(entity.id);
  const assets =
    entity.conceptTag === "Assets"
      ? entity
      : pool.find(
          (e) => companyGroupKey(e.id) === key && e.conceptTag === "Assets",
        );
  if (assets) {
    return {
      label: "Total assets",
      text: formatMoney(assets.fundsVolume, assets.currency),
      volume: assets.fundsVolume,
    };
  }
  return {
    label: entity.conceptTag ?? "Reported value",
    text: formatMoney(entity.fundsVolume, entity.currency),
    volume: entity.fundsVolume,
  };
}

export interface Entity {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  fundsVolume: number;
  // Absent on rows seeded before multi-currency (implies USD).
  currency?: string | null;
  rawAddressText: string;
  businessAddress: string | null;
  tickers: string[];
  conceptTag: string | null;
  secFilingNumber: string | null;
  sourceTimeFrame: string | null;
  financialDate: string | null;
  form: string | null;
  filed: string | null;
  exchanges: string[];
  category: string | null;
  formerNames: string[];
  // Absent on rows seeded before industry:sync.
  industry?: string | null;
  source: string;
  // Merge provenance (absent on rows seeded before the merge tooling).
  mergedFrom?: { id: string; name: string; source: string }[] | null;
}

// Relative by default: same-origin in dev (Vite proxy) and in deploys
// (backend serves the built frontend). VITE_API_URL overrides for split setups.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

export async function fetchEntities(limit = 50000): Promise<Entity[]> {
  const res = await fetch(`${API_BASE}/api/entities?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  return (await res.json()) as Entity[];
}

export interface FlowEndpoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface Flow {
  id: string;
  amount: number;
  flowType: string;
  // 13F sleeves summed into amount (absent on older seeds).
  sleeves?: number;
  sourceEntityId: string;
  targetEntityId: string;
  sourceEntity: FlowEndpoint;
  targetEntity: FlowEndpoint;
}

export async function fetchFlows(limit = 50000): Promise<Flow[]> {
  const res = await fetch(`${API_BASE}/api/flows?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  return (await res.json()) as Flow[];
}

export interface Quote {
  ticker: string;
  changePct: number;
  close: number;
  date: string;
}

// Null on any failure (no count row yet): the popup falls back to
// tracked-relative mode instead of erroring.
export async function fetchShares(cik: string): Promise<number | null> {
  const res = await fetch(`${API_BASE}/api/shares?cik=${encodeURIComponent(cik)}`);
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as { shares: unknown };
  return typeof body.shares === "number" && Number.isFinite(body.shares) && body.shares > 0
    ? body.shares
    : null;
}

// Null on any failure (bad ticker, weekend, rate limit): the popup hides
// the row instead of erroring.
export async function fetchQuote(ticker: string): Promise<Quote | null> {
  const res = await fetch(
    `${API_BASE}/api/quote?ticker=${encodeURIComponent(ticker)}`,
  );
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as Quote;
}

// Methodology-audit snapshot (verify:claims): cell-level "% verified"
// scores. Null when no audit snapshot is deployed: badges hide instead
// of erroring.
export interface VerificationCell {
  cell: string;
  n: number;
  tested: number;
  passed: number;
  pctVerified: number | null;
  mean: number | null;
}

export interface VerificationReport {
  generatedAt: string;
  cells: VerificationCell[];
  overall: VerificationCell;
}

export async function fetchVerification(): Promise<VerificationReport | null> {
  try {
    const res = await fetch(`${API_BASE}/api/verification`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as Partial<VerificationReport>;
    if (!body || !Array.isArray(body.cells) || !body.overall) {
      return null;
    }
    return body as VerificationReport;
  } catch {
    return null;
  }
}

export function verificationCell(
  report: VerificationReport | null | undefined,
  name: string,
): VerificationCell | null {
  if (!report) {
    return null;
  }
  return report.cells.find((c) => c.cell === name) ?? null;
}
