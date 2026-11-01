// Equal-representation serving: /api/entities splits its limit evenly across
// six continent buckets (classified from coordinates, no text parsing), so
// small international rows survive the fundsVolume sort instead of being
// buried under SEC giants. Regions that can't fill their floor carry their
// shortfall to Europe; unknown rows ride with Europe too. Output stays
// volume-desc so sliders keep biggest-first semantics. Boxes are rough
// (border towns may misbucket); check order resolves overlaps.

export type Region =
  | "north-america"
  | "south-america"
  | "europe"
  | "africa"
  | "asia"
  | "oceania"
  | "unknown";

export function regionOf(lat: number, lng: number): Region {
  if (lng >= -82 && lng <= -34 && lat >= -56 && lat < 13) {
    return "south-america";
  }
  if (lng >= -170 && lng <= -52 && lat >= 7 && lat <= 72) {
    return "north-america";
  }
  if (lng >= -19 && lng <= 52 && lat >= -36 && lat < 37) {
    return "africa";
  }
  if (lng >= -25 && lng <= 40 && lat >= 36 && lat <= 72) {
    return "europe";
  }
  if (lng >= 40 && lng <= 180 && lat >= -10 && lat <= 76) {
    return "asia";
  }
  if (lng >= 110 && lng <= 180 && lat >= -50 && lat < 10) {
    return "oceania";
  }
  return "unknown";
}

const FLOOR_REGIONS: Region[] = [
  "north-america",
  "south-america",
  "europe",
  "africa",
  "asia",
  "oceania",
];

export function allocateRegionQuotas<
  T extends { fundsVolume: number; lat: number; lng: number },
>(rows: T[], limit: number): T[] {
  if (limit < FLOOR_REGIONS.length) {
    return [...rows].sort((a, b) => b.fundsVolume - a.fundsVolume).slice(0, limit);
  }
  const buckets = new Map<Region, T[]>();
  for (const r of rows) {
    const region = regionOf(r.lat, r.lng);
    const key = region === "unknown" ? "europe" : region;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => b.fundsVolume - a.fundsVolume);
  }
  const floor = Math.floor(limit / FLOOR_REGIONS.length);
  const out: T[] = [];
  let euExtra = limit - floor * FLOOR_REGIONS.length;
  for (const region of FLOOR_REGIONS) {
    if (region === "europe") {
      continue;
    }
    const list = buckets.get(region) ?? [];
    const take = Math.min(floor, list.length);
    out.push(...list.slice(0, take));
    euExtra += floor - take;
  }
  const eu = buckets.get("europe") ?? [];
  out.push(...eu.slice(0, floor + euExtra));
  out.sort((a, b) => b.fundsVolume - a.fundsVolume);
  return out.slice(0, limit);
}
