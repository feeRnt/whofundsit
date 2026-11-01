import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  amountScore,
  isMajorIndex,
  mulberry32,
  cellTake,
  parseEntityRef,
  parseFlowRef,
  regionBucket,
  sampleIndices,
  summarize,
} from "./claimsVerify.js";

describe("mulberry32 + sampleIndices", () => {
  it("is deterministic per seed and stays in bounds", () => {
    const a = sampleIndices(100, 25, mulberry32(7));
    const b = sampleIndices(25, 25, mulberry32(7));
    const c = sampleIndices(100, 25, mulberry32(8));
    assert.equal(a.length, 25);
    assert.equal(new Set(a).size, 25);
    assert.ok(a.every((i) => i >= 0 && i < 100));
    assert.deepEqual(a, sampleIndices(100, 25, mulberry32(7)));
    assert.notDeepEqual(a, c);
    assert.equal(b.length, 25); // full-population sample still works
  });
});

describe("amountScore", () => {
  it("bands relative error into 100/90/70/40/0", () => {
    assert.equal(amountScore(100, 100.5), 100);
    assert.equal(amountScore(100, 103), 90);
    assert.equal(amountScore(100, 120), 70);
    assert.equal(amountScore(100, 150), 40);
    assert.equal(amountScore(300, 100), 0);
    assert.equal(amountScore(0, 0), 100);
    assert.equal(amountScore(0, 100), 0);
  });
});

describe("parseEntityRef + parseFlowRef", () => {
  it("recovers CIKs, tags, and CUSIPs from ids", () => {
    assert.deepEqual(parseEntityRef("12345:Assets"), { cik: "12345", tag: "Assets" });
    assert.equal(parseEntityRef("lei:ABC"), null);
    assert.deepEqual(parseFlowRef("13f:12345:ABC123456"), {
      cik10: "0000012345",
      cusip: "ABC123456",
    });
    assert.equal(parseFlowRef("grant:whatever"), null);
  });
});

describe("regionBucket", () => {
  it("sorts US, foreign, and placeless rows", () => {
    assert.equal(regionBucket("US-CA", null), "us");
    assert.equal(regionBucket("—", "1 Main St, Austin, TX 78701"), "us");
    assert.equal(regionBucket("London E1", "1 Bishopsgate, London"), "non-us");
    assert.equal(regionBucket("—", null), "unknown");
  });
});

describe("isMajorIndex", () => {
  it("reports n/a, not 0%, for cells with nothing testable", () => {
    const empty = summarize("region=xx", "entity", []);
    assert.equal(empty.pctVerified, null);
    assert.equal(empty.mean, null);
    const full = summarize("region=us", "entity", [
      { score: 100, flags: [] },
      { score: null, flags: ["no live series"] },
    ]);
    assert.equal(full.pctVerified, 100);
    assert.equal(full.tested, 1);
    assert.equal(full.untestable, 1);
  });

  it("takes ~10% per cell with a cap, census of singletons", () => {
    assert.equal(cellTake(0), 0);
    assert.equal(cellTake(1), 1);
    assert.equal(cellTake(5), 1);
    assert.equal(cellTake(500), 5);
    assert.ok(cellTake(100) <= 30 && cellTake(100) >= 1);
  });

  it("spots S&P/Nasdaq members by ticker", () => {
    assert.equal(isMajorIndex(["AAPL", "ZZZ"]), true);
    assert.equal(isMajorIndex(["ZZZNOTREAL"]), false);
    assert.equal(isMajorIndex([]), false);
  });
});
