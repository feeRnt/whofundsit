# Session notes (2026-10-31 night — agent signed off, user asleep)

Running log for picking work back up. Update when the picture changes.

## 2026-11-02 — post-/clear: skip-and-continue hardening applied (user tests)

All 4 HANDOFF_CLEAR job-1 fixes landed, smallest edits, `tsc --noEmit` clean.
Unit suite NOT run here: tsx workers need a listenable IPC pipe and the
sandbox denies it (`EPERM ... /tmp/tsx-*.pipe`) — user runs `npm test`
locally (expect 68/68; no test file was touched).

1. `backend/src/services/openalexFlows.ts` — funder-geo fetch wrapped in
   try/catch: geocode miss/transient error logs `[flows] skipping funder …`
   and returns a zero summary, so the funder loop continues. Nothing cached
   on the skip path, so reruns retry the geocode and a later FUNDER_LAT/LNG
   pin still takes effect. `funderCoords` itself untouched.
   `.env.example` needed NO change: FUNDER_LAT/LNG already documented there.
2. `backend/src/services/pipeline.ts` — `geocodeLocal` catch handles HTTP 400
   first: warn + dead-lines entry + memory-null, returns null (never aborts).
   `shouldSwallowGeoError` untouched (its 4xx-rethrow contract is tested).
3. `backend/src/services/httpCache.ts` + `thirteenF.ts` — `readCache` retries
   EIO once, then warns and returns a miss (caller re-fetches/rebuilds);
   non-EIO errors still throw. `runThirteenF` also guards `readAddressMap()`:
   unreadable map warns and continues with name-only geocoding + stubs.
4. `backend/src/services/globalSync.ts` — new `gleifGet` (3 tries, 1s/2s
   backoff) retries ONLY ECONNRESET/socket-hang-up; anything else throws
   immediately. `runGlobalSync` skips a failed LEI record (`continue`) and
   keeps parent-only when a children fetch fails. GLEIF doc shapes factored
   into `GleifRecordDoc`/`GleifChildrenDoc` (no behavior change).

API-limits posture (user-flagged): all ToS pacing unchanged — Nominatim 1/s
limiter, SEC ≤10/s, GLEIF ~10/s polite sleeps all intact. GLEIF retries add
at most 2 extra requests per failed fetch with backoff (bounded, no storm);
the other three fixes only REMOVE calls (skip/degrade paths). ECONNRESET is
a TCP-level reset (peer/middlebox hung up, "socket hang up") — transient
network weather, NOT a 429/403 limit signal; likelier on the user's cellular
link. No usage-pattern change needed.

Rerun recipe after the night's 4 interruptions (in `whofundsit/backend`):
`dmesg | tail` first (EIO = only hardware signal); then the full chain in
order — `ingest`, `GLOBAL_LIMIT=5000 global:sync`, `GLOBAL_LIMIT=5000
tickers:global`, `flows:openalex`, `coords_populate -- --all`, 13f/500,
`verify:claims`, `db:export`. Every step resumes from cache/DB (upserts
idempotent; 13f crashed pre-queue so nothing partial). Skipped OpenAlex
funder auto-retries next run.

Open follow-ups: per-funder guard ALSO landed in `src/scripts/openalex_flows.ts`
(any per-funder throw now skips + continues, `skipped` ids in the final log) —
done under the relaxed 2026-11-02 ground rule (smallest-edits waivable).
Contradiction to resolve: `DEMO_VIDEO_PLAN.md` header says DO NOT COMMIT but
HANDOFF_CLEAR job 2 says commit it — user's call.

## 2026-11-02 — global:sync + OpenAlex diagnosis (from disk cache, offline)

OpenAlex crashed on funder 4/12 = Japan Society for the Promotion of Science
(record cached, geo absent; both Nominatim queries returned []). Stage:
funder-geo, BEFORE works pull and before any DB write for that funder —
nothing partial. EC/NSFC/NIH fully done (76 works pages + 290 insts cached);
Colgate files are from earlier default runs. Rerun replays 1–3 from cache,
skips JSPS from cached [] with zero API calls, continues 5–12. Pin later via
FUNDER_LAT/LNG (no CACHE_REFRESH needed — pin bypasses the geo cache).

global:sync fatal = GLEIF ECONNRESET (fixed). The eu/asia Wikidata failures
are separate + non-fatal (pre-existing skip-region path). Cache proves them
transient: europe/asia 180-quota queries from the 500-run both succeeded
full (180/180); the 5k-run 1800-versions left no files. LIMIT applies after
GROUP BY, so the big queries cost ≈ the same as the proven small ones —
failure = endpoint load/timeout or network, not query shape. Short counts
(na 264/500, sa 99/400, africa 43/300, oceania 89/200) are genuine Wikidata
sparsity, not failures. 499 GLEIF records + 510 children pages banked; rerun
retries exactly the missing pieces (failures are never cached). Still want
the two `[global] region … failed, skipping (…)` lines: 429 → add
inter-region pacing; timeout/503 → just rerun off-peak.

## 2026-11-02 — log verdict: europe 504 + asia 429, both fixed in code

