import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandLocationText,
  fallbackQueries,
  formatDuration,
  junkAddress,
} from "./pipeline.js";

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

describe("fallbackQueries", () => {
  it("keeps the trailing city/state/zip off a PO-box street line", () => {
    assert.deepEqual(
      fallbackQueries("PO BOX 123, SPRINGFIELD, IL, 62701"),
      ["SPRINGFIELD, IL, 62701", "IL, 62701"],
    );
  });

  it("returns nothing when there is no street line to drop", () => {
    assert.deepEqual(fallbackQueries("SPRINGFIELD, IL, 62701"), []);
    assert.deepEqual(fallbackQueries("SPRINGFIELD, IL"), []);
    assert.deepEqual(fallbackQueries("—"), []);
  });

  it("skips empty parts from doubled commas", () => {
    assert.deepEqual(fallbackQueries("100 MAIN ST, , AUSTIN, TX, 78701"), [
      "AUSTIN, TX, 78701",
      "TX, 78701",
    ]);
  });

  it("drops SEC country codes and falls back to the trailing pair", () => {
    assert.deepEqual(
      fallbackQueries("ONE COLEMAN STREET, LONDON, X0, EC2R 5AA"),
      ["ONE COLEMAN STREET, LONDON, EC2R 5AA", "LONDON, EC2R 5AA"],
    );
    assert.deepEqual(
      fallbackQueries("ONE FRANKLIN PARKWAY, LEGAL-FT SECRETARY, SAN MATEO, CA"),
      ["LEGAL-FT SECRETARY, SAN MATEO, CA", "SAN MATEO, CA"],
    );
  });
});

describe("junkAddress", () => {
  it("junks placeholders and bare registrant names, keeps localities", () => {
    assert.equal(junkAddress(""), true);
    assert.equal(junkAddress("—"), true);
    assert.equal(junkAddress("NTT EUROPE GDC S.R.O."), true);
    assert.equal(junkAddress("AXA IM SMART MATCHING SOLUTIONS NOMINAL 2060S FUND"), true);
    assert.equal(junkAddress("Berlin"), false);
    assert.equal(junkAddress("Austin, TX 78701"), false);
    assert.equal(junkAddress("1 Apple Park Way, Cupertino, CA 95014"), false);
  });
});
