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
- **Committed derivatives:** coordinates inside `seed-data/entities.json`,
  plus the `backend/src/data/geo-mapping.json` address→coords seed
  (`npm run geo:snapshot`, ODbL 1.0 share-alike, attribution in-file).
  Because these derive from ODbL data, any public deployment must keep the
  © OpenStreetMap attribution visible (see TODO: standalone-cache license).
- **LLM address repair (adopted approach, 2026-11-02, not yet built):**
  deformed address → open-weight LLM on Modal → structured JSON
  (house_number/street/city/state/postal) → Census batch (US) or Nominatim
  string lookup (foreign) → lat/lng. The LLM parses, never geocodes:
  coordinates come only from vetted engines (Census MAF/TIGER for US,
  OSM-backed Nominatim for the rest; OpenCage/Gisgraphy as alternates).

## US Census batch geocoder (US addresses, bulk)

- **What we take:** `lat`/`lng` for US-parseable rows in one batched POST
  (SEC-shaped `street, city, ST ZIP`), ahead of Nominatim; misses and
  outages fall through to the normal path, never to failed.
- **Terms:** free, no key, US-only (PR + Island Areas included), 10k
  records per batch, MAF/TIGER source, no stated rate limit (built for
  bulk). Public-domain US federal data — no attribution burden.
- **Local copies (gitignored):** hits land in the same
  `backend/data/cache/geo/` per-query files as Nominatim results.
- **Repass:** `coords:populate -- --census-failed` runs the Census batch
  over LLM-flagged (`geoStatus: failed`) rows only — no Nominatim, no
  retries; hits are written + marked placed, the rest stay failed.

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

- **What we take:** the Liberty vector style + tiles (light mode), loaded
  live in the browser at runtime (nothing cached or shipped). Dark mode
  uses CARTO's Dark Matter GL style the same way (also free, keyless).
- **Terms:** free keyless use **with attribution**; the map's built-in
  attribution control renders it (© OpenMapTiles © OpenStreetMap
  contributors, © CARTO on dark mode).

## Wikidata SPARQL (international company list)

- **What we take:** bulk company crosswalk — name, ISIN, LEI, exchange,
  HQ — via `query.wikidata.org/sparql` (`npm run sync:global`), plus
  industry labels via P452 VALUES batches (`npm run industry:global`).
- **Terms:** **CC0** (public domain dedication). Courtesy rules: send a
  descriptive `User-Agent` (`WIKIDATA_USER_AGENT`) and keep queries
  bounded (`GLOBAL_LIMIT`).
- **Local copies (gitignored):** `backend/data/cache/global/wikidata-*.json`.

## GLEIF (legal addresses + corporate children)

- **What we take:** per-LEI record (legal name + HQ address) and
  `direct-children` (full child records) via `api.gleif.org`.
- **Terms:** **CC0**, no key, **60 req/min/user published** (official API
  docs, Terms & Conditions); we pace ~55/min via an 1100ms shared gate,
  everything cached. (Our old "~10/s, no stated limit" note was wrong —
  corrected 2026-11-02 from the official docs.)
- **Local copies (gitignored):** `backend/data/cache/global/gleif/`,
  `backend/data/cache/global/gleif-children/`.
- **Committed derivatives:** `lei:*` entities + `ownership` flows in seeds.

## OpenFIGI (CUSIP → ticker for 13F matching)

- **What we take:** ticker per holding CUSIP via `POST api.openfigi.com/v3/mapping`
  (batched 10 keyless / 100 with free `OPENFIGI_API_KEY`).
- **Terms:** FIGI symbology is **public-domain dedicated** (no reuse/redistribution
  restrictions). CUSIP *input* identifiers belong to CUSIP Global Services, so we
  use them only as ephemeral lookup keys: the CUSIP→ticker map lives in the
  gitignored cache and CUSIPs are never committed anywhere new.
- **Local copies (gitignored):** `backend/data/cache/13f/cusip-map.json`,
  `backend/data/cache/openfigi/isin-map.json` (ISIN→primary listing for
  `tickers:global`; ISINs get the same ephemeral treatment since US ISINs
  embed a CUSIP).

## ESEF repository (EU/UK financial facts)

- **What we take:** per-LEI filing lookup + latest xBRL-JSON facts file
  (`filings.xbrl.org/api`, `npm run regional:esef`).
- **Terms:** **no license stated** — XBRL International demonstrator whose
  intended users explicitly include analysts/fund managers; no rate limits
  published. Posture: small-scale, polite (250ms), cached, link back; never
  bulk-mirror the repository. Re-check before any big expansion.
- **Local copies (gitignored):** `backend/data/cache/regional/esef-*.json`.

## TWSE OpenAPI (Taiwan financial facts)

- **What we take:** balance sheets per industry + company basics
  (`/v1/opendata/t187ap*`, `npm run regional:twse`).
- **Terms:** Taiwan **Open Government Data License** (via data.gov.tw):
  free reuse with attribution, data kept intact. TWSE site terms ban
  scraping *outside* agreed means — the official OpenAPI is the agreed
  means, so we use only `/v1/opendata/*` endpoints. No rate limits are
  published (spec + site terms checked 2026-11-02); we pace 500ms
  sequential + cached. Field note: rushed requests may return silent
  empties instead of errors — never speed this up without re-checking.
- **Local copies (gitignored):** `backend/data/cache/regional/twse-*.json`.

## Yahoo Finance (day-change quotes for popups)

- **What we take:** day-change quote per ticker via the public chart
  endpoint, proxied through `GET /api/quote` with a 24-hour cache —
  fetched only when a popup opens. (Stooq was the previous source; it
  now serves bot-wall HTML/JS to server-side fetches.)
- **Terms:** no key; unofficial endpoint, same one every OSS quote widget
  uses. Polite by design: 1 req/s self-pacing, per-ticker 24h cache,
  popup-only pulls — if it ever 429s the popup just hides the row.
- **Local copies (gitignored):** `backend/data/cache/quotes/*.json`.

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
