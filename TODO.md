# TODO

## ⏳ Not yet built (ordered by demo impact)

- [x] **Regional financial loaders, phase 1.** (`regional:esef` + `regional:twse`
      shipped with tests; native currencies. NOT yet run live — needs `db:push`
      for the currency column, then a trial + `db:export`.)
- [ ] **Regional financial loaders, phase 2** (EDINET/Japan + Open DART/Korea:
      needs free keys (ToS accepted at signup) AND a join key to LEI rows —
      EDINET secCode / DART corp_code don't map to LEI yet. Options: Wikidata
      ticker map per exchange (as TWSE does), or filer-name matching.)
- [x] **Multi-currency support** (`Entity.currency`, default USD; formatMoney
      display in popups/tooltips. Needs `db:push`; old seeds imply USD.)
- [x] **13F concurrency.** (8-worker pool via `mapLimit`; SEC ≤10/s, Nominatim 1/s
      and OpenFIGI limits all hold via chained limiters; shared CUSIP map flushed
      every 25 managers. Tune with `THIRTEENF_CONCURRENCY`.)
- [x] **CUSIP/ticker-based 13F matching.** (Holdings resolve CUSIP → ticker via
      OpenFIGI, then ticker → placed entity; normalized-name match stays as fallback.
      NOTE (2026-11-01 chain): 842+ placed rows; most remaining misses are
      ungeocoded targets or ETF holdings, fixed by coords reruns, not matching.)
- [ ] **Demo rehearsal on a fresh database** (`npm run demo` from zero → globe with
      listings, arcs, popups; packaging is code-reviewed only, never run end-to-end).
- [ ] **Geocode backfill, 2nd pass** (2026-11-01 chain placed 842+ rows; rerun
      13f/500 to convert city-fallback hits + stub the rest, then coords, then
      13f again to pick up placed stubs — resumable, cached).
- [ ] **Free API keys before scale-up runs** (OpenAlex for cursor-paging past 200 works;
      EDINET + Open DART keys for Japan/Korea loaders).

## Beneficial ownership (top individual owners)

- [ ] **Index top-3 biggest individual owners per company.** SEC Forms 3/4/5 (changes in beneficial
      ownership) are listed in each company's submissions JSON; parsing the top holders needs the
      ownership XML filings per insider. Feasible but a new ingest path — after fund scale-up.

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
- [ ] **Enrichment batch needs `db push` + re-run** (`bulk`, then `ingest`) to backfill the new `form`,
      `filed`, `exchanges`, `category`, `formerNames` columns and the Revenues/NetIncomeLoss rows.

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

## 13F holdings follow-up (fund → stock arcs)

- [x] **Vanguard CIK verified live** (`102909` = VANGUARD GROUP INC, 13F-HR filed 2026-01-29).
      Also verified: BLK → 2012383, BRK-A/BRK-B → 1067983; info-table XML shape; values are whole
      dollars (not thousands); table doc is the largest non-primary .xml.
- [x] **Full-filer discovery** (local bulk scan → all 13F-HR filers, curated 3 first, lazy geocoding).
- [ ] **Verify 13F arcs in the browser.** (Run `npm run flows:13f`, reload: dollar arcs from the funds;
      hover shows fund → company + $ amount. Check the match log for miss rate.)

## Last-last: dark mode

- [ ] **Full dark-mode theme.** (Explicitly deferred to the very end; the map UI is already dark-first.)

## Legal follow-ups

- [ ] **Ship OSM attribution with any standalone address cache.** (Cached Nominatim coordinates are fine to
      host, but keep "© OpenStreetMap contributors" credit wherever the cache or its results appear.)

## Later: international (IFRS) coverage

- [ ] **Add `ifrs-full` frames/bulk tags** (Samsung, Toyota, Nestlé… barely appear in us-gaap). Needs tag
      mapping + testing; demo story stays US-centric until the core loop is judge-ready.
