import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTickerIndex,
  discoverManagers,
  fundGeocodeQueries,
  isStaleFiling,
  mapLimit,
  normalizeIssuerName,
  parseInfoTable,
  pickInfoTable,
  pickTicker,
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

  it("counts same-CUSIP sleeves into one summed holding", () => {
    const row = (v: number) =>
      `<infoTable><nameOfIssuer>EXXON MOBIL CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>30231G102</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
    const holdings = parseInfoTable(
      `<?xml version="1.0"?><informationTable>${row(100)}${row(50)}</informationTable>`,
    );
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0].valueUsd, 150);
    assert.equal(holdings[0].sleeves, 2);
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

describe("pickInfoTable", () => {
  it("picks the largest non-primary xml", () => {
    assert.equal(
      pickInfoTable([
        { name: "primary_doc.xml", size: "99999999" },
        { name: "13F_0000102909_20251231.xml", size: "23016794" },
        { name: "small.xml", size: "100" },
        { name: "notes.txt", size: "50" },
      ]),
      "13F_0000102909_20251231.xml",
    );
  });

  it("returns undefined for table-less filings (amendment shells)", () => {
    assert.equal(pickInfoTable([]), undefined);
    assert.equal(
      pickInfoTable([{ name: "primary_doc.xml", size: "10" }]),
      undefined,
    );
  });
});

describe("buildTickerIndex", () => {
  it("indexes tickers uppercased, preferring the Assets row", () => {
    const idx = buildTickerIndex([
      { id: "1:Equity", tickers: ["aapl"], conceptTag: "StockholdersEquity" },
      { id: "1:Assets", tickers: ["AAPL"], conceptTag: "Assets" },
      { id: "2:Assets", tickers: [], conceptTag: "Assets" },
    ]);
    assert.equal(idx.get("AAPL"), "1:Assets");
    assert.equal(idx.size, 1);
  });
});

describe("pickTicker", () => {
  it("prefers the US common-stock line across venues", () => {
    assert.equal(
      pickTicker([
        { ticker: "AAPL", exchCode: "UA", securityType: "Common Stock" },
        { ticker: "AAPL", exchCode: "US", securityType: "Common Stock" },
      ]),
      "AAPL",
    );
    assert.equal(
      pickTicker([
        { ticker: "GOOC", exchCode: "UF", securityType: "Common Stock" },
        { ticker: "GOOG", exchCode: "US", securityType: "Common Stock" },
      ]),
      "GOOG",
    );
  });

  it("returns null when no venue carries a ticker", () => {
    assert.equal(pickTicker([]), null);
    assert.equal(pickTicker([{ exchCode: "US" }]), null);
  });
});

describe("isStaleFiling", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  it("flags filings older than two years, keeps the rest", () => {
    assert.equal(isStaleFiling("2026-08-07", 2, now), false);
    assert.equal(isStaleFiling("2024-10-31", 2, now), false);
    assert.equal(isStaleFiling("2024-10-30", 2, now), true);
    assert.equal(isStaleFiling("2006-01-01", 2, now), true);
  });
  it("never skips on unparseable dates", () => {
    assert.equal(isStaleFiling("", 2, now), false);
    assert.equal(isStaleFiling("not-a-date", 2, now), false);
  });
});

describe("mapLimit", () => {
  it("covers every item without exceeding the worker cap", async () => {
    let live = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      seen.push(n);
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.ok(peak <= 2, `peak ${peak} exceeded cap 2`);
    assert.ok(peak >= 2, `peak ${peak} shows no parallelism`);
  });
});

describe("fundGeocodeQueries", () => {
  const bulk = (address: string | null) => ({
    address,
    name: "FOO LLC",
    state: "IL",
    tickers: [],
    exchanges: [],
    category: null,
    formerNames: [],
  });

  it("orders full address, city fallback, then name query", () => {
    assert.deepEqual(
      fundGeocodeQueries(
        "FOO LLC",
        bulk("PO BOX 123, SPRINGFIELD, IL, 62701"),
      ),
      [
        "PO BOX 123, SPRINGFIELD, IL, 62701",
        "SPRINGFIELD, IL, 62701",
        "FOO LLC headquarters",
      ],
    );
  });

  it("falls back to the name query when the bulk map has no address", () => {
    assert.deepEqual(fundGeocodeQueries("FOO LLC", bulk(null)), [
      "FOO LLC headquarters",
    ]);
    assert.deepEqual(fundGeocodeQueries("FOO LLC", undefined), [
      "FOO LLC headquarters",
    ]);
  });

  it("dedupes when the street line is already the whole query", () => {
    assert.deepEqual(
      fundGeocodeQueries("FOO LLC", bulk("SPRINGFIELD, IL, 62701")),
      ["SPRINGFIELD, IL, 62701", "FOO LLC headquarters"],
    );
  });
});
