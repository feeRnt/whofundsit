export interface Entity {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  fundsVolume: number;
  rawAddressText: string;
  businessAddress: string | null;
  conceptTag: string | null;
  secFilingNumber: string | null;
  sourceTimeFrame: string | null;
  financialDate: string | null;
  form: string | null;
  filed: string | null;
  exchanges: string[];
  category: string | null;
  formerNames: string[];
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
