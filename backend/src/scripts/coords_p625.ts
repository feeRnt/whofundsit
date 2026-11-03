// coords:p625 — Wikidata P625 pass for lei: rows. TWO MODES:
//   npm run coords:p625 -- --main   pending lei: queue (not failed)
//   npm run coords:p625 -- --dead   failed lei: queue (the LLM queue)
// Each resolves LEIs -> HQ coords via SPARQL (P159->P625, direct P625
// fallback), writes lat/lng + geoStatus "placed" per hit, and logs
// via=hq|direct per row (city-level, approximate — see wikidataCoords.ts).
//
// STATUS: SUPERSEDED by `npm run coords:global` (same job, shipped with
// the DB phase). This stub only prints its contract and exits so old
// runbooks fail loud instead of silently doing nothing.
const args = process.argv.slice(2);
const mode = args.includes("--dead") ? "dead" : args.includes("--main") ? "main" : null;
if (!mode) {
  console.error("usage: npm run coords:p625 -- --main | --dead");
  process.exit(2);
}
console.log(
  `[coords:p625] mode=${mode}: SUPERSEDED by coords:global — no DB or ` +
    `network writes. Run \`npm run coords:global\` instead.`,
);
