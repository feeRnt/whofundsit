# Datasets: sources, terms, and caches

Every live dataset behind WhoFundsIt, what its publisher allows, and where
our copy lives. Rule of thumb: raw downloads and API caches stay on the
maintainer's disk (gitignored); only small derived seeds ship in the repo.

## SEC EDGAR (frames, submissions, bulk ZIPs, 13F)

- **What we take:** XBRL company facts + frames (`data.sec.gov`), company
  submissions histories, `company_tickers.json`, the nightly bulk ZIPs, and
  13F-HR holdings tables.
- **Terms:** U.S. federal government works — public domain, no license
  restriction on reuse or redistribution. Fair access: max 10 req/s with a
  declared `User-Agent` (`SEC_USER_AGENT` in `backend/.env`); bulk ZIPs
  recompile nightly ~3:00 a.m. ET and are the preferred path for big pulls.
- **Local copies (gitignored):** `backend/data/submissions.zip`,
  `backend/data/companyfacts.zip`, `backend/data/cache/sec/`,
  `backend/data/cache/13f/`.
- **Committed derivatives:** `backend/prisma/seed-data/*.json` (facts,
  addresses, flows), `backend/src/data/*.ts` (via the ticker map).

## OpenStreetMap Nominatim (geocoding)

- **What we take:** `lat`/`lng` for SEC business addresses, one lookup each.
- **Terms:** OSM data is **ODbL** — free to use *with attribution* ("© OpenStreetMap
  contributors") carried wherever the coordinates surface. Usage policy:
  max 1 req/s with a declared `User-Agent` (`NOMINATIM_USER_AGENT`).
- **Local copies (gitignored):** `backend/data/cache/geo/`.
- **Committed derivatives:** coordinates inside `seed-data/entities.json`.
  Because these derive from ODbL data, any public deployment must keep the
  © OpenStreetMap attribution visible (see TODO: standalone-cache license).

## OpenAlex (grants: funders, works, institutions)

- **What we take:** funder record + funded works + author institutions for
  grant arcs (`api.openalex.org`).
- **Terms:** **CC0** (public domain dedication) — reuse freely, no
  permission needed. Courtesy rules: send a `mailto=` contact parameter and
  stay within the polite rate limits (see `OPENALEX_MAILTO`).
- **Local copies (gitignored):** `backend/data/cache/openalex/`.
- **Committed derivatives:** grant `CapitalFlow` rows + funder/institution
  entities in the seed files.

## OpenFreeMap (basemap tiles)

- **What we take:** the Liberty vector style + tiles, loaded live in the
  browser at runtime (nothing cached or shipped).
- **Terms:** free keyless use **with attribution**; the map's built-in
  attribution control renders it (© OpenMapTiles © OpenStreetMap contributors).

## Wikipedia (index snapshots)

- **What we take:** S&P 500 + Nasdaq-100 constituent ticker lists, via
  `backend/scripts/fetch_constituents.py`.
- **Terms:** page content is **CC BY-SA**, but bare ticker membership lists
  are facts. Snapshots are tiny and committed (`backend/src/data/*.ts`);
  re-run the script occasionally as membership drifts.

## Committed seeds (summary)

`backend/prisma/seed-data/entities.json` + `flows.json` mix public-domain
SEC facts, CC0 OpenAlex rows, and ODbL-derived coordinates. Redistributing
the seeds is fine provided the OSM attribution travels with them (this file
plus in-app attribution); nothing else in the chain requires permission.
