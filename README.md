# Who Funds It (?)

Many people want to know, when making a purchase, buying a subscription, or reading a medical study, what the primary incentives are behind the service or who are its prime beneficiaries. The best way to understand this information is to see what funding is behind any company, organization or even an educational institution.

This webapp is an interactive global corporate financing map that showcases the flow and source of money, with bigger graphical representation to places with more funds, e.g., BlackRock. Including banks or hedge-funds to bring out the scale of debt, the sources for this mapping will be stocks, equity, large donations and the like, and AI - Open-Weighted Llama - is used for the processing of the public databases to create a human-intuitive map from the hard data.

## How to run

### Prereqs (Windows, macOS, Linux)

- Node.js 20+ and npm
- PostgreSQL 14+ with a `whofundsit` database. Easiest on every OS: Docker
  (step 2). Linux/macOS can also run Postgres natively; on Windows use
  Docker Desktop (the native commands below are Unix-only).

### Demo quickstart (~5 minutes, all three OSes)

1. Clone the repo (any shell; on Windows `cmd.exe` run the npm lines one
   at a time — it has no `\` continuation):
   ```bash
   git clone --depth 1 https://github.com/feeRnt/whofundsit && cd whofundsit
   cp backend/.env.example backend/.env
   npm install-scripts approve esbuild @prisma/engines prisma
   npm install
   ```
2. Start Postgres.
   **Docker (recommended — identical on Windows, macOS, Linux):**
   `docker run --name whofundsit-pg -e POSTGRES_PASSWORD=YOUR_PASSWORD -e POSTGRES_DB=whofundsit -p 5432:5432 -d postgres:16`
   (Windows/macOS: install Docker Desktop first and keep it running.)
   `backend/.env` works as-is with this — skip to step 3.
   Already have a `whofundsit-pg` container? `docker start whofundsit-pg`.

   **No-Docker (Linux/macOS only):** install the server package first:
   ```bash
   # Arch:         sudo pacman -S postgresql
   # Debian/Ubuntu: sudo apt install postgresql  (self-initializes; skip initdb)
   # macOS:        brew install postgresql@16    (then follow its initdb hint)
   ```
   - Usermode (no sudo):
   ```bash
   initdb -D $HOME/whofundsit -E UTF8 --auth=trust
   pg_ctl -D $HOME/whofundsit -o "-p 5433 -k /tmp" -l $HOME/whofundsit.log start
   createdb -h /tmp -p 5433 whofundsit
   ```
   Then open `backend/.env` and set (replace the line — don't append a
   second `DATABASE_URL`):
   `DATABASE_URL="postgresql://$USER@localhost:5433/whofundsit"`
   Port taken? `ss -ltn | grep 5433` (Linux) or `lsof -i :5433` (macOS);
   stop the stale server (`pg_ctl -D $HOME/whofundsit stop`), then start again.
   - With sudo (Linux):
   ```bash
   sudo -iu postgres initdb -D /var/lib/postgres/data  # Arch only; Debian self-initializes
   sudo systemctl start postgresql
   sudo -iu postgres createuser -s $USER && createdb whofundsit
   ```
   The `.env` default (port 5432) works as-is here.

3. Start the demo (same on all OSes):
   ```bash
   npm run demo
   # Pushes the schema, loads the committed seed dataset, builds, and serves
   # on one port. No SEC calls, no API keys, no ingest wait: the dataset ships
   # in the repo. Answer the LAN question if you want other devices to reach it.
   ```
   Re-running into the same database? Prefix `DEMO_WIPE_OK=1` (Windows
   `cmd.exe`: `set DEMO_WIPE_OK=1 && npm run demo`):
   ```bash
   DEMO_WIPE_OK=1 npm run demo
   ```
   Or split the dev servers (two terminals — no `&`; it isn't portable):
   ```bash
   # terminal 1          # terminal 2
   npm run dev:backend   npm run dev:frontend
   ```

4. Open `http://localhost:4000` in a browser: globe/flat-map toggle, click any
   dot for value, address, and EDGAR evidence links. On another device on your
   LAN? Answer `y` at the prompt (or preset `HOST=0.0.0.0`), then open the
   `on your LAN:` URL from the startup log instead.

### Maintainer data refresh

```bash
cd backend
npm run bulk                 # SEC nightly ZIPs -> base layer (one long run, cached)
npm run ingest               # XBRL frames top-up for the current quarter
npm run sync:global          # international companies (Wikidata -> GLEIF) + ownership arcs
npm run industry:global      # industry backfill on lei: rows (Wikidata P452)
npm run tickers:global       # ticker backfill on lei: rows (ISIN -> OpenFIGI)
npm run regional:esef        # EU/UK facts (optional; ESEF_LIMIT caps it)
npm run regional:twse        # Taiwan facts (optional; TWSE_LIMIT caps it)
npm run flows:openalex       # grant arcs (OpenAlex, cursor-paged, cached)
npm run coords:global        # place lei: rows from Wikidata P625 (before Nominatim)
npm run coords:populate -- --all  # Nominatim geocoding, 1 req/s, biggest first
npm run flows:13f            # fund arcs (all 13F filers; THIRTEENF_MAX_MANAGERS caps it)
npm run industry:sync        # SIC industry backfill from the local archive (offline)
npm run names:sync -- --yes  # legal filer names (asks first without --yes; --list previews)
npm run verify:all           # verify:claims + deadlines:snapshot + db:export (run and leave)
```

LLM repair loop for ungeocoded rows (needs the Modal workers deployed):
```bash
npm run formalize:addresses -- --pass=1   # 70B parses DB failures -> llm-pass-1.json
npm run coords:populate -- --llm-1        # Census + structured Nominatim, marks outcomes
npm run formalize:addresses -- --pass=2   # retry prior misses (add --limit=K to cap)
npm run coords:populate -- --llm-2        # ... and so on
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
| `coords:populate` | Nominatim geocoding, 1 req/s, biggest first (city/state fallback retry on misses; marks `geoStatus`, `--retry-failed` re-includes failed rows, `--census-failed` repasses failures via Census batch, `--llm-N` geocodes `llm-pass-N.json`) |
| `deadlines:snapshot` | Copy local `dead-lines.json` into the committed seed for fresh clones |
| `geo:snapshot` | Export address→coords mapping into the committed ODbL seed for fresh clones |
| `ingest:all` | `ingest` + `coords:populate` in one go |
| `pipeline` | Geocode pending entities (≤100/run) + Modal cleanup when configured |
| `flows:openalex` | Grant arcs from OpenAlex funders (`OPENALEX_FUNDER_IDS` list, cursor-paged with key, cached) |
| `flows:13f` | Fund arcs from every 13F-HR filer (core-scaled workers; `THIRTEENF_MAX_MANAGERS` caps it, `THIRTEENF_CONCURRENCY` tunes it, `THIRTEENF_SKIP_STALE=1` drops dead filers; unplaceable funds stub for coords retry) |
| `sync:global` | International companies (Wikidata → GLEIF) + ownership arcs (`GLOBAL_LIMIT`, `GLOBAL_MAX_CHILDREN`) |
| `industry:global` | Backfill industry on lei: rows from Wikidata P452 (batched VALUES, cached, gated; `INDUSTRY_GLOBAL_LIMIT` caps it) |
| `tickers:global` | Backfill primary tickers on `lei:` rows via ISIN→OpenFIGI (same `GLOBAL_LIMIT` as the sync) |
| `regional:esef` | EU/UK financial facts onto `lei:` rows, native currency (`ESEF_LIMIT`) |
| `regional:twse` | Taiwan balance-sheet facts onto `lei:` rows in TWD (`TWSE_LIMIT`) |
| `names:sync` | Backfill legal filer names from the local archive (`--list` previews every rename, `--yes` approves) |
| `industry:sync` | Backfill SIC industry + normalize `type` from the local archive (offline) |
| `coords:global` | Place unplaced `lei:` rows from Wikidata P625 (100-LEI VALUES batches; run before `coords:populate`) |
| `coords:p625` | Deprecated dry-run stub — use `coords:global` (this script only prints its contract and exits) |
| `formalize:addresses` | LLM address repair: `--pass=N` queues (`--limit=K` caps), or legacy file/stdin → JSON Lines |
| `merge -- <keep> <drop>` | Fold a duplicate row (repoints flows, keeps provenance) |
| `dedupe:report` | Print candidate duplicate groups for review (read-only) |
| `db:push` | Push the Prisma schema to Postgres |
| `db:export` | Snapshot tables into `prisma/seed-data/` for committing |
| `db:seed` | Wipe + reload tables from the committed seeds (judge path) |
| `verify:claims` | Stochastic methodology audit: fresh random sample per source/region/index/flow cell vs live SEC + Nominatim, 0-100 scores, rolling tested-weighted `% verified` per arm in the committed snapshot, 8B why/how per flag (`VERIFY_FRACTION`, `VERIFY_MAX_PER_CELL`, `VERIFY_SEED` to reproduce, `--clean` to restart averages) |
| `verify:daily` | Cron-sized audit (~40 checks) + history append for the rolling snapshot |
| `verify:all` | `verify:claims` + `deadlines:snapshot` + `db:export` in one run-and-leave command |
| `test` | Backend unit suite (`tsx --test`) |
| `dev` / `build` / `start` | Hot reload / compile / run the API + static server |

Data-source licenses and cache locations: [DATASETS.md](DATASETS.md).

## License:
Apache 2.0. See LICENSE for the full license text.

---

## Appendix: previous README (verbatim, for Muse Wonder)

> Everything below is the pre-rewrite README, preserved intact — typos,
> numbering, and all — for a later review pass. Safe to delete after.

# Who Funds It (?)

Many people want to know, when making a purchase, buying a subscription, or reading a medical study, what the primary incentives are behind the service or who are its prime beneficiaries. The best way to understand this information is to see what funding is behind any company, organization or even an educational institution.

This webapp is an interactive global corporate financing map that showcasess the flow and source of money, with bigger graphical representation to places with more funds, e.g., BlackRock. Including banks or hedge-funds to bring out the scale of debt, the sources for this mapping will be stocks, equity, large donations and the like, and AI - Open-Weighted Llama - is used for the processing of the public databases to create a human-intuitive map from the hard data.

## How to run

### Prereqs

- Node.js 20+ and npm
- PostgreSQL 14+ with a `whofundsit` database (with or without docker)

### Demo quickstart (~5 minutes)

1. Clone the repo:
   ```bash
   git clone https://github.com/feeRnt/whofundsit && cd whofundsit
   cp backend/.env.example backend/.env

   # these packages will likely need approval before install
   npm install-scripts approve esbuild @prisma/engines prisma &&\
   npm install
   ```
   2. Start Postgres, e.g.:
### Docker:
   `docker run --name whofundsit-pg -e POSTGRES_PASSWORD=YOUR_PASSWORD -e POSTGRES_DB=whofundsit -p 5432:5432 -d postgres:16`
### No-Docker Postgres
```bash
   # Arch:
   sudo pacman -S postgresql
   # Debian, Ubuntu:
   sudo apt install postgresql
```
- Without sudo:
```bash
   initdb -D $HOME/whofundsit -E UTF8 --auth=trust
   pg_ctl -D $HOME/whofundsit -o "-p 5433 -k /tmp" -l $HOME/whofundsit.log start
   createdb -h /tmp -p 5433 whofundsit
   echo "DATABASE_URL=\"postgresql://$USER@localhost:5433/whofundsit\"" >> backend/.env

   # Make sure the server is started.
   # If port 5433 is already taken (`ss -ltn | grep 5433`),
   # stop the stale server first: `pg_ctl -D $HOME/whofundsit stop`,
   # then start again.
```
- With sudo:
```bash
   sudo -iu postgres initdb -D /var/lib/postgres/data # Arch-Linux only
   sudo systemctl start postgresql
   sudo -iu postgres createuser -s $USER && createdb whofundsit_fresh
   echo "DATABASE_URL="postgresql://$USER@localhost:5432/whofundsit"" >> backend/.env
```

3. Start the demo
```bash
   npm run demo
   # This pushes the schema, loads the committed seed dataset, builds, and
   # serves on one port. No SEC calls, no API keys, and no ingest wait: 
   # the demo dataset ships in the repo.
```
   #### Note: on subsequent runs, you may either run npm demo with
```bash
   DEMO_WIPE_OK=1 npm run demo;

   # or separately start the back and frontends with:
   npm run dev --prefix backend &
   npm run dev --prefix frontend
```

4. Open `http://localhost:4000` in a browser: globe/flat-map toggle, click any
   dot for value, address, and EDGAR evidence links.
   On another device on your LAN? Answer `y` when the demo asks (or preset
   `HOST=0.0.0.0`), then open the `on your LAN:` URL from the startup log instead.

### Maintainer data refresh

```bash
cd backend
npm run bulk            # SEC nightly ZIPs -> base layer (one long run, cached)
npm run ingest:all      # frames top-up + Nominatim geocoding
npm run flows:openalex  # grant arcs (OpenAlex, cached)
npm run flows:13f       # fund arcs (all 13F filers; THIRTEENF_MAX_MANAGERS caps it)
npm run names:sync -- --yes # legal filer names (asks first without --yes)
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
| `coords:populate` | Nominatim geocoding, 1 req/s, biggest first (city/state fallback retry on misses; marks `geoStatus`, `--retry-failed` re-includes failed rows) |
| `deadlines:snapshot` | Copy local `dead-lines.json` into the committed seed for fresh clones |
| `geo:snapshot` | Export address→coords mapping into the committed ODbL seed for fresh clones |
| `ingest:all` | `ingest` + `coords:populate` in one go |
| `pipeline` | Geocode pending entities (≤100/run) + Modal cleanup when configured |
| `flows:openalex` | Grant arcs from OpenAlex funders (`OPENALEX_FUNDER_IDS` list, cursor-paged with key, cached) |
| `flows:13f` | Fund arcs from every 13F-HR filer (core-scaled workers; `THIRTEENF_MAX_MANAGERS` caps it, `THIRTEENF_CONCURRENCY` tunes it, `THIRTEENF_SKIP_STALE=1` drops dead filers; unplaceable funds stub for coords retry) |
| `sync:global` | International companies (Wikidata → GLEIF) + ownership arcs (`GLOBAL_LIMIT`, `GLOBAL_MAX_CHILDREN`) |
| `tickers:global` | Backfill primary tickers on `lei:` rows via ISIN→OpenFIGI (same `GLOBAL_LIMIT` as the sync) |
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
