import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Maintainer tool: `npm run db:export` snapshots the populated tables into
// committed JSON seed files. Run this on a good database, then commit the
// seed-data/ directory so judges never need SEC access or ingest runs.
const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(here, "..", "..", "prisma", "seed-data");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const entities = await prisma.entity.findMany({ orderBy: { id: "asc" } });
  const flows = await prisma.capitalFlow.findMany({ orderBy: { id: "asc" } });
  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SEED_DIR, "entities.json"),
    JSON.stringify(entities, null, 2),
  );
  fs.writeFileSync(
    path.join(SEED_DIR, "flows.json"),
    JSON.stringify(flows, null, 2),
  );
  console.log({
    entities: entities.length,
    flows: flows.length,
    dir: SEED_DIR,
  });
} finally {
  await prisma.$disconnect();
}
