import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  type FormalizedAddress,
  type FormalizeResult,
} from "./addressFormalize.js";
import { type ParsedUsAddress, isUsShaped } from "./censusBatch.js";
import { green, red } from "./httpCache.js";
import { censusGeocode, geocodeLocal, geocodeRemote } from "./pipeline.js";

// LLM repair passes: formalize (GPU) writes llm-pass-N.json, coords:populate
// --llm-N geocodes it. Success rows are marked and skipped forever; misses
// stay unmarked for the next --pass. Pass files live next to the geocode
// cache (gitignored working state, like dead-lines).

export interface LlmPassRow {
  id: string; // entity id (company identifier back to the DB row)
  name: string;
  original: string;
  pass: number;
  formalized: FormalizedAddress | null;
  notes: string;
  failureCause: string | null; // llm-side cause, null when parsed
  status: "pending" | "success" | "failed"; // geocode outcome
  triedText: string | null; // what Nominatim/Census actually saw
  lat: number | null;
  lng: number | null;
}

export function llmPassFile(pass: number): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "data", "cache", "geo", `llm-pass-${pass}.json`);
}

export function readPassFile(pass: number, file: string = llmPassFile(pass)): LlmPassRow[] {
  if (!fs.existsSync(file)) {
    throw new Error(
      `no llm-pass-${pass}.json — run formalize:addresses --pass=${pass} first`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`llm-pass-${pass}.json is not an array`);
  }
  return raw as LlmPassRow[];
}

