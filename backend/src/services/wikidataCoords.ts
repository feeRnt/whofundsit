// Wikidata P625 coordinates for lei: rows (formalized 2026-11-02).
//
// Coverage (live probe 2026-11-02, query.wikidata.org): of 4,934 Wikidata
// companies carrying ISIN (P946) + LEI (P1278), 4,692 (95%) expose coords
// via headquarters item (P159 -> P625) and 176 via direct P625. Our seed
// holds 5,544 lei: rows (2,960 placed / 2,584 unplaced); the P625 cohort
// is the Wikidata-listed parents — GLEIF children (subsidiaries) often
// have no Wikidata item, so expect a large minority, not all, of the
// unplaced lei: rows to resolve here. Coords are HQ-item level (often a
// city point, e.g. Carlsberg -> Copenhagen), NOT street level: dots land
// in the right city, marked approximate by provenance, never exact.
//
// This module is pure: no DB, no network. The coords:p625 script wires
// it to SPARQL + Prisma after the Nominatim run finishes.

export interface Coords {
  lat: number;
  lng: number;
}

export type P625Via = "hq" | "direct";

// Splice into the globalSync discovery SELECT (adds ?hqCoord ?coord).
export const HQ_COORD_SPARQL = [
  "  OPTIONAL { ?company wdt:P159 ?hq. OPTIONAL { ?hq wdt:P625 ?hqCoord. } }",
  "  OPTIONAL { ?company wdt:P625 ?coord. }",
].join("\n");

// WKT Point(lon lat) — LONGITUDE FIRST (GeoSPARQL), never swap. Null on
// anything else (multi-point, swapped/out-of-range, garbage).
export function parseWktPoint(value: unknown): Coords | null {
  if (typeof value !== "string") {
    return null;
  }
  const m = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(value.trim());
  if (!m) {
    return null;
  }
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

export interface SparqlBinding {
  lei?: { value?: unknown };
  hqCoord?: { value?: unknown };
  coord?: { value?: unknown };
}

// Bindings -> LEI -> coords. HQ-item coords win over direct company
// coords (the HQ item is the actual seat; direct is often a city too,
// but HQ is the documented chain used by the discovery query).
export function p625ByLei(
  bindings: SparqlBinding[],
): Map<string, { coords: Coords; via: P625Via }> {
  const out = new Map<string, { coords: Coords; via: P625Via }>();
  for (const b of bindings) {
    const lei = typeof b.lei?.value === "string" ? b.lei.value : null;
    if (!lei || out.has(lei)) {
      continue;
    }
    const hq = parseWktPoint(b.hqCoord?.value);
    if (hq) {
      out.set(lei, { coords: hq, via: "hq" });
      continue;
    }
    const direct = parseWktPoint(b.coord?.value);
    if (direct) {
      out.set(lei, { coords: direct, via: "direct" });
    }
  }
  return out;
}

// Which lei: rows a coords:p625 pass targets. --main takes the pending
// queue (mirrors pipeline pendingWhere for lei rows); --dead takes the
// LLM queue (geoStatus failed). Non-lei ids never match: SEC/13F rows
// have no Wikidata item in this cohort.
export function selectP625Leis(
  rows: { id: string; geoStatus: string }[],
  mode: "main" | "dead",
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.id.startsWith("lei:")) {
      continue;
    }
    const wanted = mode === "dead" ? r.geoStatus === "failed" : r.geoStatus !== "failed";
    if (wanted) {
      out.push(r.id.slice("lei:".length));
    }
  }
  return [...new Set(out)];
}
