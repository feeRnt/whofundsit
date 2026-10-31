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

// Native-unit money display (regional facts are never silently USD).
export function formatMoney(amount: number, currency?: string | null): string {
  const code = currency && currency.length > 0 ? currency : "USD";
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
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
  source: string;
  // Merge provenance (absent on rows seeded before the merge tooling).
  mergedFrom?: { id: string; name: string; source: string }[] | null;
}

// Relative by default: same-origin in dev (Vite proxy) and in deploys
// (backend serves the built frontend). VITE_API_URL overrides for split setups.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

export async function fetchEntities(limit = 500): Promise<Entity[]> {
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
