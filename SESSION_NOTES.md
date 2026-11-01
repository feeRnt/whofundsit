# Session notes (2026-10-31 night — agent signed off, user asleep)

Running log for picking work back up. Update when the picture changes.

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

## Shipped overnight (all as Muse Code, builds green, 44/44 tests)

- Multi-currency: `Entity.currency` + formatMoney display (needs db:push).
- `regional:esef` + `regional:twse` with tests, docs, ToS entries.
- 13F: CUSIP matching, worker pool, core-scaled workers, stale-filer skip.
- Focus mode (single-company arcs), green grant arcs, ownership layer.
- Demo packaging, DATASETS.md, script reference, geo LICENSE.txt.
