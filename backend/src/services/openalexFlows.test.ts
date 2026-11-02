import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  assertValidFunder,
  readFunderCoords,
  resolveFunderId,
  resolveFunderIds,
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

describe("resolveFunderIds", () => {
  it("splits comma lists, drops empties", () => {
    assert.deepEqual(
      resolveFunderIds("https://openalex.org/F1, F2 ,,"),
      ["https://openalex.org/F1", "F2"],
    );
  });

  it("falls back to the single default when unset or blank", () => {
    assert.deepEqual(resolveFunderIds(undefined), [DEFAULT_FUNDER]);
    assert.deepEqual(resolveFunderIds("  , "), [DEFAULT_FUNDER]);
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

describe("readFunderCoords", () => {
  it("resolves the skipped funders to finite in-range coords", () => {
    const map = readFunderCoords();
    for (const id of [
      "F4320334764", // JSPS
      "F4320334627", // EPSRC
      "F4320334593", // NSERC
      "F4320322120", // NRF Korea
      "F4320320719", // DST India
    ]) {
      const at = map.get(id);
      assert.ok(at, `seed row missing for ${id}`);
      assert.ok(Number.isFinite(at.lat) && Math.abs(at.lat) <= 90);
      assert.ok(Number.isFinite(at.lng) && Math.abs(at.lng) <= 180);
    }
    assert.equal(map.get("F0000000000"), undefined);
  });
});

describe("apiUrl", () => {
  it("routes canonical id URLs to the JSON API, not the web page", () => {
    assert.equal(
      apiUrl("https://openalex.org/F4320307808", {}),
      "https://api.openalex.org/funders/F4320307808",
    );
    assert.equal(
      apiUrl("https://openalex.org/I123456789", {}),
      "https://api.openalex.org/institutions/I123456789",
    );
    assert.equal(
      apiUrl("F4320307808", {}),
      "https://api.openalex.org/funders/F4320307808",
    );
  });

  it("passes API paths through with params", () => {
    assert.equal(
      apiUrl("/works", { filter: "funders.id:X" }),
      "https://api.openalex.org/works?filter=funders.id%3AX",
    );
  });
});