User pasted the 5k-run log: europe → HTTP 504 (Wikidata 60s cap killing the
1800-row query), asia → HTTP 429 (throttled right after), na/sa/africa/oceania
passed short-but-real (120/37/22/53 companies), then the tail
`triggerUncaughtException` = the known GLEIF ECONNRESET fatal. Correction to
my earlier note: LIMIT DOES scale cost (label service resolves every result
row), so europe-1800 would 504 again on rerun — paging was required, not
optional. Fix in `globalSync.ts` (`tsc` clean): quotas ≤500 keep byte-identical
single queries (all existing caches still hit — the 5k na/sa/africa/oceania
files replay, zero refetch); quotas above 500 go as ≤500 LIMIT/OFFSET pages
with a `?lei` tiebreaker (8 fresh eu/asia pages on next rerun, each cached
separately); 429/5xx retry 3× with 15s/30s backoff inside `sparqlRegion`; 5s
pause between regions, 10s between pages; cross-page/transcontinental dupes
now merge exchanges instead of dropping. Q3 verdict: NO database switch —
sparsity was misdiagnosed, the failure was query cost; post-demo option is
GLEIF bulk LEI files instead of per-record API. Q1 also closed: skipped
funders now land in `data/cache/openalex/skipped-funders.json` (id/reason/at,
first reason wins) via `recordSkippedFunder`, called from both the service
skip path and the script catch; `FlowSummary.skipped` flags it for the final
log. Next rerun's only fresh Wikidata cost is the 8 eu/asia pages.

## 2026-11-02 — ToS review + shared limiters on every uncapped path

Primary-source verdicts (user-steered): GLEIF's official API page documents
NO rate limit (third-party "60/min" claims unconfirmed; zero 429s observed at
~10/s over hundreds of calls) — page does link Golden Copy/concatenated bulk
files, supporting the TODO. Wikimedia UA policy requires descriptive UA +
contact only, no req/s number. OpenFIGI docs DO publish limits (mapping: 25
req/min x 10 jobs keyless, 250 x 100 keyed, per IP/key, 60s windows) — our
2500/300ms + 10/100 posture matches exactly, no change. GLEIF never failed on
a rate limit: only failure on record is ECONNRESET (TCP, no HTTP status).
Rolled out (red→green, `tsc` clean, 29/29 on touched suites): `sparqlLimit`
5s + `gleifLimit` 100ms shared gates in `globalSync.ts` (sleeps/caching kept;
`gleifGet` also gained defensive 429/5xx retry honoring Retry-After),
`quoteLimit` 1s in `stockQuote.ts` (request-path click-spam guard).
Maintained tests: `createRateLimiter` contract (serialize/space/recover) +
interval pins + gate timing in the three suites. Untouched, verified paced:
SEC, OpenFIGI, OpenAlex, Nominatim, Modal, ESEF (1s+backoff+Retry-After),
TWSE (500ms), funderCoords (1100ms). Full `npm test` still EPERM-blocked in
sandbox (tsx IPC); user runs it locally.

## 2026-11-02 — CORRECTION: GLEIF publishes 60 req/min (was: "no cap")

User pasted GLEIF's official API docs (Postman): "Rate limiting is currently
set at 60 requests, per minute, per user, for all users." My "unconfirmed
folklore" verdict was wrong — the third-party 60/min claims were right, and
our 100ms pacing ran 10x over the published cap (never throttled in practice,
but out of compliance regardless). Fixed same turn (red→green, `tsc` clean,
29/29): `GLEIF_MIN_INTERVAL_MS` 100→1100 (~55/min with margin), stale
`sleep(100)` removed (gate owns pacing), `DATASETS.md` terms corrected.
Verified all GLEIF traffic flows through the one gate (`gleifEntity` incl. the
`regionalTwse` import, `gleifChildren`). Cost: fresh-data GLEIF phases run
~10x slower (≈2h worst case for a fully-fresh eu/asia fill at 5k scale);
cached reruns replay instantly. This strengthens the GLEIF-bulk-files TODO.
Also noted from the same doc: `filter[entity.legalName]` + `fuzzycompletions`
exist if name→LEI resolution is ever needed (Wikidata covers us today).

## 2026-11-02 — WDQS query-limits page: no req/s cap, timeouts are the limit

User pasted `Wikidata:SPARQL_query_service/query_limits`. Findings: no
per-second throttle is documented anywhere — enforcement is the 60s query
timeout ("Query timeout limit reached") plus result-size cliffs (10^4 rows
~7s, 10^5 ~23-42s in 2017 numbers; page notes 2026 is much worse: 9s runs
now time out). Our posture already matches: `/sparql` alias + `format=json`
exactly as documented, serial + 5s gate + cached + bounded, 500-row pages,
retry-then-skip. No code change. If europe-500 pages still 504 on rerun,
rewrite ladder (in order): drop OPTIONAL `?hq` (display fallback only) →
narrow continent→country chunks → split label resolution out of SPARQL
(raw QIDs + bulk label lookup) → Blazegraph hand-ordering hints last.

## 2026-11-02 — LIVE: europe pages landing via retry (502 flapping observed)

Rerun watch: europe p1 504→retry→ok (~52s), p2 clean (~59s), p3 attempt 1 fast
502 (~29s, edge flapping) → retry running. 500-row pages still live at the
timeout edge — cost is GROUP/COUNT/ORDER + labels, not LIMIT. Banked pages
stay cached (per-page hashes). Standing plan: change nothing mid-run; if a
page exhausts 3 retries, first extend 5xx backoff to 60s steps (no cache
invalidation), then drop OPTIONAL hq (first rewrite rung). Country-chunking
and label-split stay post-demo options.

