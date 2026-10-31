import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandLocationText, formatDuration } from "./pipeline.js";

describe("formatDuration", () => {
  it("renders seconds, minutes, and hours", () => {
    assert.equal(formatDuration(45), "45 seconds");
    assert.equal(formatDuration(110), "2 minutes");
    assert.equal(formatDuration(18744 * 1.1), "5.7 hours");
  });
});

describe("expandLocationText", () => {
  it("expands US state codes to full names", () => {
    assert.equal(expandLocationText("US-CA"), "California, United States");
    assert.equal(expandLocationText("US-DC"), "District of Columbia, United States");
    assert.equal(expandLocationText("US-PR"), "Puerto Rico, United States");
  });

  it("nulls placeholders without API calls", () => {
    assert.equal(expandLocationText("—"), null);
    assert.equal(expandLocationText(""), null);
  });

  it("passes everything else through untouched", () => {
    assert.equal(
      expandLocationText("ONE APPLE PARK WAY, CUPERTINO, CA, 95014"),
      "ONE APPLE PARK WAY, CUPERTINO, CA, 95014",
    );
    assert.equal(expandLocationText("US"), "US");
    assert.equal(expandLocationText("US-XX"), "US-XX");
    assert.equal(expandLocationText("CA"), "CA");
  });
});
