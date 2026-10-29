# TODO

## ⚠️ BIG TODO — missing proper address field on `Entity`

- [ ] **Add a dedicated business-address field (do later).**
      `Entity` currently has only `rawAddressText`, which holds the SEC Frames state code (e.g. `US-IL`) — not a real
      address. Fetch the business address per CIK from the SEC submissions API (street/city/state), store it in a new
      field (e.g. `businessAddress`), then geocode it to `lat`/`lng` via OpenStreetMap/Nominatim with caching.
      Frames rows keep `loc` → `rawAddressText` until then.

## ⚠️ BIG TODO — SEC ingestion follow-ups (`backend/src/services/secIngestion.ts`)

- [ ] **Replace the placeholder `Entity.type = "Company"` with real SIC industry data.**
      SEC Frames has no SIC. Enrich per CIK from the SEC submissions API (`sicDescription`, e.g. medical, electronics),
      so `Entity.type` reflects the actual industry/trading category instead of the placeholder.
- [ ] **Business address + real coordinates.**
      Frames only gives a state code (`loc`, e.g. `US-IL`), stored as `rawAddressText` with `lat/lng = 0` placeholders.
      Next step: fetch the business address per CIK (SEC submissions), store it as a proper address field,
      then translate address → lat/lng via OpenStreetMap/Nominatim (the ground-rules “Address Engine”, with caching).
- [ ] **Run live ingestion once `DATABASE_URL` is configured** (`backend/.env`), then verify row counts
      (`fetched` capped at 500, `upserted` + `skipped` = `fetched`) and spot-check a filing by `secFilingNumber` on EDGAR.