## 2026-11-02 — industry sources: Wikidata P452 yes, GLEIF/OpenFIGI no

GLEIF: no industry field (all 499 cached records scanned; `category` is
GENERAL/FUND = legal-entity kind; "industr" hits are name/address
substrings). OpenFIGI: no industry in mapping schema (sector fields are
asset-class only). Wikidata P452: proven live on 5 cached LEIs (4/5 hit,
incl. multi-value PVH; easyJet missing) via a cheap VALUES query — the
viable path. Proposed `industry:global` backfill (batched LEI→P452, cached,
gated, first-label-wins) awaits user go; frontend + seed round-trip already
support `industry`. Forgotten-runs audit: industry:sync never ran (run after
db:push, before export); names:sync status unknown (cheap, offline — rerun
safe); deadlines:snapshot never ran (no seed file); Colgate merge DONE
(verified in seeds); regionals thin-Q3 (rerun later); keys still pending.

## 2026-11-02 — built `global:industry` (Wikidata P452 backfill)

`npm run global:industry` fills `Entity.industry` on `lei:` rows lacking it:
batched VALUES queries (100 LEIs, ORDER-stabilized, first-label-wins),
cached per batch under `global/`, gated by `sparqlLimit`, 429/5xx retried.
DB-first: reads global:sync's output rows (discovery + children + TWSE),
never re-runs discovery (region caches carry no P452 — verified); creates
nothing, updates in place. Ceiling: `INDUSTRY_GLOBAL_LIMIT` (0 = all).
Discovery paths untouched (dedicated fetcher). Chain slot: immediately after
`global:sync`. Red→green, `tsc` clean; `runGlobalIndustry` itself needs a
live DB (untested here — user runs it).

## 2026-11-02 — Exxon: two CIKs + one inconsistent row (needs human call)

Seed audit: CIK 2115436 has 5 rows under TWO names ('Exxon Mobil
Corporation' x4 + 'ExxonMobil Holdings Corp' x1, the latter still
geo-pending); CIK 34088 (XOM parent) has 4 rows as 'EXXON MOBIL CORP'.
names:sync will unify each CIK to its archive string (uppercase canonical)
but will NOT merge the two CIKs — that needs dedupe:report review +
merge:entities. Open question: subsidiary (keep both) vs CIK succession
(merge 2115436→34088?). Also corrected: archive names are UPPERCASE, so
names:sync unifies consistency, not title case.

Resolution (user): keep both — 2115436 is the Holdings subsidiary, not a
duplicate. No merge action; no code change.

## 2026-11-02 — OpenFIGI: ToS silent, docs throttle; liberal = at the ceiling

User: keyed OpenFIGI has no limits, be liberal + note it. Verified: legal ToS
(all 7 sections, 2018) says NOTHING about throttling — pure public-domain
dedication — so the "no limits in terms" reading is true of that document.
But the API docs publish a technically-enforced throttle (mapping: 25
req/min x 10 jobs keyless, 250 x 100 keyed, per IP/key, 60s windows, 429s +
ratelimit-* headers). Liberal-within-limits = run AT the ceiling (~96%),
never past: keyed 300→250ms (boundary-safe: max 241 starts/60s window vs 250
cap), keyless stays 2500ms (already 96%), batches already maxed (10/100).
Also closed a real gap found en route: neither OpenFIGI call site retried
429s, and a 429 in `resolveCusipTickers` killed the whole 13F run — 13F now
routes through shared `postMapping`, which retries 429/5xx honoring
retry-after/ratelimit-reset. Note written above `openfigiLimit` as asked.
Watch-out recorded there too: keyless cap is per-IP, so carrier-NAT
neighbors share our 25/min — prefer a free key. Red→green, `tsc` clean,
20/20 on openfigi+thirteenF suites.

## 2026-11-02 — User-Agent audit: env vars ARE wired (with fallback)

Every outbound call sends `process.env.*_USER_AGENT ?? "WhoFundsIt/0.1
(contact: dev@example.com)"`: SEC_USER_AGENT (ingest/13f/bulk/verify),
NOMINATIM_USER_AGENT (coords/funderCoords/verify + forwarded to Modal
worker), WIKIDATA_USER_AGENT (SPARQL + GLEIF + ESEF + TWSE — one var,
four hosts), OPENALEX_USER_AGENT→OPENALEX_CONTACT→default, QUOTE_USER_AGENT.
OpenFIGI correctly sends no UA (X-OPENFIGI-APIKEY instead). Two gaps, both
open: (1) nothing validates — unset vars or the "Your Name you@example.com"
example placeholder go out silently, and SEC/Nominatim 403/block those;
offered a warn-once guard, awaiting user go-ahead. (2) WIKIDATA var reused
for GLEIF/ESEF/TWSE — functionally fine, just mislabeled.

## 2026-11-02 — warn-guard shipped; user cleared to run the chain

