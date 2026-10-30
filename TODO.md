# TODO

## ✅ DONE — proper address field on `Entity`

- [x] **Added `businessAddress`, populated by `npm run ingest` from SEC submissions, geocoded by `npm run pipeline`.**

## ⚠️ BIG TODO — SEC ingestion follow-ups (`backend/src/services/secIngestion.ts`)

- [ ] **Replace the placeholder `Entity.type = "Company"` with real SIC industry data.**
      SEC Frames has no SIC. Enrich per CIK from the SEC submissions API (`sicDescription`, e.g. medical, electronics),
      so `Entity.type` reflects the actual industry/trading category instead of the placeholder.
- [x] **Business address + real coordinates.** (Done: ingest fetches submissions addresses into `businessAddress`;
      `npm run pipeline` geocodes them via Nominatim. `rawAddressText` keeps `loc`.)
- [ ] **Run live ingestion once `DATABASE_URL` is configured** (`backend/.env`), then verify row counts
      (`fetched` capped at 500, `upserted` + `skipped` = `fetched`) and spot-check a filing by `secFilingNumber` on EDGAR.

## Frontend globe follow-ups (`frontend/src/Globe.tsx`)

- [ ] **Verify the globe renders clean in the browser.**
      Globe projection now ships via `MapLibreOverlay` from `@deck.gl/maplibre` (the docs-blessed MapLibre v6
      path) in `frontend/src/components/MapGlobe.tsx` with the OpenFreeMap Liberty style. If distortion returns,
      that file is the first place to look. Note: the worker import must stay in `?url` form —
      `?worker&url` reintroduced the MIME error in the browser.
