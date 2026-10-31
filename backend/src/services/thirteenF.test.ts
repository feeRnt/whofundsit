import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverManagers,
  normalizeIssuerName,
  parseInfoTable,
} from "./thirteenF.js";

// Fixture lives next to this file (committed); runners against dist must
// copy __fixtures__ alongside the compiled test.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "__fixtures__", "thirteenf-table.xml");

describe("parseInfoTable", () => {
  it("parses holdings, sorts by value, skips broken rows", () => {
    const holdings = parseInfoTable(fs.readFileSync(FIXTURE, "utf8"));
    assert.equal(holdings.length, 2);
    assert.equal(holdings[0].issuer, "APPLE INC");
    assert.equal(holdings[0].valueUsd, 1000000);
    assert.equal(holdings[0].cusip, "037833100");
    assert.equal(holdings[1].issuer, "Microsoft Corp");
  });

  it("handles a single infoTable (object, not array)", () => {
    const holdings = parseInfoTable(
      `<?xml version="1.0"?><informationTable><infoTable><nameOfIssuer>X</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>123456789</cusip><value>5</value><shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>`,
    );
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0].valueUsd, 5);
  });
});

describe("normalizeIssuerName", () => {
  it("matches across case and suffix styles", () => {
    assert.equal(normalizeIssuerName("APPLE INC"), normalizeIssuerName("Apple Inc."));
    assert.equal(
      normalizeIssuerName("BERKSHIRE HATHAWAY INC"),
      normalizeIssuerName("Berkshire Hathaway Inc."),
    );
    assert.equal(
      normalizeIssuerName("Microsoft Corp"),
      normalizeIssuerName("MICROSOFT CORPORATION"),
    );
  });
});

describe("parseInfoTable aggregation", () => {
  it("sums same-CUSIP sleeves instead of last-write-wins", () => {
    const row = (value: number, mgr: number) =>
      `<infoTable><nameOfIssuer>META PLATFORMS INC</nameOfIssuer><titleOfClass>CL A</titleOfClass><cusip>30303M102</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><otherManager>${mgr}</otherManager></infoTable>`;
    const holdings = parseInfoTable(
      `<?xml version="1.0"?><informationTable>${row(37255044697, 21)}${row(56329, 4)}</informationTable>`,
    );
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0].valueUsd, 37255044697 + 56329);
    assert.equal(holdings[0].shares, 20);
  });
});

describe("discoverManagers", () => {
  it("finds 13F-HR filers and skips the rest", async () => {
    const found = await discoverManagers(
      path.join(here, "__fixtures__", "submissions-sample.zip"),
    );
    assert.deepEqual(found, [
      { cik: "1234", name: "TEST FUND LP", accn: "a2", filingDate: "d2" },
    ]);
  });
});
