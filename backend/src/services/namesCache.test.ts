import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSkipped,
  partitionChanged,
  saveSkipped,
} from "./namesCache.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "names-cache-"));
  return path.join(dir, "sub", "names-sync.json");
}

describe("namesCache", () => {
  it("loads {} when the cache file is missing or corrupt", () => {
    const f = tmpFile();
    assert.deepEqual(loadSkipped(f), {});
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "not json{");
    assert.deepEqual(loadSkipped(f), {});
  });

  it("round-trips skipped decisions through save/load", () => {
    const f = tmpFile();
    saveSkipped(f, {
      123: { old: "OLD CO", want: "Old Co Inc", at: "2026-11-04T00:00:00Z" },
    });
    assert.deepEqual(loadSkipped(f), {
      123: { old: "OLD CO", want: "Old Co Inc", at: "2026-11-04T00:00:00Z" },
    });
  });

  it("partitions changed into fresh, revisit, and stale", () => {
    const changed = new Map([
      [1, "One Inc"],
      [2, "Two Inc"],
    ]);
    const current = new Map([
      [1, "ONE"],
      [2, "TWO"],
    ]);
    const skipped = {
      2: { old: "TWO", want: "Two Inc", at: "t" },
      9: { old: "NINE", want: "Nine Inc", at: "t" },
    };
    const { fresh, revisit, stale } = partitionChanged(changed, current, skipped);
    assert.deepEqual([...fresh.entries()], [[1, "One Inc"]]);
    assert.deepEqual(revisit, [{ cik: 2, old: "TWO", want: "Two Inc" }]);
    assert.deepEqual(stale, ["9"]);
  });
});