`userAgentFromEnv(name, fallback?)` in `httpCache.ts`: returns the configured
value, else warns once (`[config] … not set / still the example placeholder`)
and returns the fallback. Detects unset, empty, and `example.com`. All 11 UA
sites in 10 services route through it (incl. OpenAlex `||` chain and the
funderCoords inline site). New `httpCache.test.ts` (3 tests) registered in
`npm test`. Red→green, `tsc` clean, 81/81 on all affected compiled suites
(fixtures copied to dist for bulkLoad). Note: unit output now shows
`[config]` warns (test env has no .env) — harmless noise, tests green.
User runs the full chain next (preflight: `dmesg|tail`, watch for `[config]`
lines at startup, `tail` logs only).

## 2026-11-02 — CORRECTION: TWSE serves Q3 filings-in-progress, not a new quarter

Cache proof: all 46 `t187ap07_L_ci` rows carry ROC 115 /季別 3 (Q3 2026);
other 5 industry endpoints returned 1 empty row each. Q3 ended Sept 30 —
"quarter just started" (old note + code comment) was wrong in every reading.
True story: Q3 reports file through ~45 days after quarter-end (≈ mid-Nov),
so Nov 1-2 shows early filers only. Rerunning later in Nov fills it in. Code
comment corrected; old note left as history.

## Where things stand

- App healthy: globe/2D toggle, dark popups, accordion menus, focus mode,
  ownership layer, green grant arcs all shipped. Frontend builds green,
  lint 0 errors (5 pre-existing dev-only warnings; the 1 new one silenced
  with an explained eslint-disable).
- Backend 44/44 tests green. Tree clean through regional phase 1 +
  docs; all commits as Muse Code.
- Standing rules: my commits as `Muse Code <muse-code@users.local>` via
  `git -c user.name=... -c user.email=... commit`; NEVER push without
  the user saying so (they asked "should i push", never confirmed).

## User's runs (their machine, their DB — I never touch it)

- Overnight chain FINISHED ~00:55 GMT: coords +519 (842 placed rows),
  13f/500 → 7,009 flows (tickers 257→609), global 305 cos → 2,554
  entities/2,249 flows, export 21,514 entities / 9,362 flows. Seed commit
  unconfirmed (user log cut off before git output).
- 13F leak found in the log: mass "unplaceable" (Nominatim fails on PO-box
  street lines; misses are sticky on disk by design). Fixed in code:
  shared `fallbackQueries` (city/state/zip retry) in coords + 13F paths,
  unplaceable funds now stubbed (0,0 + bulk address, API-invisible),
  13F trusts DB-placed funds before re-geocoding → reruns self-heal.
  User rerun recipe: 13f/500 (fresh fallback attempts + stubs), then
  `coords_populate`, then 13f/500 again (DB-first pickup of placed stubs).
  (Chain predates stubs, so the first rerun does the stubbing.)
- `names:sync` result unknown (was running at last report).
- Regionals TRIALED 2026-11-01, both failed, both diagnosed live + fixed:
  ESEF 0/500 — our `sort=-date` 400s (no such attr; `-period_end` verified
  200), attrs shape wrong (fields under `attributes`, relative json_url),
  now fixed + 404s count as "no ESEF filing"; xbrl-JSON facts shape
  verified correct against a live doc. TWSE 46 rows unmatched — the Q3
  endpoint genuinely serves 46 rows on Nov 1 (quarter just started; rerun
  later), and global:sync's random-500 has ~zero TW coverage, so TWSE now
  creates missing ticker-joined lei: rows via GLEIF itself (+`created`
  stat). global:sync query is unfiltered LIMIT 500 (why AXA-fund noise).
- Seed export/import round-trip verified field-complete (currency,
  mergedFrom, sleeves).
- `npm run demo` backend path REHEARSED LOCALLY 2026-11-01 (throwaway PG in
  sandbox, zero network): db:push + db:seed → 21,514 entities / 9,362 flows,
  /health ok, /api/entities → 856 placed (Vanguard/USD sample), /api/flows
  → 1000 (cap), frontend / → 200. Wipe guard verified both paths live.
  Still needs HUMAN eyes: actual globe render in a browser.
- $422B flow VERIFIED (2026-11-01, two aggregators): Vanguard → NVIDIA $423B
  per Q4-2025 13F (filed 2026-01-29); DB holds $422.74B. Legit.
- Day chain (2026-11-01): ESEF 9 updated + mass HTTP 429 (retry+1s pacing
  added; rerun retries uncached failures); TWSE 46/46 unmatched (thin Q3,
  expected); 13f/500 → 17,784 flows (fallbacks converted old unplaceables);
  coords pager placing 380-460/run. FRANKLIN TEMPLETON + L&G still stubbed:
  junk street2 ("LEGAL-FT SECRETARY") + X0 code — fallbacks now try the
  trailing pair and strip letter-digit codes (57k addresses affected).
- Search re-pick fixed (focusTick refires flight). Global coverage reworked:
  per-region quotas (EU/ASIA 36% each etc.), USA excluded (SEC covers it),
  sitelink-ordered. Location labels fixed: locationTag (no more US-X0 /
  "—" with address) + displayLocation frontend fallback. 13f reruns
  backfill fund labels; bulk rows need a re-bulk for new tags.
