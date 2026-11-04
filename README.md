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

1. Clone the repo (shallow, to save on space; any shell — on Windows
   `cmd.exe` run the npm lines one at a time, it has no `\` continuation):
   ```bash
   git clone --depth=1 https://github.com/feeRnt/whofundsit && cd whofundsit
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

LLM repair loop for ungeocoded rows (needs the Modal server deployed:
`modal deploy backend/formalize_worker.py`, then smoke-test it):
```bash
npm run formalize:addresses -- --pass=1   # Glimmer-30B parses DB failures -> llm-pass-1.json
npm run coords:populate -- --llm-1        # Census + structured Nominatim, marks outcomes
npm run formalize:addresses -- --pass=2   # retry prior misses (add --limit=K to cap)
npm run coords:populate -- --llm-2        # ... and so on
```

## Hosting (Neon Postgres + Vercel frontend)

Split-origin: the frontend goes on Vercel, the database on Neon, and the
Express backend on any Node host (Render/Railway/Fly/VPS). Same-origin
`Dockerfile`/compose path stays in [DEPLOY.md](DEPLOY.md). No Docker
needed for this path: Neon replaces the local-Postgres step, and the
backend hosts above take either the image or plain `npm start`.

1. `npm run db:export`, commit the seeds.
2. Create the Neon database and copy its URL **verbatim** (it carries
   `?sslmode=require`). Point local `DATABASE_URL` at it just for the
   seed step, then run `db:push` + `db:seed` once from your laptop.
3. Deploy the backend — `Dockerfile` image or `npm start` — on a
   container/process host (Render/Railway/Fly/VPS; Vercel can't run a
   persistent Express server, it hosts only the frontend). Give it
   `DATABASE_URL` (Neon URL), `PORT`, and the existing server-side env
   (`MODAL_*`, user-agent ids — never `VITE_*`).
4. On Vercel: Root Directory `frontend`, build `npm run build`, env
   `VITE_API_URL=https://<backend-host>` — baked in at build time, so
   rebuild after changing it. No rewrites needed: the app is one page.
5. Open the Vercel URL and check dots, arcs, popups, and the verification
   badge; the disclaimer covers backend cold starts.

Then commit the updated seed files. Report suspected duplicates with
`npm run dedupe:report`; fold approved ones with
`npm run merge -- <keepId> <dropId>` (provenance is kept on the survivor).

## Scripts reference

All npm scripts and what they do live in [NPM_SCRIPTS.md](NPM_SCRIPTS.md).
Data-source licenses and cache locations: [DATASETS.md](DATASETS.md).

## License & credits
Apache 2.0. See LICENSE for the full license text.

All data is courtesy of and thanks to: SEC EDGAR, Wikidata, GLEIF, OpenFIGI, OpenStreetMap contributors (Nominatim), the US Census Bureau, OpenAlex, Yahoo Finance, XBRL International (ESEF), the Taiwan Stock Exchange, and Wikipedia (index snapshots). Please check the licenses/copyright of the presented data in LICENSE and [DATASETS.md](DATASETS.md).

They're the real heroes <3
