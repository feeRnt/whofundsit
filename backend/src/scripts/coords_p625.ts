// coords:p625 — Wikidata P625 pass for lei: rows. TWO MODES:
//   npm run coords:p625 -- --main   pending lei: queue (not failed)
//   npm run coords:p625 -- --dead   failed lei: queue (the LLM queue)
// Each resolves LEIs -> HQ coords via SPARQL (P159->P625, direct P625
// fallback), writes lat/lng + geoStatus "placed" per hit, and logs
// via=hq|direct per row (city-level, approximate — see wikidataCoords.ts).
//
// STATUS 2026-11-02: DRY-RUN ONLY. A Nominatim coords_populate run owns
// the DB; this script must not write concurrently. It validates the
// mode and prints the contract, then exits. Spark: wire the DB phase
// per HANDOFF_CLEAR.md (read targets with selectP625Leis, VALUES-batch
// LEIs through sparqlLimit, update hits, count misses back to their
// queue) once the active run finishes.
const args = process.argv.slice(2);
const mode = args.includes("--dead") ? "dead" : args.includes("--main") ? "main" : null;
if (!mode) {
  console.error("usage: npm run coords:p625 -- --main | --dead");
  process.exit(2);
}
console.log(
  `[coords:p625] mode=${mode} dry-run: no DB or network writes ` +
    `(wire-up pending — see HANDOFF_CLEAR.md P625 section).`,
);
