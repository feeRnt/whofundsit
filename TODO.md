# TODO

## ⚠️ CIRCULAR CHAIN DEPENDENCY: 13F <-> coords (read before ANY rerun)

- [ ] **Always run the chain as 13f → coords → 13f → export, in that order, never one
      side alone.** (Each half feeds the other: 13F matches holdings ONLY against
      PLACED entities, so fresh coords need a 13F rerun (cheap, filings cached) to
      convert unmatched holdings into flows; and 13F stubs new fund rows that need a
      coords rerun to place fund dots. Running just one side leaves the other half's
      gaps in place — THIS circle is why partial reruns looked broken in the past.
      After coords:populate, rerun flows:13f. After flows:13f, rerun coords:populate.
      Then export. No exceptions.)

## Post-demo: revisit quarterly SEC cache (demo shortcut, see 95c061b)

- [ ] **Mid-quarter late filings are invisible under the quarterly cache.**
      (Demo-only shortcut for lack of time (commit `95c061b`): SEC frames /
      submissions / companyfacts cache by calendar quarter, so filings landing
      mid-quarter never appear until next quarter or a `CACHE_REFRESH=1` run.
      Post-demo: either revert `95c061b`, or do the smarter split — daily expiry
      for the CURRENT quarter, permanent cache for CLOSED quarters (immutable).
      Until then, any suspiciously stale SEC number gets a `CACHE_REFRESH=1` rerun.)

## ⏳ Not yet built (ordered by demo impact)

- [ ] **User reminder: check whether % shares has the same coverage gaps as the primary metric.**
      (Primary metric is now Assets everywhere; verify per-company whether a
      `EntityCommonStockSharesOutstanding` row + live quote exist, so Real %
      shows. Seed has only ~500 share-count CIKs — NVDA/GOOGL/XOM missing,
      AAPL/MSFT/AMZN present. Dataset is NOT complete: Other (n) and
      Untracked % are shares of tracked 13F $ in our files, not of all
      shares ever issued, unless market cap mode is active.)
- [x] **⭐⭐⭐ VERY IMPORTANT — arcs slider must show the true max available arcs, like the dots slider.**
      (Done 2026-11-02: slider max + label denominator are now `eligibleFlows` — arcs passing
      every toggle/funder/focus filter, exactly like dots use `visibleEntities`. Label reads
      `Arcs shown/eligible`.)
- [x] **Rename `coords_populate` to `coords:populate`** (Done 2026-11-02 right after the
      run stopped, plus the `global:*` flips in the same pass: `sync:global`,
      `industry:global`, `coords:global`. Filenames keep underscores; run-log
      history in SESSION_NOTES/HANDOFF keeps old names.)
- [x] **Wire `coords:p625` DB phase (Spark, after the active coords run).** (Done 2026-11-02
      as `npm run coords:global`: 100-LEI VALUES batches through the shared SPARQL limiter,
      direct P625 beats HQ-hop per LEI, hits write lat/lng + `geoStatus: "placed"`, unplaced
      lei: rows only. Differently named than the HANDOFF spec, same job.)

- [ ] **Claim-verification loop with "x% verified" scores.** (Agentic background
      loop over our biggest claims — top entities' total assets/debt, top funding
      flows — rechecking each against an independent external source (13F
      aggregators, company IR filings, OpenAlex works) and scoring 0-100% by
      closeness (e.g. within 1% = 100, within 5% = 90, missing = 0). Scores
      surface as trust badges in popups/tooltips ("87% verified"). Needs: a
      `verification` store (entity/flow id → score + source + checked-at),
      per-claim-type checkers with cached fetches (respect every source ToS),
      and a scheduled/CI loop — NOT on the request path. Manual precedent:
      Vanguard→NVIDIA $422.74B vs $423B and BlackRock→NXP $6,716,412,097 vs
      $6,716,412,000 both verified by hand on 2026-11-01.)
- [x] **Regional financial loaders, phase 1.** (`regional:esef` + `regional:twse`
      shipped with tests; native currencies. Trialed 2026-11-01: ESEF sort/shape
      fixed to verified JSON:API, TWSE made self-sufficient via GLEIF creation;
      post-fix rerun in the current chain, then `db:export`.)
- [ ] **Regional financial loaders, phase 2** (EDINET/Japan BLOCKED 2026-11-01:
      b2clogin signup demands mobile 2FA and the user's country code is not
      selectable — skip Japan loader unless a workaround appears; Open DART/Korea:
      needs free keys (ToS accepted at signup) AND a join key to LEI rows —
      EDINET secCode / DART corp_code don't map to LEI yet. Options: Wikidata
      ticker map per exchange (as TWSE does), or filer-name matching.)
