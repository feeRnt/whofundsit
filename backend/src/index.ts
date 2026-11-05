import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  FLOW_TYPES,
  allocateFlowQuotas,
  allocateRegionQuotas,
  type FlowType,
} from "./services/regionQuotas.js";
import { getQuote } from "./services/stockQuote.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const app = express();
app.use(express.json());

// CORS for split dev (Vite :5173 -> API :4000). Same-origin deploys don't need it.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Read-only, capped list for the map. Largest funds first.
app.get("/api/entities", async (req, res) => {
  try {
    const requested = Number(req.query.limit ?? 200);
    // 500k ceiling (effectively the whole dataset): deck.gl renders it,
    // but the full JSON payload (tens of MB) is wifi-only territory.
    const limit = Math.min(
      Math.max(Number.isFinite(requested) ? requested : 200, 1),
      500000,
    );
    // Skip 0,0 placeholders (ungeocoded rows pile up in the ocean off
    // Africa); the pipeline fills coordinates in fundsVolume order.
    // Share-count rows stay out: count units would top every volume sort
    // and quota floor. The popup fetches them lazily via /api/shares.
    // Equal per-region floors (shortfall to Europe) so international rows
    // survive the volume sort instead of being buried under SEC giants, plus
    // a university carve-out (works counts can't contest dollar volumes).
    const placed = await prisma.entity.findMany({
      where: {
        lat: { not: 0 },
        lng: { not: 0 },
        // OR keeps NULL-concept rows (global/openalex/13f): plain `not`
        // would drop them via three-valued logic.
        OR: [
          { conceptTag: null },
          { conceptTag: { not: "EntityCommonStockSharesOutstanding" } },
        ],
      },
    });
    res.json(allocateRegionQuotas(placed, limit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load entities" });
  }
});

// Grant arcs for the map: flows whose endpoints both have real coordinates.
// Largest first; capped like entities.
app.get("/api/flows", async (req, res) => {
  try {
    const requested = Number(req.query.limit ?? 500);
    // 500k ceiling (effectively every flow): the arcs slider can request
    // all of them, but the full payload (tens of MB) is wifi-only territory.
    const limit = Math.min(
      Math.max(Number.isFinite(requested) ? requested : 500, 1),
      500000,
    );
    const endpoint = { id: true, name: true, lat: true, lng: true };
    const placed = { lat: { not: 0 }, lng: { not: 0 } };
    // Per-type quotas: one amount-desc take would fill the whole cap with
    // 13F dollars and starve grants + ownership (empty submenus). Amounts
    // stay desc within each type; the total never exceeds the limit.
    const counts = Object.fromEntries(
      await Promise.all(
        FLOW_TYPES.map(async (flowType) => [
          flowType,
          await prisma.capitalFlow.count({
            where: { flowType, sourceEntity: placed, targetEntity: placed },
          }),
        ]),
      ),
    ) as Record<FlowType, number>;
    const quotas = allocateFlowQuotas(counts, limit);
    const perType = await Promise.all(
      FLOW_TYPES.map((flowType) =>
        quotas[flowType] === 0
          ? []
          : prisma.capitalFlow.findMany({
              take: quotas[flowType],
              orderBy: { amount: "desc" },
              where: { flowType, sourceEntity: placed, targetEntity: placed },
              include: {
                sourceEntity: { select: endpoint },
                targetEntity: { select: endpoint },
              },
            }),
      ),
    );
    res.json(perType.flat());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load flows" });
  }
});

// Day-change quote for the popup (Yahoo chart, 24h cache). 404 means
// "no quote" and the popup hides the row — never an error to the user.
app.get("/api/quote", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "");
    const quote = await getQuote(ticker);
    if (!quote) {
      res.status(404).json({ quote: null });
      return;
    }
    res.json({ ticker: ticker.toUpperCase(), ...quote });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load quote" });
  }
});

// Outstanding shares for one CIK (10-K cover row): the popup's true-%
// ownership denominator (market cap = shares × Yahoo price). 404 means
// "no count" and the ring falls back to tracked-relative mode.
app.get("/api/shares", async (req, res) => {
  try {
    const raw = String(req.query.cik ?? "");
    if (!/^\d+$/.test(raw)) {
      res.status(404).json({ shares: null });
      return;
    }
    const row = await prisma.entity.findFirst({
      where: {
        id: `${Number(raw)}:EntityCommonStockSharesOutstanding`,
      },
      select: { fundsVolume: true, financialDate: true },
    });
    if (!row || !Number.isFinite(row.fundsVolume) || row.fundsVolume <= 0) {
      res.status(404).json({ shares: null });
      return;
    }
    res.json({ cik: Number(raw), shares: row.fundsVolume, date: row.financialDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load shares" });
  }
});

// Methodology-audit snapshot for trust badges: committed seed wins (judge
// path), local verify output is the fallback. 404 means "no audit yet"
// and the UI hides badges — never an error to the user.
app.get("/api/verification", (_req, res) => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", "..", "prisma", "seed-data", "verification.json"),
      path.join(here, "..", "..", "data", "verification-report.json"),
    ];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) {
      res.status(404).json({ verification: null });
      return;
    }
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load verification" });
  }
});

// Same-origin deploy: serve the built frontend from this same port so every
// visitor just opens one URL. Requires `npm --prefix ../frontend run build`;
// skipped silently when no build exists (pure API dev mode).
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.join(here, "..", "..", "frontend", "dist");
if (fs.existsSync(path.join(frontendDist, "index.html"))) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 4000);
// LAN opt-in (vite-style `--host`): HOST=0.0.0.0 serves the local network,
// otherwise the demo asks on a terminal, defaulting to loopback-only
// (pipes and CI never block on the question).
async function resolveHost(): Promise<string> {
  if (process.env.HOST) {
    return process.env.HOST;
  }
  // Backend dev is always loopback: tsx watch owns stdin, so prompting
  // here hangs with no way to answer. (Split-dev LAN still works — run
  // vite with --host; it proxies /api to this localhost server.)
  if (process.env.npm_lifecycle_event === "dev") {
    return "127.0.0.1";
  }
  // Hosted production (Docker/Render: NODE_ENV=production, no TTY, no
  // HOST): bind all interfaces, or the platform's port scan never finds us.
  if (process.env.NODE_ENV === "production") {
    return "0.0.0.0";
  }
  if (!process.stdin.isTTY) {
    return "127.0.0.1";
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Serve on LAN too (share with your network)? [y/N] ", resolve);
  });
  rl.close();
  return answer.trim().toLowerCase().startsWith("y")
    ? "0.0.0.0"
    : "127.0.0.1";
}
const host = await resolveHost();

function lanIpv4Addrs(): string[] {
  // Never throws: a lookup failure must not crash the server.
  let ifaces: Record<string, os.NetworkInterfaceInfo[] | undefined>;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const nets of Object.values(ifaces)) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        out.push(net.address);
      }
    }
  }
  return out;
}

app.listen(port, host, () => {
  console.log(`backend listening on ${host}:${port}`);
  console.log(`open your browser at http://localhost:${port}`);
  if (host === "0.0.0.0") {
    const lan = lanIpv4Addrs();
    if (lan.length > 0) {
      for (const ip of lan) {
        console.log(`on your LAN: http://${ip}:${port}`);
      }
    } else {
      console.log("on your LAN: address lookup failed — use this machine's IP");
    }
  }
});
