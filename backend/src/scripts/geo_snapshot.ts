import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Maintainer tool: `npm run geo:snapshot` exports the business-address →
// coords mapping (the coords pipeline's output) into the committed seed
// src/data/geo-mapping.json, preloaded by fresh clones as a geocode cache.
// Commit the seed afterwards.
//
// License: coordinates © OpenStreetMap contributors (ODbL 1.0) —
// share-alike applies to this file; addresses are SEC (public domain) /
// GLEIF (CC0). See DATASETS.md.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}
const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.join(here, "..", "data", "geo-mapping.json");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
try {
  const rows = await prisma.entity.findMany({
    where: { NOT: [{ lat: 0, lng: 0 }] },
    select: { businessAddress: true, rawAddressText: true, lat: true, lng: true },
  });
  const mapping: Record<string, { lat: number; lng: number }> = {};
  for (const r of rows) {
    const key = r.businessAddress ?? r.rawAddressText;
    if (!key || mapping[key]) {
      continue;
    }
    mapping[key] = { lat: r.lat, lng: r.lng };
  }
  fs.writeFileSync(
    seedFile,
    JSON.stringify(
      {
        _license: "ODbL 1.0 (coordinates); addresses SEC-PD / GLEIF-CC0",
        _attribution: "© OpenStreetMap contributors",
        generatedAt: new Date().toISOString(),
        count: Object.keys(mapping).length,
        mapping,
      },
      null,
      2,
    ),
  );
  console.log({ addresses: Object.keys(mapping).length, seedFile });
} finally {
  await prisma.$disconnect();
}
