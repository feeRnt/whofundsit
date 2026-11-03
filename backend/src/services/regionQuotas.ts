// Equal-representation serving: /api/entities splits its limit evenly across
// six continent buckets (classified from coordinates, no text parsing), so
// small international rows survive the fundsVolume sort instead of being
// buried under SEC giants. Regions that can't fill their floor carry their
// shortfall to Europe; unknown rows ride with Europe too. Universities
// (type "education") carry works-count volumes that lose every dollar
// contest, so they get a carved quota of their own (shortfall back to the
// regions) instead of hiding behind the slider max. Output stays
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

// Flow layers served by /api/flows, in backfill-priority order: the 13F book
// (100k million-dollar rows) would otherwise fill the whole amount-desc
// cap and starve grants (work counts) and ownership (undisclosed
// stakes), leaving their submenus empty.
export const FLOW_TYPES = ["13f", "grant", "ownership"] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

// Even floors per flow type from placed-endpoint counts; unfilled floors
// flow to 13f first (headline layer), then the rest in FLOW_TYPES order.
// Quotas sum to at most the limit and never exceed their counts.
export function allocateFlowQuotas(
  counts: Record<FlowType, number>,
  limit: number,
): Record<FlowType, number> {
  const quotas: Record<FlowType, number> = {
    "13f": 0,
    grant: 0,
    ownership: 0,
  };
  if (limit <= 0) {
    return quotas;
  }
  const floor = Math.floor(limit / FLOW_TYPES.length);
  let used = 0;
  for (const t of FLOW_TYPES) {
    quotas[t] = Math.min(counts[t], floor);
    used += quotas[t];
  }
  let leftover = limit - used;
  for (const t of FLOW_TYPES) {
    if (leftover <= 0) {
      break;
    }
    const extra = Math.min(counts[t] - quotas[t], leftover);
    quotas[t] += extra;
    leftover -= extra;
  }
  return quotas;
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
  T extends { fundsVolume: number; lat: number; lng: number; type?: string },
>(rows: T[], limit: number): T[] {
  if (limit < FLOOR_REGIONS.length) {
    return [...rows].sort((a, b) => b.fundsVolume - a.fundsVolume).slice(0, limit);
  }
  // University carve-out (~8%, min 2): forced top-N by works count, never a
  // volume contest they can't win. Rows without a type are never counted,
  // keeping this a no-op for old callers; unfilled quota flows back to the
  // regional pool via the remainder limit.
  const isUni = (r: T): boolean =>
    typeof r.type === "string" && r.type.toLowerCase() === "education";
  const unis = rows.filter(isUni).sort((a, b) => b.fundsVolume - a.fundsVolume);
  const rest = rows.filter((r) => !isUni(r));
  const picked = unis.slice(
    0,
    Math.min(unis.length, limit, Math.max(2, Math.floor(limit / 12))),
  );
  const regional = allocateRegions(rest, limit - picked.length);
  const out = [...picked, ...regional];
  if (out.length < limit) {
    // Backfill never lets the quota under-fill: leftovers return in
    // volume order (unis included — floors are minimums, not maximums).
    const seen = new Set(out);
    const leftovers = rows
      .filter((r) => !seen.has(r))
      .sort((a, b) => b.fundsVolume - a.fundsVolume);
    out.push(...leftovers.slice(0, limit - out.length));
  }
  return out.sort((a, b) => b.fundsVolume - a.fundsVolume).slice(0, limit);
}

function allocateRegions<
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
