import axios from "axios";
import { apiLog, green, red } from "./httpCache.js";

// US Census batch geocoder: free, no key, US-only, 10k addresses per call.
// Request CSV (no header — a header line comes back No_Match):
// id,street,city,state,zip via multipart field "addressFile" (.csv name
// required) + benchmark. Response CSV per row: id, input address,
// Match/No_Match/Tie, Exact/Non_Exact, matched address, "lon,lat",
// TIGER line id, side. Coordinates are LONGITUDE first — never swap.
// Spec: geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
// (response columns cross-checked against a curated mirror; the official
// doc omits them). MAF/TIGER source; no stated rate limit (built bulk).

const BATCH_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const BENCHMARK = "Public_AR_Current";
export const CENSUS_BATCH_LIMIT = 10000;

export interface ParsedUsAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

const ZIP = /^\d{5}(?:-\d{4})?$/;
const STATE_ZIP = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;
// Valid state/territory codes (Census covers PR + Island Areas too): the
// tail match alone also catches foreign pairs ("UR,, 50450" Kuala Lumpur),
// so both the parser and the flag check membership here.
const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(
    " ",
  ),
);

// Splits SEC-shaped one-liners ("600 GRANT ST, PITTSBURGH, PA, 15219-2800")
// into Census components. Conservative: GLEIF US rows carry no state code
// ("1209 ORANGE ST, 19801 WILMINGTON, US") and foreign rows no US zip —
// both return null and keep the Nominatim path. Streets need a digit
// (Census requires a structure number). Pure for testing.
export function parseUsAddress(text: string): ParsedUsAddress | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) {
    return null;
  }
  let city: string;
  let state: string;
  let zip: string;
  let streetParts: string[];
  const tail = parts[parts.length - 1];
  const merged = STATE_ZIP.exec(tail);
  if (merged && parts.length >= 3 && US_STATE_CODES.has(merged[1])) {
    [, state, zip] = merged;
    city = parts[parts.length - 2];
    streetParts = parts.slice(0, -2);
  } else if (
    ZIP.test(tail) &&
    parts.length >= 4 &&
    US_STATE_CODES.has(parts[parts.length - 2])
  ) {
    zip = tail;
    state = parts[parts.length - 2];
    city = parts[parts.length - 3];
    streetParts = parts.slice(0, -3);
  } else {
    // No zip-less branch: a bare "CITY, XX" tail cannot tell a US state
    // from a country code (live: Canadian CA, German DE, Israeli IL all
    // mis-parsed as states), and the false positives outnumber the hits.
    // The zip is the disambiguator; zipless rows belong to the LLM pass,
    // which reads semantics instead of shapes.
    return null;
  }
  const street = streetParts.join(", ");
  if (!street || !city || !/\d/.test(street)) {
    return null;
  }
  // Census matches street ranges only: PO boxes always No_Match, so skip
  // the wasted slot (Nominatim and the LLM queue own them instead).
  if (/p\.?\s*o\.?\s*box/i.test(street)) {
    return null;
  }
  return { street, city, state, zip };
}

// US-shaped but rejected by the parser (GLEIF stateless rows, digitless
// streets): red unparseable line each. Everything else logs a plain
// foreign-skipped line, so every row's disposition is visible.
export function isUsShaped(text: string): boolean {
  if (/,\s*usa?\s*$/i.test(text)) {
    return true;
  }
  const m = /([A-Z]{2})[, ]+\d{5}(?:-\d{4})?\s*$/.exec(text);
  return m !== null && US_STATE_CODES.has(m[1]);
}

// Minimal quote-aware CSV splitter (double-quote escaping); the Census
// matched-address and "lon,lat" fields arrive quoted with inner commas.
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCensusCsv(
  rows: { id: string; addr: ParsedUsAddress }[],
): string {
  return (
    rows
      .map(({ id, addr }) =>
        [id, addr.street, addr.city, addr.state, addr.zip]
          .map(csvField)
          .join(","),
      )
      .join("\n") + "\n"
  );
}

// US bounds incl. AK/HI/PR/VI: swapped or garbage coords become misses,
// never dots in the ocean. Non_Exact (interpolated along the range) still
// counts — street-level, far better than a centroid or nothing.
function inUsBounds(lat: number, lng: number): boolean {
  return lat >= 17 && lat <= 72 && lng >= -180 && lng <= -60;
}

export function parseCensusResponse(
  text: string,
): Map<string, { lat: number; lng: number } | null> {
  const out = new Map<string, { lat: number; lng: number } | null>();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = splitCsvLine(line);
    const id = fields[0] ?? "";
    if (!id) {
      continue;
    }
    let coords: { lat: number; lng: number } | null = null;
    if (fields[2] === "Match") {
      const [lonRaw, latRaw] = (fields[5] ?? "").split(",");
      const lat = Number((latRaw ?? "").trim());
      const lng = Number((lonRaw ?? "").trim());
      if (Number.isFinite(lat) && Number.isFinite(lng) && inUsBounds(lat, lng)) {
        coords = { lat, lng };
      }
    }
    out.set(id, coords);
  }
  return out;
}

// One POST per 10k rows (our batches are <=500: always one call). Throws
// on transport errors — the caller degrades to Nominatim, never to
// failed. Per-row No_Match/Tie read as null (same fallback).
export async function censusBatchGeocode(
  rows: Map<string, ParsedUsAddress>,
): Promise<Map<string, { lat: number; lng: number } | null>> {
  const out = new Map<string, { lat: number; lng: number } | null>();
  const entries = [...rows.entries()];
  for (let i = 0; i < entries.length; i += CENSUS_BATCH_LIMIT) {
    const chunk = entries.slice(i, i + CENSUS_BATCH_LIMIT);
    const csv = buildCensusCsv(
      chunk.map(([id, addr], j) => ({ id: String(i + j), addr })),
    );
    const form = new FormData();
    form.append("addressFile", new Blob([csv], { type: "text/csv" }), "batch.csv");
    form.append("benchmark", BENCHMARK);
    apiLog("POST", BATCH_URL, `${chunk.length} addresses`);
    const { data } = await axios.post<string>(BATCH_URL, form, {
      timeout: 180000,
      responseType: "text",
    });
    const parsed = parseCensusResponse(typeof data === "string" ? data : "");
    chunk.forEach(([query, addr], j) => {
      const coords = parsed.get(String(i + j)) ?? null;
      out.set(query, coords);
      const line =
        `[census] ${query} | [street, city, state, zip] = ` +
        `[${addr.street}, ${addr.city}, ${addr.state}, ${addr.zip}] -> ` +
        `${coords ? `${coords.lat},${coords.lng}` : "miss"}`;
      console.log(coords ? green(line) : red(line));
    });
  }
  return out;
}