- Coords junk pre-filter (bare registrant names skip Nominatim, save ~3.3s
  each); dead lines logged to data/cache/geo/dead-lines.json for the future
  LLM miss-repair pass. verify:claims = stochastic METHODOLOGY audit
  (user's design): 25 seeded samples per source/region/index/flow cell vs
  live SEC + Nominatim reverse, 0-100 scores, % verified per cell, report
  in data/verification-report.json. Suite at 68/68.
- NXP "6.7T" scare = MISREAD, data was right: 8 online sources confirm
  BlackRock → NXP $6,716,412,000, DB holds 6,716,412,097. Fixed the real
  UX bug instead: formatMoney now abbreviates ($6.72B), flow tooltip uses
  it, "sleeves" renamed to "filing lines" user-side.
- Seed audit: 856/21,514 placed; ONLY bug-class finding was coords --all
  quitting behind the first all-miss batch (~16k never attempted). Fixed:
  --all now pages past sticky batches (skip + stable order). Ownership
  $0 amounts render as "stake undisclosed" already — no change needed.
- User's checkout vs agent worktree may differ (they once saw fce0a2a
  files as uncommitted) — reconcile before any push.

## Key facts learned

- Only **294/18,925** entities have coordinates — this dominates 13F match
  misses, not name quality. Fix = `coords_populate --all` (~5h, resumable).
- BlackRock→Exxon $45.77B = exact sum of all 23 filing sleeves (verified);
  aggregators list sleeves separately. Tooltips now show sleeve counts.
- Exxon "dupes" are Holdings (2115436, XOM) vs legacy EXXON MOBIL CORP
  (34088) — kept separate; `names:sync` unflattens the display names.
- Colgate merge direction: keep `openalex:F4320307808`, drop `...:I4210135004`.
- OpenFIGI ToS: FIGI public-domain; CUSIP inputs are CGS-licensed → use as
  ephemeral keys only, map stays in gitignored cache.