- [x] **Multi-currency support** (`Entity.currency`, default USD; formatMoney
      display in popups/tooltips, abbreviated $6.72B-style since 2026-11-01.
      Live in DB since the user's `db:push`; old seeds imply USD.)
- [x] **13F concurrency.** (Core-scaled worker pool via `mapLimit`, 2×cores
      clamped 4–16; SEC ≤10/s, Nominatim 1/s and OpenFIGI limits all hold via
      chained limiters; shared CUSIP map flushed every 25 managers. Tune with
      `THIRTEENF_CONCURRENCY`; `THIRTEENF_SKIP_STALE=1` drops dead filers.)
- [x] **CUSIP/ticker-based 13F matching.** (Holdings resolve CUSIP → ticker via
      OpenFIGI, then ticker → placed entity; normalized-name match stays as fallback.
      NOTE (2026-11-01 chain): 842+ placed rows; most remaining misses are
      ungeocoded targets or ETF holdings, fixed by coords reruns, not matching.)
- [ ] **Demo rehearsal in a real browser** (backend path verified 2026-11-01:
      fresh DB → 21,514 entities / 9,362 flows, APIs + frontend / → 200;
      still needs human eyes on the globe, arcs, popups).
- [ ] **Geocode backfill, 2nd pass** (IN PROGRESS 2026-11-01: `--all` pager now
      pages past all-miss batches to cover all ~20k; chain is 13f → coords →
      13f → export — resumable, cached).
- [ ] **Free API keys before scale-up runs** (OpenAlex key set 2026-11-02, cursor-paging
      unblocked; EDINET BLOCKED on mobile 2FA; Open DART keys still needed for Korea loader).
- [ ] **Euro/Asia rows missing from served data** (observed 2026-11-01: the map
      shows EDGAR + 13F only, no `global`/`twse`/ESEF rows. Suspects: ungeocoded
      (lat/lng 0 filtered?), `/api/entities` order/limit burying them, or the
      export predating `sync:global`. Check DB source counts, then the endpoint's
      filter/order, then re-export.)
- [x] **Price sparkline in the company popup** (Done as daily change % via a Yahoo
      Finance chart call instead of a Stooq graph: popup shows "Today: +X.XX%"
      green / red via live quote — answers "up or down?" as specified.)
- [ ] **names:sync scope decision (DEFERRED per user 2026-11-02 — remind later).**
      Candidates: collisions + inconsistent CIKs (recommended) vs cross-entity
      matches only vs keep current all-mismatch scope. User will search Exxon
      in the UI first (they recall names appearing identical there — possibly
      live DB already unified post-export, or display-layer dedupe). Verbatim
      source settled: local offline archive (yauzl lazy streaming, no
      extraction — see bulkLoad `jsonEntries`).
- [x] **Ask Muse Wonder to sweep the repo for improvements (user reminder).**
      (Fired 2026-11-02: Wonder active on this worktree, frontend changes landing.)
- [x] **Tell Muse Wonder about Claude's sleek dark globes (user reminder).**
      (Fired 2026-11-02 with the sweep request above.)
- [ ] **Unify outbound API helpers (post-demo refactor).** (Per-API modules
      already share `apiLog`, `createRateLimiter`, `green`/`red`, and the
      cache helpers; eventually fold request, retry, and audit-trail
      handling into one global helper to reduce clutter. Census
      `censusBatch.ts` is the conformance reference.)
- [ ] **Build the LLM address-repair pass (dead-lines consumer).**
      (Everything feeds it: `geo/dead-lines.json` (742+), `geoStatus:
      failed` rows, 26 stateless-US, funder-coords `llm` rows. Approach
      adopted in DATASETS: deformed address → Modal open-weight LLM →
      structured fields → Census batch (US) / Nominatim (foreign) →
      exact coords. Reads full original addresses — verified the queue
      stores pre-retry originals, never stripped fallbacks.)
- [x] **Exclude transient queries from the dead-lines flush (post-run).**
      (Done 2026-11-02: errors-after-retry are DB-failed but never dead-lined;
      distinct `retry-error` log line. The skip-is-failed change removed the
      pending limbo that made this nasty.)

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
- [x] **Run live ingestion once `DATABASE_URL` is configured.** (Done many times over:
      bulk base 11,771 rows + frames top-ups; BlackRock→Exxon $45.77B verified against the 23-sleeve filing.)

## Frontend globe follow-ups (`frontend/src/components/MapGlobe.tsx`)

- [ ] **Check coincident-dot stacks in the browser.** (Count badges shipped: every
      stack shows one dot + N, click expands a clickable ring, empty click
      collapses. Verify: (1) San Francisco 37.78794,-122.40752 — Salesforce +
      DocuSign share a dot; (2) NYC 40.71273,-74.00602 — Medallion Financial +
      TG Therapeutics (+210 more). Search the name, look for the badge, click
      to expand, click individuals. Seeds snapshot — live DB coords may differ
      slightly; if the badge moved, search the name and look around.)

- [x] **Verify the globe renders clean in the browser.** (Verified by daily use:
      globe/2D toggle, nodes + arcs retained across switches, fresh `Map` per projection. If distortion
      returns, `MapGlobe.tsx` is the first place to look. Note: the worker import must stay in `?url` form —
      `?worker&url` reintroduced the MIME error in the browser.)

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
- [x] **Enrichment batch needs `db push` + re-run.** (Done: user pushed + re-ran `bulk` and
      `ingest:all`; `form`/`filed`/`exchanges`/`category`/`formerNames` live in seeds and round-trip.)

## Grant arcs follow-up (OpenAlex → CapitalFlow)

- [x] **Verify grant arcs in the browser.** (Live: greenish arcs behind the "University Funds"
      dropdown; hover shows funder → university + funded-works count.)

## Hill's / OpenAlex caveats (found live, 2026-10-29)

- [ ] **Frame the story as Colgate-Palmolive (parent of Hill's Pet Nutrition) → vet schools.** ("Hill's" has
      no standalone OpenAlex funder ID; funder search returns keyword matches plus a generic "Hills" entry
      with 1 work. All reliable Hill's grant data sits under the parent `F4320307808`.)
- [x] **Label arc amounts as funded-works counts, never dollars.** (In-app wording shipped
      in tooltips/popups; OpenAlex exposes no reliable grant amounts. Demo-slide wording still yours.)
- [x] **Get a free OpenAlex API key before the demo.** (Done 2026-11-02: `OPENALEX_API_KEY` set in
      `backend/.env` (verified present, value not printed); keyless shared-pool limit no longer applies.
      Cursor-paging past 200 works is now unblocked — see scale-up item below.)

## OpenAlex scale-up (after the demo works)

- [ ] **Cursor-page all funder works** (currently first 200/page; Colgate has 1417) once an API key exists.
- [x] **Consider merging institution duplicates.** (Tooling shipped: read-only `dedupe:report`
      finds candidates, `merge -- keep drop` folds with `mergedFrom` provenance; individual merges are user ops.)

## 13F holdings follow-up (fund → stock arcs)

- [x] **Vanguard CIK verified live** (`102909` = VANGUARD GROUP INC, 13F-HR filed 2026-01-29).
      Also verified: BLK → 2012383, BRK-A/BRK-B → 1067983; info-table XML shape; values are whole
      dollars (not thousands); table doc is the largest non-primary .xml.
- [x] **Full-filer discovery** (local bulk scan → all 13F-HR filers, curated 3 first, lazy geocoding).
- [x] **Verify 13F arcs in the browser.** (Live: reddish arcs with abbreviated $ amounts +
      filing-line counts in hover; 7,009 flows from the 500-manager run. Top values spot-verified:
      Vanguard→NVIDIA $422.74B, BlackRock→NXP $6.72B.)

## Last-last: dark mode

- [x] **Full dark-mode theme.** (Done per user 2026-11-02.)

## Legal follow-ups

- [x] **Ship OSM attribution with any standalone address cache.** (LICENSE.txt in the geo cache dir
      + automatic MapLibre attribution on the map. Full dataset terms in DATASETS.md.)

## Later: international (IFRS) coverage

- [x] **Add `ifrs-full` frames/bulk tags** (SUPERSEDED: international coverage goes through
      Wikidata+GLEIF backbone + regional loaders — ESEF/TWSE phase 1 shipped — instead of us-gaap-style frames.)
- [ ] **GLEIF bulk files instead of per-record API (post-demo).** (`sync:global`
      resolves every LEI + children pages over `api.gleif.org`, ~10/s polite
      sleeps, all cached. GLEIF also publishes daily concatenated full-file
      dumps of every LEI record: one big download + local join would replace
      thousands of API calls and retire the ECONNRESET-retry class. Needs:
      re-verify dump URL + terms at implementation time, streaming parse, and
      keeping the per-record path for delta/children gaps.)

## Prompts file update

- [ ] **Update prompts.md with the missing prompts.** (Include Muse Wonder's
      prompts, then the prompts deleted by the accidental `/clear` before
      export — recover both from session logs.)
