import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  formalizeAddresses,
  formalizeAddressesBatched,
  formalizePrompt,
  formalizeRetryPrompt,
  parseFormalizeResponse,
} from "./addressFormalize.js";

describe("parseFormalizeResponse", () => {
  it("parses fenced JSON and clamps confidence", () => {
    const r = parseFormalizeResponse(
      '```json\n{"houseNumber":"600","street":"Grant St","city":"Pittsburgh","stateOrRegion":"PA","postalCode":"15219","country":"United States","countryCode":"us","confidence":1.7,"notes":"suite dropped","failureCause":null}\n```',
      "600 GRANT ST, PITTSBURGH, PA 15219",
    );
    assert.equal(r.address.city, "Pittsburgh");
    assert.equal(r.address.countryCode, "US");
    assert.equal(r.confidence, 1);
    assert.equal(r.failureCause, null);
    assert.match(r.notes, /suite/);
  });

  it("keeps the model failure cause and notes", () => {
    const r = parseFormalizeResponse(
      { houseNumber: null, street: null, city: null, stateOrRegion: null, postalCode: null, country: null, countryCode: null, confidence: 0.1, notes: "PO Box has no street range", failureCause: "po-box" },
      "PO BOX 123, WILMINGTON, DE 19801",
    );
    assert.equal(r.failureCause, "po-box");
    assert.match(r.notes, /PO Box/);
  });

  it("turns garbage output into llm-unparsable-output", () => {
    const r = parseFormalizeResponse("not json at all", "X");
    assert.equal(r.failureCause, "llm-unparsable-output");
    assert.equal(r.address.city, null);
  });
});

describe("formalizeAddresses", () => {
  it("keeps order and isolates a failed call", async () => {
    const call = async (text: string) => {
      if (text === "BAD") {
        throw new Error("modal down");
      }
      return { city: "Pittsburgh", confidence: 0.9, notes: "", failureCause: null };
    };
    const out = await formalizeAddresses(["A", "BAD", "C"], call, 0);
    assert.equal(out.length, 3);
    assert.equal(out[0]?.address.city, "Pittsburgh");
    assert.equal(out[1]?.failureCause, "llm-call-failed");
    assert.equal(out[2]?.original, "C");
  });

  it("prompt demands notes and a failure cause", () => {
    assert.match(formalizePrompt("X"), /failureCause/);
    assert.match(formalizePrompt("X"), /never invent/);
  });
});

describe("formalizeRetryPrompt", () => {
  it("names Nominatim and carries the failed attempt", () => {
    const p = formalizeRetryPrompt("ORIG", "TRIED LINE", "po-box", 2);
    assert.match(p, /Attempt 2/);
    assert.match(p, /Nominatim/);
    assert.match(p, /TRIED LINE/);
    assert.match(p, /po-box/);
    assert.match(p, /ORIG/);
  });
});

describe("chunk + formalizeAddressesBatched", () => {
  it("chunks evenly with a short tail", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 24), []);
  });

  it("batches calls and isolates a failed chunk", async () => {
    const seen: string[][] = [];
    const call = async (texts: string[]) => {
      seen.push(texts);
      if (texts.includes("BAD")) {
        throw new Error("gpu busy");
      }
      return texts.map(() => ({ city: "X", confidence: 1, notes: "", failureCause: null }));
    };
    const out = await formalizeAddressesBatched(["a", "BAD", "c"], call, 2);
    assert.equal(seen.length, 2);
    assert.equal(out[0]?.failureCause, "llm-call-failed");
    assert.equal(out[1]?.failureCause, "llm-call-failed");
    assert.equal(out[2]?.address.city, "X");
  });
});
