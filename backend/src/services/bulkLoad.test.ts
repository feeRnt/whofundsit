import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonEntries } from "./bulkLoad.js";

// Fixture lives next to this file (committed); runners against dist must
// copy __fixtures__ alongside the compiled test.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "__fixtures__", "mixed.zip");

describe("jsonEntries", () => {
  it("streams every json entry in order, skipping junk", async () => {
    const seen: [string, unknown][] = [];
    for await (const { name, json } of jsonEntries(FIXTURE)) {
      seen.push([name, json]);
    }
    assert.deepEqual(
      seen.map(([n]) => n),
      ["a.json", "dir/b.json", "big.json"],
    );
    assert.deepEqual(seen[0][1], { x: 1 });
    // The 512 KiB entry spans many stream chunks: multi-chunk entries must
    // arrive whole (the old pause-on-header design starved them and hung).
    assert.equal((seen[2][1] as { data: string }).data.length, 524288);
  });

  it("supports early exit", async () => {
    let n = 0;
    for await (const _entry of jsonEntries(FIXTURE)) {
      n += 1;
      break;
    }
    assert.equal(n, 1);
  });
});