export function writePassFile(
  pass: number,
  rows: LlmPassRow[],
  file: string = llmPassFile(pass),
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

// Pair model replies back to their inputs as fresh pending rows. Pure.
export function toPassRows(
  inputs: { id: string; name: string; original: string }[],
  results: FormalizeResult[],
  pass: number,
): LlmPassRow[] {
  return inputs.map((input, i) => {
    const r = results[i];
    return {
      id: input.id,
      name: input.name,
      original: input.original,
      pass,
      formalized: r && !r.failureCause ? r.address : null,
      notes: r?.notes ?? "missing model reply",
      failureCause: r ? r.failureCause : "llm-call-failed",
      status: "pending",
      triedText: null,
      lat: null,
      lng: null,
    };
  });
}

// Nominatim structured search fields (it takes field params, not a JSON
// body): street/city/state/postalcode/country. Pure.
export function structuredParams(a: FormalizedAddress): Record<string, string> {
  const out: Record<string, string> = {};
  const street = [a.houseNumber, a.street].filter(Boolean).join(" ");
  if (street) {
    out.street = street;
  }
  if (a.city) {
    out.city = a.city;
  }
  if (a.stateOrRegion) {
    out.state = a.stateOrRegion;
  }
  if (a.postalCode) {
    out.postalcode = a.postalCode;
  }
  if (a.country) {
    out.country = a.country;
  } else if (a.countryCode) {
    out.country = a.countryCode;
  }
  return out;
}

// One-line fallback for q= search and Modal batches. Pure.
export function oneLine(a: FormalizedAddress): string {
  return [
    [a.houseNumber, a.street].filter(Boolean).join(" "),
    a.city,
    a.stateOrRegion,
    a.postalCode,
    a.country ?? a.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

// Census needs all four components; anything less falls to Nominatim. Pure.
export function toCensusRow(a: FormalizedAddress): ParsedUsAddress | null {
  const street = [a.houseNumber, a.street].filter(Boolean).join(" ");
  if (!street || !a.city || !a.stateOrRegion || !a.postalCode) {
    return null;
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(a.postalCode)) {
    return null;
  }
  return { street, city: a.city, state: a.stateOrRegion, zip: a.postalCode };
}

export interface LlmPassSummary {
  pass: number;
  total: number;
  skipped: number;
  scanned: number;
  placed: number;
  failed: number;
  census: number;
  nominatim: number;
}

// Geocode one pass file: Census first for complete US rows, Nominatim
// structured for the rest. Hits update the DB + mark success; misses stay
// unmarked for the next pass. Success rows are never re-queried.
export async function runLlmPass(pass: number): Promise<LlmPassSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const rows = readPassFile(pass);
  const todo = rows.filter((r) => r.status !== "success");
  const summary: LlmPassSummary = {
    pass,
    total: rows.length,
    skipped: rows.length - todo.length,
    scanned: todo.length,
    placed: 0,
    failed: 0,
    census: 0,
    nominatim: 0,
  };
  if (todo.length === 0) {
    return summary;
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    // US rows with complete fields go to Census in one batched POST.
    const censusRows = new Map<string, ParsedUsAddress>();
    const censusIds = new Map<string, LlmPassRow[]>();
    for (const row of todo) {
      if (!row.formalized) {
        continue;
      }
      const us =
        row.formalized.countryCode === "US" || isUsShaped(row.original);
      if (!us) {
        continue;
      }
      const parsed = toCensusRow(row.formalized);
      if (!parsed) {
        continue;
      }
      censusRows.set(row.id, parsed);
      const group = censusIds.get(row.id);
      if (group) {
        group.push(row);
      } else {
        censusIds.set(row.id, [row]);
      }
    }
    const censusHits = new Set<string>();
    if (censusRows.size > 0) {
      try {
        const res = await censusGeocode(censusRows);
        for (const [id, coords] of res) {
          if (!coords) {
            continue;
          }
          censusHits.add(id);
          await prisma.entity.update({
            where: { id },
            data: { lat: coords.lat, lng: coords.lng, geoStatus: "placed" },
          });
          for (const row of censusIds.get(id) ?? []) {
            row.status = "success";
            row.lat = coords.lat;
            row.lng = coords.lng;
            row.triedText = oneLine(row.formalized as FormalizedAddress);
            console.log(green(`[coords] llm-${pass} census hit: ${row.original}`));
          }
          summary.census += 1;
          summary.placed += 1;
        }
      } catch (err) {
        console.warn(
          `[coords] llm-${pass} census batch failed, rows fall to Nominatim (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    // Everything still unplaced goes to Nominatim (structured when the
    // parse is rich enough, else the joined line — cache may hold it).
    const rest = todo.filter((r) => !censusHits.has(r.id) && r.formalized);
    for (const row of rows) {
      if (row.status === "success" || censusHits.has(row.id) || row.formalized) {
        continue;
      }
      // The LLM itself failed: nothing new to query, stays failed for
      // the next --pass (whose prompt carries the failureCause).
      row.status = "failed";
      summary.failed += 1;
    }
    if (process.env.GEOCODE_BACKEND === "modal") {
      const texts = rest.map((r) => oneLine(r.formalized as FormalizedAddress));
      const res = await geocodeRemote(texts);
      for (const row of rest) {
        const line = oneLine(row.formalized as FormalizedAddress);
        const coords = res.get(line) ?? null;
        row.triedText = line;
        if (coords) {
          await prisma.entity.update({
            where: { id: row.id },
            data: { lat: coords.lat, lng: coords.lng, geoStatus: "placed" },
          });
          row.status = "success";
          row.lat = coords.lat;
          row.lng = coords.lng;
          summary.nominatim += 1;
          summary.placed += 1;
          console.log(green(`[coords] llm-${pass} hit: ${row.original}`));
        } else {
          row.status = "failed";
          summary.failed += 1;
          console.log(red(`[coords] llm-${pass} miss: ${row.original}`));
        }
      }
    } else {
      for (const row of rest) {
        const addr = row.formalized as FormalizedAddress;
        const params = structuredParams(addr);
        const line = oneLine(addr) || row.original;
        row.triedText = line;
        const coords =
          Object.keys(params).length >= 2
            ? await geocodeLocal(line, row.name, params)
            : await geocodeLocal(line, row.name);
        if (coords) {
          await prisma.entity.update({
            where: { id: row.id },
            data: { lat: coords.lat, lng: coords.lng, geoStatus: "placed" },
          });
          row.status = "success";
          row.lat = coords.lat;
          row.lng = coords.lng;
          summary.nominatim += 1;
          summary.placed += 1;
          console.log(green(`[coords] llm-${pass} hit: ${row.original}`));
        } else {
          row.status = "failed";
          summary.failed += 1;
          console.log(red(`[coords] llm-${pass} miss: ${row.original}`));
        }
      }
    }
    writePassFile(pass, rows);
    return summary;
  } finally {
    await prisma.$disconnect();
  }
}
