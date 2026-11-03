import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  amountScore,
  appendHistory,
  diagnosisPrompt,
  isMajorIndex,
  makeRng,
  mulberry32,
  cellTake,
  parseEntityRef,
  parseFlowRef,
  ownershipStructural,
  regionBucket,
  sampleIndices,
  summarize,
  toHistoryEntry,
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

describe("ownershipStructural", () => {
  it("passes a well-formed global id with an undisclosed (0) stake", () => {
    const r = ownershipStructural("global:AAA:BBB", 0);
    assert.equal(r.score, 100);
    assert.deepEqual(r.flags, []);
  });

  it("fails malformed ids and non-finite amounts", () => {
    assert.equal(ownershipStructural("global:AAA", 0).score, 0);
    assert.equal(ownershipStructural("13f:123:456", 10).score, 0);
    assert.equal(ownershipStructural("global:AAA:BBB", NaN).score, 0);
  });
});

describe("makeRng", () => {
  it("rolls fresh [0,1) values every call by default", () => {
    const rng = makeRng();
    const vals = Array.from({ length: 50 }, () => rng());
    assert.ok(vals.every((v) => v >= 0 && v < 1));
    assert.ok(new Set(vals).size > 1); // a stuck RNG fails here
  });
});

describe("diagnosisPrompt", () => {
  it("carries the flag and the use-only-given-facts guardrail", () => {
    const p = diagnosisPrompt("stored 1 vs live 2 (score 40)", "source=sec");
    assert.ok(p.includes("stored 1 vs live 2 (score 40)"));
    assert.ok(p.includes("source=sec"));
    assert.ok(p.includes("Use ONLY the facts above"));
    assert.ok(p.includes("Do NOT invent live values"));
  });
});

describe("summarize diagnoses", () => {
  it("attaches diagnoses, defaulting to none", () => {
    const bare = summarize("c", "entity", [{ score: 100, flags: [] }]);
    assert.deepEqual(bare.diagnoses, []);
    const d = [{ flag: "f", diagnosis: "because" }];
    const full = summarize("c", "entity", [{ score: 40, flags: ["f"] }], {
      diagnoses: d,
    });
    assert.deepEqual(full.diagnoses, d);
    assert.deepEqual(full.flags, ["f"]);
  });
});

describe("history", () => {
  it("slims a report and trims oldest beyond the cap", () => {
    const cell = summarize("source=sec", "entity", [
      { score: 100, flags: [] },
      { score: null, flags: ["no live series"] },
    ]);
    const entry = toHistoryEntry({
      generatedAt: "2026-11-02T00:00:00.000Z",
      seed: null,
      cells: [cell],
      overall: cell,
    });
    assert.equal(entry.cells.length, 1);
    assert.equal(entry.cells[0].tested, 1);
    assert.ok(!("flags" in entry.cells[0]));
    const e2 = { ...entry, generatedAt: "2026-11-03T00:00:00.000Z" };
    const trimmed = appendHistory([entry, e2], e2, 2);
    assert.equal(trimmed.length, 2);
    assert.equal(trimmed[0].generatedAt, "2026-11-03T00:00:00.000Z");
  });
});
