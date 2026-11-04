# Deploying WhoFundsIt for judges

One service + one database. The backend serves the built frontend itself
(`frontend/dist`), so there is no CORS or `VITE_API_URL` to configure on a
same-origin deploy.

## 0. Freeze the data

```sh
npm --prefix backend run db:export   # refresh seed files from the live DB
git add backend/prisma/seed-data && git commit -m "seed: ..."
```

The committed seeds are the deploy artifact — no database dump to upload.

## 1. Provision Postgres

Railway plugin, Supabase, Neon, or the `db` service in
[docker-compose.yml](docker-compose.yml). Roughly a few hundred MB with
indexes; check free-tier caps before demo day.

## 2. Deploy the backend (only service)

Managed (Railway/Render/Fly): point at the repo, it finds the
[Dockerfile](Dockerfile). VPS: `docker compose up --build` (seeds separately
below). Env vars:

| Var | Value |
| --- | ----- |
| `DATABASE_URL` | hosted Postgres URL |
| `PORT` | host-assigned (4000 local) |
| `MODAL_FORMALIZE_URL` etc. | unchanged, server-side only |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | unchanged, server-side only |

Nothing with a `VITE_` prefix may hold secrets — those bake into the
browser bundle. Same-origin needs no `VITE_API_URL` at all.

## 3. Seed once (from your laptop, against the hosted DB)

```sh
DATABASE_URL=<hosted> npm --prefix backend run db:push
DATABASE_URL=<hosted> npm --prefix backend run db:seed
```

Takes minutes for ~115k flows. One-time — never on boot.

## 4. Verify

Open the URL: map loads, dots/arcs render, popups open, verification
badge shows. If the map is empty, the seed step didn't run (the API
returns `[]`, never an error page).

## Gotchas

- Free backends sleep: first judge click can take ~1 min to wake. A $5–7
  tier (or the compose stack on a cheap VPS) stays warm.
- Rebuild the frontend after changing any `VITE_*` value (frozen at build).
- The Modal GPU server stays where it is — the site only reads the DB
  (plus live price quotes). Formalize/verify are re-run tools, not
  serving dependencies.
