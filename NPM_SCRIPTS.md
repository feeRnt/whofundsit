# NPM scripts

Run root scripts from `whofundsit/`, backend scripts from
`whofundsit/backend/` (or `npm --prefix backend run <name>`), frontend
scripts from `whofundsit/frontend/`. Pipeline run-order is in the
README's maintainer section; this file is the what-and-why per script.

## Root (`whofundsit/`)

| Script | What it does |
|---|---|
| `dev:frontend` | Vite dev server (`:5173`, `--host` for LAN) |
| `dev:backend` | Express with hot reload |
| `build` | Production builds, frontend then backend |
| `serve` | Build + serve both on `:4000` (same-origin demo) |
| `demo` | `db:push` + `db:seed` + `serve` — the judge path (seed refuses non-empty DBs unless `DEMO_WIPE_OK=1`) |

## Backend (`whofundsit/backend/`, pipeline order)

| Script | What it does |
|---|---|
| `bulk` | SEC nightly ZIPs → base entity layer (long first run, then cached; `BULK_MAX_ENTRIES` caps it, `BULK_REFRESH=1` re-downloads) |
| `ingest` | XBRL frames top-up for the current quarter (cached per quarter) |
| `coords:populate` | Nominatim geocoding, 1 req/s, biggest first (city/state fallback retry on misses; marks `geoStatus`; `--retry-failed` re-includes failed rows, `--census-failed` repasses failures via Census batch, `--llm-N` geocodes `llm-pass-N.json`) |
| `deadlines:snapshot` | Copy local `dead-lines.json` into the committed seed for fresh clones |
| `geo:snapshot` | Export address→coords mapping into the committed ODbL seed for fresh clones |
| `ingest:all` | `ingest` + `coords:populate` in one go |
| `pipeline` | Geocode pending entities (≤100/run, single batch) |
| `flows:openalex` | Grant arcs from OpenAlex funders (`OPENALEX_FUNDER_IDS` list, cursor-paged with key, cached) |
| `flows:13f` | Fund arcs from every 13F-HR filer (core-scaled workers; `THIRTEENF_MAX_MANAGERS` caps it, `THIRTEENF_CONCURRENCY` tunes it, `THIRTEENF_SKIP_STALE=1` drops dead filers; unmatched holdings are skipped — keep-everything stubs are a parked TODO) |
| `sync:global` | International companies (Wikidata → GLEIF) + ownership arcs (`GLOBAL_LIMIT`, `GLOBAL_MAX_CHILDREN`) |
| `industry:global` | Backfill industry on lei: rows from Wikidata P452 (batched VALUES, cached, gated; `INDUSTRY_GLOBAL_LIMIT` caps it) |
| `tickers:global` | Backfill primary tickers on `lei:` rows via ISIN→OpenFIGI (same `GLOBAL_LIMIT` as the sync) |
| `regional:esef` | EU/UK financial facts onto `lei:` rows, native currency (`ESEF_LIMIT`) |
| `regional:twse` | Taiwan balance-sheet facts onto `lei:` rows in TWD (`TWSE_LIMIT`) |
| `names:sync` | Backfill legal filer names from the local archive (`--list` previews every rename, `--yes` approves; declines are cached in gitignored `data/cache/names-sync.json`, `--cached` reviews past skips) |
| `industry:sync` | Backfill SIC industry + normalize `type` from the local archive (offline) |
| `coords:global` | Place unplaced `lei:` rows from Wikidata P625 (100-LEI VALUES batches; run before `coords:populate`) |
| `coords:p625` | Deprecated dry-run stub — use `coords:global` (this script only prints its contract and exits) |
| `formalize:addresses` | LLM address repair via the Modal server: `--pass=N` queues (`--limit=K` caps), or legacy file/stdin → JSON Lines |
| `merge -- <keep> <drop>` | Fold a duplicate row (repoints flows, keeps provenance) |
| `dedupe:report` | Print candidate duplicate groups for review (read-only) |
| `db:generate` | Regenerate the Prisma client |
| `db:push` | Push the Prisma schema to Postgres |
| `db:export` | Snapshot tables into `prisma/seed-data/` for committing |
| `db:seed` | Wipe + reload tables from the committed seeds (judge path) |
| `verify:claims` | Stochastic methodology audit: fixed-seed sample per source/region/index/flow cell vs live SEC + Nominatim, 0-100 scores, rolling tested-weighted `% verified` per arm in the committed snapshot, Glimmer-30B why/how per flag (`VERIFY_FRACTION`, `VERIFY_MAX_PER_CELL`, `VERIFY_SEED` overrides the seed, `--clean` to restart averages) |
| `verify:daily` | Cron-sized audit (~40 checks) + history append for the rolling snapshot |
| `verify:all` | `verify:claims` + `deadlines:snapshot` + `db:export` in one run-and-leave command |
| `test` | Backend unit suite (`tsx --test`) |
| `dev` | Hot reload (`tsx watch`) |
| `build` | Compile (`tsc`) + copy data JSONs into `dist/` |
| `start` | Run the API + static server (`node dist/index.js`, needs `build` first) |

## Frontend (`whofundsit/frontend/`)

| Script | What it does |
|---|---|
| `dev` | Vite dev server |
| `build` | `tsc -b` + production bundle |
| `lint` | oxlint |
| `preview` | Preview the production bundle locally |
