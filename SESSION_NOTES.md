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

- Overnight chain LAUNCHED ~20:35 GMT: global:sync → coords --all (~5h)
  → 13f/500 → db:export → seed commit. Fix was `npx prisma db push`
  (currency column P2022) — user confirmed fce0a2a present, chain green.
- `names:sync` result unknown (was running at last report).
- Regionals committed but NEVER RUN LIVE (need chain to finish first).
- `npm run demo` never rehearsed on a fresh DB (do right after chain).
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