- TWSE OpenAPI: gov open-data license, attribute + intact, /v1/opendata/* only.
- filings.xbrl.org: no stated license; analysts are intended users; be polite.
- EDINET/DART need free keys; ToS accepted at signup (JP/KR, unverified).

## Next steps (ordered)

1. User morning: check overnight chain completed (expect coords ~5h the
   long pole; 13f/500 + global + export after). Verify seed commit landed.
2. User: trial regionals (`regional:esef`, `regional:twse`), then `db:export`.
3. User: fresh-DB `npm run demo` rehearsal (non-negotiable before new features).
4. User: reconcile checkout vs agent worktree, then decide on push (say so!).
5. Later: phase-2 regionals (EDINET + DART need keys + LEI join), CUSIP gains
   check, OpenFIGI key, dark mode last, beneficial ownership, OpenAlex paging.
6. TODO: UK Companies House regional (free key, iXBRL accounts) — spec the
   LEI/company-number join when EU yield is re-measured after quota sync.

## Shipped overnight (all as Muse Code, builds green, 44/44 tests)

- Multi-currency: `Entity.currency` + formatMoney display (needs db:push).
- `regional:esef` + `regional:twse` with tests, docs, ToS entries.
- 13F: CUSIP matching, worker pool, core-scaled workers, stale-filer skip.
- Focus mode (single-company arcs), green grant arcs, ownership layer.
- Demo packaging, DATASETS.md, script reference, geo LICENSE.txt.

## 2026-11-02 (afternoon, live chain running)

- Chain healthy: `global:sync` 1882 companies (1175 EU / 502 Asia),
  14570 entities / 12688 flows; `global:industry` 2069 placed in
  163 batches; `tickers:global` 1711/1882; `flows:openalex` streaming
  (CNPq: 5000 works of 499911 -> 5252 institutions, top 100, $0.0025).
- OpenAlex skips are geocode misses, not API failures: JSPS, EPSRC,
  NSERC Canada, NRF Korea all failed Nominatim lookup. Next fix is a
  per-funder coords map (FUNDER_LAT/FUNDER_LNG covers one pair only).
  Suggested HQs: JSPS Tokyo 35.68,139.76; EPSRC Swindon 51.56,-1.78;
  NSERC Ottawa 45.42,-75.70; NRF Daejeon 36.35,127.38.
- `apiLog` now masks credential query params (`redactUrlSecrets` in
  httpCache.ts) — `api_key=***` in terminal history and pasted logs.
  Past logs already emitted still hold the real key; rotate the free
  OpenAlex key if any raw log was shared. tsc/test deferred to user
  local run (live DB run owns the CPU).
- `names:sync` gated: read-only scan prints scanned/CIKs/rows-affected,
  then a TTY `[y/N]` prompt (default no) approves the rewrites; `--yes`
  for chains, non-TTY without it aborts. README chain uses `-- --yes`.
- 13F rerun verdict: YES, once, after coords_populate (chain order).
  Holdings match against currently placed rows by CUSIP-ticker then
  name, so the 14.5k new global entities + 1711 new tickers convert
  old misses into new 13f flows; same-quarter upserts stay idempotent.
  Filings + CUSIP map are cached, so the rerun is mostly DB matching.
- Skip list lives at backend/data/cache/openalex/skipped-funders.json (not
  backend/data root) — 5 entries verified; 5th skip is DST India
  (F4320320719). Same worktree as user confirmed via run cache.
- Funder geocode is now env pin -> src/data/funder-coords.json -> Nominatim
  x2 -> skip. File seeded with the 5 skipped HQs (city-level manual-hq:
  Tokyo, Swindon, Ottawa, Daejeon, New Delhi); LLM repair passes append
  with source llm. Skip error names the exact F-code to add. Contract
  test in openalexFlows.test.ts; tsc/test still deferred to user local.
- OpenAlex geo reviewed, no fix needed: funder env->file->Nominatim x2->
  recorded skip; institutions use ROR geo with no Nominatim fallback by
  design (spares the shared 1/s budget); 150ms throttle sits inside the
  10/s keyless budget. Correction: empty Nominatim `[]` IS cached (it is
  a successful fetch), so reruns replay skips silently instead of
  re-firing name queries as earlier stated — same outcome, less noise.
- coords_populate: 18k pending at observed 45s/25 (1.8s each) is ~9h;
  resumable, cellular-light (tens of MB). Rate can only improve as
  cached misses replay free.
- Coords retry phase REMOVED (user-verified: near-100% primary miss on
  GLEIF foreign batches, retries were ~2/3 of all queries). Misses now go
  straight to dead-lines + geoStatus failed (the LLM queue); no centroid
  hits to pollute exact placement. fallbackQueries kept (13F fund
  geocoding still calls it) with its tests. Live run unaffected until
  restart (old code loaded); tsc/tests deferred to user local.
- Bulk-geo survey given: Census batch for the US slice (10k/call, free,
  pairs with LLM/regex parse), Modal batch endpoint if deployed,
  self-hosted Photon post-demo; commercial batch tiers too small.
- Census batch BUILT (censusBatch.ts + pipeline pre-pass, user to ctrl-c
  then restart): US-parseable rows resolve in one POST (locations/
  addressbatch, Public_AR_Current, response lon-first verified against
  spec + mirror); misses/outages fall through to Nominatim, never to
  failed. Tests added + registered; tsc/tests MUST run after ctrl-c
  before the restart (live run blocked verification).
- CORRECTION: retry phase RESTORED. The finished batch showed 412
  primaries (193 hits) + 339 retries (173 hits) — 51% rescue, nearly
  doubling placement to 89%. The "never works" read mistook query share
  for rescue rate. Evidence now lives in the code comment; summary line
  reports census/pre-retry/rescued separately.
- `--census-failed` added (coords_populate): Census-only repass over
  geoStatus=failed rows, hits written + marked placed, rest stay failed.
  Query scoping extracted to testable pendingWhere (3 contract tests).
- VERIFIED (run ctrl-c'd, CPU free): tsc clean, build clean, 24/24
  focused tests green (censusBatch + pipeline on dist). Live 3-address
  Census probe: Pittsburgh 40.442,-79.995 ✓, DC 38.845,-76.928 ✓,
  bogus row null ✓. Also fixed: node:buffer has no FormData export —
  censusBatch uses the Node globals now.
- Census pacing + logging (user catch): batched POSTs now share a 1s
  limiter (both call sites), per-row `[census] addr -> lat,lng|miss`
  lines join the batch [API] line, interval pinned by test. Takes
  effect on next restart. tsc/tests UNVERIFIED (a run is active again)
  — user runs locally. Note: failed queue looks foreign-dominated, so
  --census-failed yield will be US-slice-only; count line shows the
  parseable share.
- Outcome colors: green hit / red miss address lines (census rows,
  coords hits — new — retry-miss, llm-queue), TTY-only with NO_COLOR
  respected, pin test added. Takes effect on next restart; tsc/tests
  UNVERIFIED again (run still active).
- dead-lines audit: all 693 entries are FULL original addresses (the 12
  short ones are native short foreign forms, not stripped fallbacks).
  Code agrees: only byQuery originals are logged; the lone truncated
  path (400 on a fallback query) has evidently never fired. DB
  businessAddress likewise untouched on failed rows — LLM pass reads
  full addresses from both sources.
- Census per-row log now echoes the parse: `[census] <query> |
  [street, city, state, zip] = [st, c, s, z] -> lat,lng|miss`
  (green/red kept). Log-line-only change, no test; tsc/tests
  UNVERIFIED (run active).
- US DST ended Sun 2026-11-01 (yesterday), not today. Our logs are
  ISO UTC so unaffected; local times fall back an hour.
- census-failed loop BUG fixed: zero-yield pages never broke the scan
  (same 358 rescanned to run 500). Loop now pages past fruitless runs
  and breaks on a fruitless tail, mirroring --all. Census lines now
  always print with a "(no api call)" suffix at zero rows, and
  US-shaped-but-unparseable addresses log red `-> unparseable` each
  (foreign stays silent; isUsShaped pinned by test). Dead-lines census:
  0/693 parseable; 26 stateless-US rows are the parser gap (state must
  come from zip or LLM). UNVERIFIED (spin active) — ctrl-c, verify
  locally, restart.
- Repass stops after run 1 BY DESIGN (fruitless-tail break: 358 < 500
  with 0 placed = whole set seen, no yield). State codes now validated
  against a real 50+DC+PR+territories set in both parser and flag
  (kills the "UR,, 50450" Kuala Lumpur false positive; regressions
  pinned). Every row logs its disposition: green hit, red miss /
  unparseable, plain foreign-skipped. 332/358 were foreign-silent.
  UNVERIFIED (run active).
- Parser: zip-less US rows now accepted with blank zip (spec allows
  null components; Boca Raton FL was the live case), PO boxes rejected
  (street-range engine can't place them; Cayman KY row stays foreign).
  Malta-MT / Cayman-KY shaped rows may take a free No_Match slot and
  fall through — documented in code. Tests extended. UNVERIFIED (run
  active).
- REVERTED the zip-less branch (user call, correct): live CA/DE/IL rows
  all mis-parsed as states, false positives outnumbering hits. Shape
  alone can't split state from country — zip anchors, LLM owns the
  rest. Repass rows now keyed by address text (dedupes shared
  addresses; fixes entity ids in the batch log). Tests updated.
  UNVERIFIED (run active again).
- VERIFIED ef20e77 (window was actually free — pgrep guard kept
  self-matching its own command line; bracket-trick from now on): tsc
  clean, build clean, 33/33 focused tests green on fresh dist
  (censusBatch + pipeline + httpCache), unparseable probe PROBE-OK
  (26/10/1). User blessed to restart coords --all (~9h, retries
  included in that number).
- apiLog notes now `[for: X]` (were `(X)`, read as part of the query).
  VERIFIED: tsc/build clean, 7/7 httpCache green. Advised user: yes to
  Wonder in parallel, fenced to frontend-only on its own branch, no
  backend scripts or DB writes; review-first per the TODO reminders.
- Doc sweep 2026-11-02 PM (nothing left unnoted): build now ships
  src/data JSON seeds into dist/data (tsc emits code only; without the
  copy, dist runs missed funder-coords AND geo-mapping — committed as
  3eb5345 with no notes entry until now).
- ROR idea (not built): funders carry ids.ror and ROR records hold
  real addresses — following funder→ROR→coords would replace fuzzy
  Nominatim name search deterministically. Cheaper than LLM per
  funder; file pins cover the 5 skips meanwhile.
- Retry-miss diagnosis, batch 409q/88% (0 census, 182 pre-retry, 353
  retries/178 rescued, +49 dead-lines): miss classes are PO boxes
  (unplaceable, correct), floor/suite/unit prefixes (2nd Floor, STE,
  601/701), building/campus names (The Point, business parks), rural
  qualifiers (NR.), tiny territories (Gibraltar), digits-in-street
  (FR), and stateless-US (Census gap → LLM queue, correct). Cheapest
  future win: strip C/O + floor/suite/unit prefixes pre-query.
- SUSPECTED BUG (code-read, needs log evidence): transient 5xx rows
  are added to missLog and flushMissLog persists them; next run
  preloads dead-lines and dead-skips them with zero calls, then
  nextGeoStatus(false,false) marks them failed — one blip could fail
  a row forever. Fix sketch: exclude transientTexts at flush.
  OUTCOME: user reports zero "skipping this run" in this run (no old
  logs to check) → zero known impact, fix deferred post-run as a
  TODO item with the CACHE_REFRESH + --retry-failed recovery path.
- Handoff 2026-11-02 19:46 GMT confirmed (Wonder branch
  wonder/globe-sleek; working there per user). Built: (1) tile-refresh
  hint line under ZoomHint (same one-shot fade, refresh button already
  existed); (2) university quota in allocateRegionQuotas (~8%, min 2,
  backfilled, type-gated so old callers unaffected); (3) popup toggles
  say flows + institution noun for education/Funder rows. VERIFIED:
  backend tsc/build clean, 9/9 quota tests; frontend tsc+vite build
  clean, oxlint 6 pre-existing warnings, 0 new. No DB writes.
- Tile hint moved above the scroll hint (bottom 6rem over 3.5rem).
  CSS-only, no verification applicable.
- Arc verdict (ucn.PNG): US→China over the Arctic is CORRECT great
  circle geometry (SLERP + unwrap + wrapLongitude all check out) —
  real flights route that way; Mercator + world copies make it look
  dramatic. User confirmed keep-as-is (no rhumb restyle).
- P625 ASSESSMENT (user hoped -80% non-US geocode): measured ~15%,
  not 80%. One 31-LEI probe: 28/31 coords (96% notable slice, 4/6 of
  item-having obscure; direct P625 rare x2, rest HQ-hop city-level).
  Hard ceiling: industry files show only ~2817/16279 lei: rows have
  ANY item (2069 hits + 748 nulls) — 83% item-less can't join P1278
  at all. Implementation rules found: direct beats hop (1 Vienna-vs-
  NYC conflict seen), ORDER BY first-wins for multi-HQ (1 triple:
  London/Dublin/Jersey). Still worth a global:coords script (VALUES
  batches like industry, ~22min SPARQL, no schema change, city-level
  authoritative dots, ~2h Nominatim saved) — offered, awaiting call.
  No DB writes made; probes were 1 read-only SPARQL GET.
- SKIP IS FAILED (user: reruns fail the same way, no pending limbo).
  nextGeoStatus(found) -> placed/failed; junk + errors-after-retry now
  DB-failed, outs are LLM pass / global:coords / --census-failed only.
  PipelineSummary + runTotals + progress line dropped `skipped` for
  `failed` (dead/junk stay as zero-API-call sub-counts). Nominatim got
  the SPARQL shape: shared 1.1s limiter (kept), apiLog (kept), 3x/15s
  retry on 429/5xx/network (new); persistent 429 throws like 403
  (usage problem, must be heard). Census batch POST: same 3x/15s
  retry, still throws spent (callers degrade, never fail). Errors are
  failed but NEVER dead-lined (distinct retry-error line) — fixes the
  deferred transient-to-dead-lines bug. VERIFIED: tsc clean, 28/28
  pipeline+censusBatch focused tests (failing-first on new
  expectations). TODO added: prompts.md update (Wonder's prompts +
  /clear losses, from session logs). No DB writes.
- RENAMED 2026-11-02 (user, right after ctrl-c): coords_populate ->
  coords:populate, global:sync -> sync:global, global:industry ->
  industry:global, global:coords -> coords:global (tickers:global already
  fit). Keys + ingest:all ref + error strings + comments + README/TODO/
  DATASETS/.env.example refs; filenames keep underscores, run-log
  history keeps old names. VERIFIED: keys resolve, tsc clean. Also
  ticked: coords:p625 phase, transient dead-lines, Wonder reminders,
  dark mode, sparkline (Yahoo daily change %, not Stooq). No DB writes.
- coords:global 429/502 (user, live): 502 is known endpoint flapping
  (retries absorb; dead batches skip + retry next run, never cached).
  429 is throttling despite our 12/min pace — suspects are the
  placeholder UA (if WIKIDATA_USER_AGENT unset) and the shared cellular
  IP. Gap fixed: SPARQL fetchers ignored Retry-After (GLEIF honored
  it) — new sparqlRetryWaitMs helper (cap 120s, 15s steps fallback)
  wired into region/industry/coords fetchers + test. VERIFIED: tsc
  clean, 15/15 globalSync tests. User to check [config] UA warning +
  set WIKIDATA_USER_AGENT. No DB writes.
- coords:global result (user, live): 1187 placed / 5915 (20.07%) in 60
  batches — matches the assessment; failed rows were eligible, so part
  of the 1187 came out of the LLM queue (post-hoc split unknowable,
  placement overwrites status). Per-batch red/green/mixed lines added
  for the next run. VERIFIED: tsc clean, existing tests green.
- Modal keys (Wonder's suggestion, env-parsed per user): all 3 workers
  (geocode/formalize/inference) now gate on MODAL_API_KEY from the
  `whofundsit` Modal secret, fail-closed, hmac-compared; TS callers
  send `key` from backend/.env (geocode/formalize throw when unset,
  normalize warns once + skips, all surface {"error"} loud). Deploy:
  `modal secret create whofundsit MODAL_API_KEY=...` + redeploy.
  VERIFIED: tsc clean, 40/40 pipeline+formalize+globalSync tests,
  py_compile on all 3 workers. No DB writes.
- STACK BADGES ff01fba (REMEMBER: user may want this changed). Measured
  511 multi-company stacks in seeds (NYC 212 on one dot). Every stack now
  one dot + white count badge; click expands a deterministic hex-packed
  ring (constant screen radius from move-end zoom), members individually
  clickable, empty click collapses, search into a stack auto-expands,
  tooltip says "N more here — click to expand", popup anchors the ring
  dot, legend item added. Arcs stay at true centers. VERIFIED: frontend
  tsc+vite build clean, oxlint 6 pre-existing EntityPopup warnings, 0 new
  (no frontend test runner — visual check is the TODO item). Check
  examples in TODO: SF Salesforce+DocuSign, NYC Medallion+TG Therapeutics.
  No DB writes.
- BADGE RECOUNT 14388d2 (user: Dynavax showed 13 = same-company rows).
  Badges now count companies via companyGroupKey (Assets row reps),
  not rows: single-company groups render one dot, no badge, click
  selects; rings fan companies. Names rejected as identity (same-CIK
  punctuation variants vs same-name distinct LEIs). VERIFIED: frontend
  build clean, oxlint 6 pre-existing. No DB writes.
- Ring clicks no longer fly (user): sub-dot clicks select without camera
  flight; only the badge dives, and only from state/country distance.
  Frontend build clean, oxlint 6 pre-existing. No DB writes.
- Modal NATIVE proxy auth (user: no api_key, checked docs): workers use
  requires_proxy_auth=True (proxy enforces pre-function); my hand-rolled
  body-key gate removed. TS sends Modal-Key/Secret headers from
  MODAL_TOKEN_ID/MODAL_TOKEN_SECRET (user's exported names; MODEL_ read
  as MODAL_ typo). 401/403 throw loud auth errors. NOTE: docs say proxy
  tokens are wk-/ws- values, separate from CLI API tokens — if the
  user's exports are API tokens, first modal call 401s with a clear
  message; then `modal workspace proxy-tokens create`. VERIFIED: tsc
  clean, 47/47 focused tests, py_compile x3. No DB writes.
- RING HONESTY (user: % modes must not present Other+Untracked as the
  remainder). The Untracked legend row now renders in true-% mode only
  (real public float); tracked-relative hides it — its 0.0% was
  definitional (tracked sums to 100%), contradicting the code's own
  "Public shows no percentage" spec. Other (n) keeps its tracked share
  (measured, note-disclaimed). VERIFIED: frontend build clean, oxlint 6
  pre-existing. No DB writes.
