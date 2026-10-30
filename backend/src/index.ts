import "dotenv/config";
import fs from "node:fs";
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
      1000,
    );
    const entities = await prisma.entity.findMany({
      take: limit,
      orderBy: { fundsVolume: "desc" },
    });
    res.json(entities);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load entities" });
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
app.listen(port, () => {
  console.log(`backend listening on ${port}`);
});
