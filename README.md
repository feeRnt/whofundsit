# Who Funds It (?)

Many people want to know, when making a purchase, buying a subscription, or reading a medical study, what the primary incentives are behind the service or who are its prime beneficiaries. The best way to understand this information is to see what funding is behind any company, organization or even an educational institution.

This webapp is an interactive global corporate financing map that showcases and elucidates the flow and source of money, with bigger graphical representation to places with more funds, e.g., BlackRock. While also including banks to bring out the scale of debt, the sources for this mapping will be stocks, equity, large donations and the like, and AI - Open-Weighted Llama - is used for the processing of the public databases to create a human-intuitive map from the hard data.

## How to run

### Prereqs

- Node.js 20+ and npm
- PostgreSQL 14+ with a `whofundsit` database (docker command in the quickstart below)

### Judge quickstart (two commands, ~2 minutes)

1. Start Postgres, e.g.:
   `docker run --name whofundsit-pg -e POSTGRES_PASSWORD=YOUR_PASSWORD -e POSTGRES_DB=whofundsit -p 5432:5432 -d postgres:16`
2. From `whofundsit/`:
   ```
   npm install
   cp backend/.env.example backend/.env   # works as-is with the docker command above
   npm run demo
   ```
   This pushes the schema, loads the committed seed dataset, builds, and
   serves on one port.
3. Open `http://localhost:4000` in a browser: globe/flat-map toggle, click any
   dot for value, address, and EDGAR evidence links.

No SEC calls, no API keys, and no ingest wait: the demo dataset ships in the repo.

### Maintainer data refresh

```bash
cd backend
npm run bulk            # SEC nightly ZIPs -> base layer (one long run, cached)
npm run ingest:all      # frames top-up + Nominatim geocoding
npm run flows:openalex  # grant arcs (OpenAlex, cached)
npm run flows:13f       # fund arcs (all 13F filers; THIRTEENF_MAX_MANAGERS caps it)
npm run names:sync      # legal filer names from the local archive
npm run db:export       # snapshot tables into prisma/seed-data/
```

Then commit the updated seed files. Report suspected duplicates with
`npm run dedupe:report`; fold approved ones with
`npm run merge -- <keepId> <dropId>` (provenance is kept on the survivor).

## Scripts reference

From `whofundsit/` (workspace shortcuts):

| Script | What it does |
|---|---|
| `dev:frontend` | Vite dev server (`:5173`, `--host` for LAN) |
| `dev:backend` | Express with hot reload |
| `build` | Production builds, frontend then backend |
| `serve` | Build + serve both on `:4000` (same-origin demo) |
| `demo` | `db:push` + `db:seed` + `serve` — the judge path (seed refuses non-empty DBs unless `DEMO_WIPE_OK=1`) |

From `whofundsit/frontend/`:

| Script | What it does |
|---|---|
| `dev` | Vite dev server |
| `build` | `tsc -b` + production bundle |
| `lint` | oxlint |
| `preview` | Preview the production bundle locally |

From `whofundsit/backend/` (pipeline order):

| Script | What it does |
|---|---|
| `bulk` | SEC nightly ZIPs → base entity layer (long first run, then cached) |
| `ingest` | XBRL frames top-up for the current quarter |
| `coords_populate` | Nominatim geocoding, 1 req/s, biggest first (city/state fallback retry on misses; marks `geoStatus`, `--retry-failed` re-includes failed rows) |
| `deadlines:snapshot` | Copy local `dead-lines.json` into the committed seed for fresh clones |
| `ingest:all` | `ingest` + `coords_populate` in one go |
| `pipeline` | Geocode pending entities (≤100/run) + Modal cleanup when configured |
| `flows:openalex` | Grant arcs from OpenAlex (cached) |
| `flows:13f` | Fund arcs from every 13F-HR filer (core-scaled workers; `THIRTEENF_MAX_MANAGERS` caps it, `THIRTEENF_CONCURRENCY` tunes it, `THIRTEENF_SKIP_STALE=1` drops dead filers; unplaceable funds stub for coords retry) |
| `global:sync` | International companies (Wikidata → GLEIF) + ownership arcs (`GLOBAL_LIMIT`, `GLOBAL_MAX_CHILDREN`) |
| `regional:esef` | EU/UK financial facts onto `lei:` rows, native currency (`ESEF_LIMIT`) |
| `regional:twse` | Taiwan balance-sheet facts onto `lei:` rows in TWD (`TWSE_LIMIT`) |
| `names:sync` | Backfill legal filer names from the local archive |
| `industry:sync` | Backfill SIC industry + normalize `type` from the local archive (offline) |
| `merge -- <keep> <drop>` | Fold a duplicate row (repoints flows, keeps provenance) |
| `dedupe:report` | Print candidate duplicate groups for review (read-only) |
| `db:push` | Push the Prisma schema to Postgres |
| `db:export` | Snapshot tables into `prisma/seed-data/` for committing |
| `db:seed` | Wipe + reload tables from the committed seeds (judge path) |
| `verify:claims` | Stochastic methodology audit: 10% seeded sample per source/region/index/flow cell (cap 5) vs live SEC + Nominatim, 0-100 scores, `% verified` per cell, report in `data/verification-report.json` (`VERIFY_FRACTION`, `VERIFY_MAX_PER_CELL`, `VERIFY_SEED`; `VERIFY_SAMPLE=25` restores the original fixed-25 spec) |
| `test` | Backend unit suite (`tsx --test`) |
| `dev` / `build` / `start` | Hot reload / compile / run the API + static server |

Data-source licenses and cache locations: [DATASETS.md](DATASETS.md).

## License:
Apache 2.0. See LICENSE for the full license text.