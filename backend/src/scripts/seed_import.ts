import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { renderSeedProgress, wipeRefusal } from "../services/seedGuard.js";

// Judge path: `npm run db:seed` wipes the demo tables and reloads them from the
// committed seed files. Requires `npm run db:push` first (the `demo` script
// chains all three). Fails loudly when the seed files are absent, and refuses
// a non-empty database without DEMO_WIPE_OK=1 (see seedGuard).
const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(here, "..", "..", "prisma", "seed-data");

function loadSeed(name: string): Record<string, unknown>[] {
  const file = path.join(SEED_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `missing ${file} — maintainers create it with npm run db:export`,
    );
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} is not a JSON array`);
  }
  return parsed as Record<string, unknown>[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

async function insertBatched<T>(
  label: string,
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  batchSize = 1000,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  for (let i = 0; i < rows.length; i += batchSize) {
    await insert(rows.slice(i, i + batchSize));
    const done = Math.min(i + batchSize, rows.length);
    process.stdout.write(`\r${renderSeedProgress(label, done, rows.length)}`);
  }
  process.stdout.write("\n");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see backend/.env)");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const entities: Prisma.EntityCreateManyInput[] = loadSeed("entities.json").map(
    (r) => ({
      id: String(r.id),
      name: String(r.name),
      type: String(r.type),
      lat: Number(r.lat),
      lng: Number(r.lng),
      fundsVolume: Number(r.fundsVolume),
      rawAddressText: String(r.rawAddressText),
      businessAddress: asString(r.businessAddress),
      conceptTag: asString(r.conceptTag),
      tickers: asStringArray(r.tickers),
      secFilingNumber: asString(r.secFilingNumber),
      sourceTimeFrame: asString(r.sourceTimeFrame),
      financialDate: r.financialDate ? new Date(String(r.financialDate)) : null,
      source: asString(r.source) ?? "frames-api",
      form: asString(r.form),
      filed: r.filed ? new Date(String(r.filed)) : null,
      exchanges: asStringArray(r.exchanges),
      category: asString(r.category),
      formerNames: asStringArray(r.formerNames),
      mergedFrom: r.mergedFrom as Prisma.InputJsonValue | undefined,
      currency: asString(r.currency) ?? "USD",
      industry: asString(r.industry),
      geoStatus:
        Number(r.lat) !== 0 || Number(r.lng) !== 0
          ? "placed"
          : ["pending", "placed", "failed"].includes(String(r.geoStatus))
            ? String(r.geoStatus)
            : "pending",
    }),
  );
  const flows: Prisma.CapitalFlowCreateManyInput[] = loadSeed("flows.json").map(
    (r) => ({
      id: String(r.id),
      sourceEntityId: String(r.sourceEntityId),
      targetEntityId: String(r.targetEntityId),
      amount: Number(r.amount),
      flowType: String(r.flowType),
      sleeves: Number(r.sleeves) || 1,
    }),
  );

  // Sequential: concurrent queries on one pg client trip a deprecation
  // warning (and break in pg 9).
  const entityCount = await prisma.entity.count();
  const flowCount = await prisma.capitalFlow.count();
  const refusal = wipeRefusal(
    entityCount,
    flowCount,
    process.env.DEMO_WIPE_OK,
  );
  if (refusal) {
    throw new Error(refusal);
  }
  await prisma.capitalFlow.deleteMany();
  await prisma.entity.deleteMany();
  // Chunked inserts so the progress bar can advance (single-shot createMany
  // sits silent for minutes on the full seed).
  await insertBatched("entities", entities, (batch) =>
    prisma.entity.createMany({ data: batch }),
  );
  await insertBatched("flows", flows, (batch) =>
    prisma.capitalFlow.createMany({ data: batch }),
  );
  console.log({ entities: entities.length, flows: flows.length });
} finally {
  await prisma.$disconnect();
}
