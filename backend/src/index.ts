import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
    const limit = Math.min(
      Math.max(Number.isFinite(requested) ? requested : 200, 1),
      5000,
    );
    // Skip 0,0 placeholders (ungeocoded rows pile up in the ocean off
    // Africa); the pipeline fills coordinates in fundsVolume order.
    const entities = await prisma.entity.findMany({
      take: limit,
      orderBy: { fundsVolume: "desc" },
      where: { lat: { not: 0 }, lng: { not: 0 } },
    });
    res.json(entities);
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
    const limit = Math.min(
      Math.max(Number.isFinite(requested) ? requested : 500, 1),
      1000,
    );
    const endpoint = { id: true, name: true, lat: true, lng: true };
    const placed = { lat: { not: 0 }, lng: { not: 0 } };
    const flows = await prisma.capitalFlow.findMany({
      take: limit,
      orderBy: { amount: "desc" },
      where: { sourceEntity: placed, targetEntity: placed },
      include: { sourceEntity: { select: endpoint }, targetEntity: { select: endpoint } },
    });
    res.json(flows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load flows" });
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
// LAN opt-in (vite-style `--host`): default is loopback-only, set
// HOST=0.0.0.0 to serve the demo to the local network (firewall permitting).
const host = process.env.HOST ?? "127.0.0.1";

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
