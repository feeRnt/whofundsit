import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fresh clones failed `npm run demo` with
// "SyntaxError: ... '@prisma/client' does not provide an export named
// 'PrismaClient'" because the chain never ran `prisma generate`.
const here = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(here, "..", "..", "..", "package.json"), "utf8"),
);
const backendPkg = JSON.parse(
  fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"),
);

describe("demo chain", () => {
  it("generates the Prisma client before seeding", () => {
    assert.equal(backendPkg.scripts["db:generate"], "prisma generate");
    const steps = rootPkg.scripts.demo.split("&&").map((s: string) => s.trim());
    const gen = steps.findIndex((s: string) => s.endsWith("run db:generate"));
    const seed = steps.findIndex((s: string) => s.endsWith("run db:seed"));
    assert.ok(gen !== -1, "demo must run db:generate");
    assert.ok(seed !== -1, "demo must run db:seed");
    assert.ok(gen < seed, "db:generate must precede db:seed");
  });
});
