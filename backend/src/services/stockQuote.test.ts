import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changePct, parseStooqCsv, stooqSymbol } from "./stockQuote.js";

describe("stooqSymbol", () => {
  it("maps tickers to Stooq US symbols", () => {
    assert.equal(stooqSymbol("AAPL"), "aapl.us");
    assert.equal(stooqSymbol("BRK.B"), "brk-b.us");
    assert.equal(stooqSymbol(" googl "), "googl.us");
  });

  it("rejects junk that would poison the URL", () => {
    assert.equal(stooqSymbol(""), null);
    assert.equal(stooqSymbol("AAPL; rm -rf"), null);
    assert.equal(stooqSymbol("WAYTOOLONGTICKER"), null);
  });
});

describe("parseStooqCsv", () => {
  it("parses the one-row quote CSV", () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\n" +
      "AAPL.US,2026-10-30,22:00:01,230.10,233.40,229.80,232.10,45200100\n";
    assert.deepEqual(parseStooqCsv(csv), {
      open: 230.1,
      close: 232.1,
      date: "2026-10-30",
    });
  });

  it("returns null for header-only, garbage, and zero-open rows", () => {
    assert.equal(parseStooqCsv("Symbol,Date,Time,Open,High,Low,Close,Volume\n"), null);
    assert.equal(parseStooqCsv("Exceeded the daily hits limit\n"), null);
    assert.equal(
      parseStooqCsv("h\nX.US,2026-10-30,22:00,0,1,1,1,1\n"),
      null,
    );
  });
});

describe("changePct", () => {
  it("computes day change, null on bad input", () => {
    assert.ok(Math.abs((changePct(100, 101.5) ?? 0) - 1.5) < 1e-9);
    assert.ok((changePct(100, 99) ?? 0) < 0);
    assert.equal(changePct(0, 99), null);
    assert.equal(changePct(NaN, 99), null);
  });
});
