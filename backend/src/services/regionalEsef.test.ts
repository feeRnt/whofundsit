import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEsefFacts, pickLatestJsonUrl } from "./regionalEsef.js";

describe("extractEsefFacts", () => {
  it("takes latest Assets, applies decimals, reads ISO currency", () => {
    const facts = extractEsefFacts({
      facts: {
        a1: {
          value: "519917",
          decimals: "3",
          dimensions: {
            concept: "ifrs-full:Assets",
            period: "2024-12-31T00:00:00",
            unit: "iso4217:EUR",
          },
        },
        a2: {
          value: "600000000",
          dimensions: {
            concept: "ifrs-full:Assets",
            period: "2025-12-31T00:00:00",
            unit: "iso4217:EUR",
          },
        },
        r1: {
          value: "100",
          dimensions: {
            concept: "ifrs-full:Revenue",
            period: "2025-01-01T00:00:00/2026-01-01T00:00:00",
            unit: "iso4217:EUR",
          },
        },
        junk: { value: "x", dimensions: { concept: "ifrs-full:Assets" } },
      },
    });
    assert.deepEqual(facts.assets, {
      value: 600000000,
      currency: "EUR",
      periodEnd: "2025-12-31T00:00:00",
    });
    assert.deepEqual(facts.revenue, {
      value: 100,
      currency: "EUR",
      periodEnd: "2026-01-01T00:00:00",
    });
  });
});

describe("pickLatestJsonUrl", () => {
  it("picks the newest filing that has facts", () => {
    assert.equal(
      pickLatestJsonUrl([
        { id: "1", date: "2026-01-01" },
        { id: "2", date: "2025-01-01", json_url: "https://x/old.json" },
        { id: "3", date: "2026-06-01", json_url: "https://x/new.json" },
      ]),
      "https://x/new.json",
    );
    assert.equal(pickLatestJsonUrl([]), null);
  });
});
