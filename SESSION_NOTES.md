# Session notes (2026-10-31, pre-restart)

Running log for picking work back up. Update when the picture changes.

## Where things stand

- App healthy: globe/2D toggle, dark popups, accordion menus, focus mode,
  ownership layer, green grant arcs all shipped. Frontend builds green.
- Backend 35/35 tests green. Tree clean; all commits `cf408c9` and older.
- My commits go out as `Muse Code <muse-code@users.local>` via
  `git -c user.name=... -c user.email=... commit` (standing rule, in memory).

## User's runs (their machine, their DB — I never touch it)

- `names:sync` finished (?): renames entities to legal filer names.
- Full `flows:13f` RUNNING or QUEUED: 16,208 filers discovered (~19h at old
  single-threaded pace — see perf note below).
- Still to run: `npm run global:sync`, `coords_populate --all`,
  `npm run db:export` (+ commit seeds).

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

1. User: finish 13F run → global:sync → coords backfill → db:export → commit seeds.
2. Me: 13F concurrency (worker pool, keep SEC ≤10/s + Nominatim 1/s) — throttles
   inspected, NOT concurrency-safe yet (module-level timestamps need a mutex).
3. Me: regional loaders (ESEF + TWSE verified shapes; EDINET + DART defensive).
4. Me: currency column + display (needed before regional facts land).
5. User: fresh-DB `npm run demo` rehearsal.
6. Last: dark mode, beneficial ownership, OpenAlex cursor paging.
