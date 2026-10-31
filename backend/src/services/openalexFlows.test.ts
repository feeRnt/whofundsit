import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidFunder,
  resolveFunderId,
  type Funder,
} from "./openalexFlows.js";

// Regression: an empty OPENALEX_FUNDER_ID queried the API root, yielding a
// funder with undefined fields that crashed downstream in geocoding (400).
const DEFAULT_FUNDER = "https://openalex.org/F4320307808";

describe("resolveFunderId", () => {
  it("falls back to the default when unset, empty, or whitespace", () => {
    assert.equal(resolveFunderId(undefined), DEFAULT_FUNDER);
    assert.equal(resolveFunderId(""), DEFAULT_FUNDER);
    assert.equal(resolveFunderId("   "), DEFAULT_FUNDER);
  });

  it("trims and keeps a configured id", () => {
    assert.equal(
      resolveFunderId("  https://openalex.org/F123  "),
      "https://openalex.org/F123",
    );
  });
});

describe("assertValidFunder", () => {
  it("throws on junk payloads", () => {
    assert.throws(() =>
      assertValidFunder({} as Funder, "https://openalex.org/"),
    );
    assert.throws(() =>
      assertValidFunder(
        { display_name: 1, works_count: 2 } as unknown as Funder,
        "https://openalex.org/F123",
      ),
    );
  });

  it("accepts a real funder doc", () => {
    assert.doesNotThrow(() =>
      assertValidFunder(
        {
          id: "https://openalex.org/F4320307808",
          display_name: "Colgate-Palmolive Company",
          country_code: "US",
          works_count: 1417,
        },
        DEFAULT_FUNDER,
      ),
    );
  });
});
