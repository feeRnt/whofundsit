# Who Funds It (?)

Many people want to know, when making a purchase, buying a subscription, or reading a medical study, what the primary incentives are behind the service or who are its prime beneficiaries. The best way to understand this information is to see what funding is behind any company, organization or even an educational institution.

This webapp is an interactive global corporate financing map that showcases and elucidates the flow and source of money, with bigger graphical representation to places with more funds, e.g., BlackRock. While also including banks to bring out the scale of debt, the sources for this mapping will be stocks, equity, large donations and the like, and AI - Open-Weighted Llama - is used for the processing of the public databases to create a human-intuitive map from the hard data.

## How to run

### Prereqs

- Node.js 20+ and npm
- PostgreSQL 14+ reachable locally (easiest: `docker run --name whofundsit-pg -e POSTGRES_PASSWORD=YOUR_PASSWORD -e POSTGRES_DB=whofundsit -p 5432:5432 -d postgres:16`)

### Judge quickstart (one command, ~2 minutes)

1. `cp backend/.env.example backend/.env` and set `DATABASE_URL` to your Postgres.
2. From `whofundsit/`: `npm run demo` — pushes the schema, loads the committed
   seed dataset, builds, and serves on one port.
3. Open `http://localhost:4000` in a browser: globe/flat-map toggle, click any
   dot for value, address, and EDGAR evidence links.

No SEC calls, no API keys, and no ingest wait: the demo dataset ships in the repo.

### Maintainer data refresh

1. `cd backend && npm run db:push && npm run ingest:all` (full ingest, ~15 min).
2. `npm run db:export` to snapshot the tables into `prisma/seed-data/`.
3. Commit the updated seed files.

## License:
Apache 2.0. See LICENSE for the full license text.