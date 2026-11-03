import "dotenv/config";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  formalizeAddresses,
  formalizeAddressesBatched,
  formalizePrompt,
  formalizeRetryPrompt,
} from "../services/addressFormalize.js";
import { readPassFile, toPassRows, writePassFile } from "../services/llmPass.js";

// LLM repair passes (GPU side; the geocode side is coords:populate --llm-N).
//
// Queue mode: `npm run formalize:addresses -- --pass=N [--limit=K]`
//   pass 1 reads failed unplaced entities from the DB; pass N>1 reads the
//   unsuccessful rows of llm-pass-(N-1).json (successes stay put, never
//   re-sent). Prompts go out in GPU-sized chunks; rows land in
//   data/cache/geo/llm-pass-N.json as status pending for --llm-N.
// Legacy mode: file (one address per line) or stdin -> JSON Lines on
// stdout. Writes nothing else.
//   npx tsx src/scripts/formalize_addresses.ts addresses.txt > out.jsonl
const args = process.argv.slice(2);
const passArg = args.find((a) => /^--pass=\d+$/.test(a));
if (!passArg) {
  const file = args.find((a) => !a.startsWith("--"));
  const input = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  const texts = input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const results = await formalizeAddresses(texts);
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
  const failed = results.filter((r) => r.failureCause !== null).length;
  console.error(`[formalize] ${results.length} addresses, ${failed} with failureCause`);
  process.exit(0);
}

const pass = Number(passArg.slice("--pass=".length));
if (!Number.isInteger(pass) || pass < 1) {
  throw new Error("--pass=N needs a positive integer");
}
const limitArg = args.find((a) => /^--limit=\d+$/.test(a));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

interface Input {
  id: string;
  name: string;
  original: string;
  text: string; // prompt actually sent (first-pass or retry)
}
let inputs: Input[];
if (pass === 1) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see backend/.env)");
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const rows = await prisma.entity.findMany({
      where: { lat: 0, lng: 0, geoStatus: "failed" },
      select: { id: true, name: true, businessAddress: true, rawAddressText: true },
      orderBy: [{ fundsVolume: "desc" }, { id: "asc" }],
      ...(limit !== null ? { take: limit } : {}),
    });
    inputs = rows.map((r) => {
      const original = r.businessAddress ?? r.rawAddressText;
      return { id: r.id, name: r.name, original, text: formalizePrompt(original) };
    });
  } finally {
    await prisma.$disconnect();
  }
} else {
  const prev = readPassFile(pass - 1).filter((r) => r.status !== "success");
  const capped = limit !== null ? prev.slice(0, limit) : prev;
  if (capped.length === 0) {
    console.log(`[formalize] pass ${pass}: nothing unsuccessful in pass ${pass - 1}`);
    process.exit(0);
  }
  inputs = capped.map((r) => ({
    id: r.id,
    name: r.name,
    original: r.original,
    text: formalizeRetryPrompt(r.original, r.triedText, r.failureCause, pass),
  }));
}
console.log(`[formalize] pass ${pass}: ${inputs.length} addresses queued`);
const results = await formalizeAddressesBatched(inputs.map((i) => i.text));
const rows = toPassRows(inputs, results, pass);
writePassFile(pass, rows);
const parsed = rows.filter((r) => !r.failureCause).length;
console.log(
  `[formalize] pass ${pass}: ${rows.length} rows -> llm-pass-${pass}.json (${parsed} parsed, ${rows.length - parsed} llm-failed)`,
);
