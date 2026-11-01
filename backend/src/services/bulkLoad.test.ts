import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSic, jsonEntries, locationTag } from "./bulkLoad.js";

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

describe("locationTag", () => {
  it("tags real US states, never SEC country codes", () => {
    assert.equal(locationTag("CT", "100 MAIN ST, GREENWICH, CT, 06830"), "US-CT");
    assert.equal(
      locationTag("X0", "ONE COLEMAN STREET, LONDON, X0, EC2R 5AA"),
      "LONDON, EC2R 5AA",
    );
  });

  it("falls back to the trailing city + postcode without a state", () => {
    assert.equal(
      locationTag(null, "AERCAP HOUSE, 65 ST. STEPHEN'S GREEN, DUBLIN, D02 YX20"),
      "DUBLIN, D02 YX20",
    );
  });

  it("em-dashes only when there is no address at all", () => {
    assert.equal(locationTag(null, null), "—");
    assert.equal(locationTag(null, undefined), "—");
    assert.equal(locationTag("X0", null), "—");
  });
});

describe("extractSic", () => {
  it("prefers the description, falls back to the code", () => {
    assert.equal(
      extractSic({ sic: "1000", sicDescription: "Metal Mining" }),
      "Metal Mining",
    );
    assert.equal(extractSic({ sic: "1000" }), "1000");
    assert.equal(extractSic({}), null);
    assert.equal(extractSic({ sicDescription: "" }), null);
  });
});
