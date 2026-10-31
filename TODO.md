# TODO

## ✅ DONE — proper address field on `Entity`

- [x] **Added `businessAddress`, populated by `npm run ingest` from SEC submissions, geocoded by `npm run pipeline`.**

## ⚠️ BIG TODO — SEC ingestion follow-ups (`backend/src/services/secIngestion.ts`)

- [x] **Real SIC industry in `Entity.type`.** (Done: `sicDescription` from the submissions payload, e.g.
      "Aircraft & Parts"; falls back to `"Company"` only when absent. Backfills existing rows on next ingest.)
- [x] **Business address + real coordinates.** (Done: ingest fetches submissions addresses into `businessAddress`;
      `npm run pipeline` geocodes them via Nominatim. `rawAddressText` keeps `loc`.)
- [ ] **Run live ingestion once `DATABASE_URL` is configured** (`backend/.env`), then verify row counts
      (`fetched` capped at 500, `upserted` + `skipped` = `fetched`) and spot-check a filing by `secFilingNumber` on EDGAR.

## Frontend globe follow-ups (`frontend/src/components/MapGlobe.tsx`)

- [ ] **Verify the globe renders clean in the browser.**
      Globe projection now ships via `MapLibreOverlay` from `@deck.gl/maplibre` (the docs-blessed MapLibre v6
      path) in `frontend/src/components/MapGlobe.tsx` with the OpenFreeMap Liberty style. If distortion returns,
      that file is the first place to look. Note: the worker import must stay in `?url` form —
      `?worker&url` reintroduced the MIME error in the browser.

## ✅ DONE — index membership (S&P 500 / Nasdaq-100)

- [x] **Index members always covered.** (Ticker snapshots in `backend/src/data`, CIK-mapped live each run via
      `company_tickers.json`; frame rows sorted members-first within the 500 cap. Tickers stored per entity.
      Refresh snapshots with `backend/scripts/fetch_constituents.py`.)

## ✅ DONE — bulk ZIPs fetched + verified (2026-10-31)

- [x] **Both nightly ZIPs in `backend/data/`** (gitignored): byte-exact vs SEC Content-Length
      (submissions 1,572,128,284 B; companyfacts 1,414,913,699 B) and CRC-clean per `unzip -t`.
- [x] **Base loaded** (991,164 address entries scanned; 11,771 rows upserted, 11,763 with addresses).
- [x] **Loader optimized after the slow first run** (sequential streaming parse, address map cached to
      disk, 8-way concurrent upserts).

## Grant arcs follow-up (OpenAlex → CapitalFlow)

- [ ] **Verify grant arcs in the browser.** (Run `npm run flows:openalex`, reload the globe: arcs should fan
      from the funder to grantee institutions; hover shows funder → university + works count.)

## Hill's / OpenAlex caveats (found live, 2026-10-29)

- [ ] **Frame the story as Colgate-Palmolive (parent of Hill's Pet Nutrition) → vet schools.** ("Hill's" has
      no standalone OpenAlex funder ID; funder search returns keyword matches plus a generic "Hills" entry
      with 1 work. All reliable Hill's grant data sits under the parent `F4320307808`.)
- [ ] **Label arc amounts as funded-works counts, never dollars.** (OpenAlex exposes no reliable grant
      amounts; keep the "funded works" tooltip wording and say so on the demo slide.)
- [ ] **Get a free OpenAlex API key before the demo.** (Keyless shares a $0.10/day IP pool — observed 0
      requests remaining during probing; cursor-paging past 200 works needs a key anyway.)

## OpenAlex scale-up (after the demo works)

- [ ] **Cursor-page all funder works** (currently first 200/page; Colgate has 1417) once an API key exists.
- [ ] **Consider merging institution duplicates** (e.g. "College of Veterinary Medicine" vs parent university
      appear as separate arc targets).
