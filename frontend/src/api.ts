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

export async function fetchEntities(limit = 5000): Promise<Entity[]> {
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

export async function fetchFlows(limit = 500): Promise<Flow[]> {
  const res = await fetch(`${API_BASE}/api/flows?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  return (await res.json()) as Flow[];
}
