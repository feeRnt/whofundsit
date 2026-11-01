import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEsefFacts,
  pickLatestJsonUrl,
  toFinancialDate,
} from "./regionalEsef.js";

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
  it("picks max period_end and absolutizes the relative json_url", () => {
    assert.equal(
      pickLatestJsonUrl([
        { period_end: "2026-12-31" },
        { period_end: "2024-12-31", json_url: "/L/2024/f.json" },
        { period_end: "2025-12-31", json_url: "/L/2025/f.json" },
      ]),
      "https://filings.xbrl.org/L/2025/f.json",
    );
    assert.equal(pickLatestJsonUrl([]), null);
    assert.equal(
      pickLatestJsonUrl([{ json_url: "/L/x.json" }]),
      null,
    );
  });

  it("passes absolute urls through", () => {
    assert.equal(
      pickLatestJsonUrl([
        { period_end: "2025-12-31", json_url: "https://x/new.json" },
      ]),
      "https://x/new.json",
    );
  });
});

describe("toFinancialDate", () => {
  it("parses full dates and bare years, nulls garbage", () => {
    assert.equal(
      toFinancialDate("2024-12-31")?.toISOString().slice(0, 10),
      "2024-12-31",
    );
    assert.equal(
      toFinancialDate("2024")?.toISOString().slice(0, 10),
      "2024-01-01",
    );
    assert.equal(toFinancialDate("not-a-date"), null);
    assert.equal(toFinancialDate(""), null);
  });
});
