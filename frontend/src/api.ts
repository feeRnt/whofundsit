export interface Entity {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  fundsVolume: number;
  rawAddressText: string;
  secFilingNumber: string | null;
  sourceTimeFrame: string | null;
  financialDate: string | null;
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
