import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changePct, parseYahooChart, yahooSymbol } from "./stockQuote.js";

describe("yahooSymbol", () => {
  it("maps tickers to Yahoo symbols", () => {
    assert.equal(yahooSymbol("AAPL"), "AAPL");
    assert.equal(yahooSymbol("BRK.B"), "BRK-B");
    assert.equal(yahooSymbol(" googl "), "GOOGL");
  });

  it("rejects junk that would poison the URL", () => {
    assert.equal(yahooSymbol(""), null);
    assert.equal(yahooSymbol("AAPL; rm -rf"), null);
    assert.equal(yahooSymbol("WAYTOOLONGTICKER"), null);
  });
});

describe("parseYahooChart", () => {
  const chart = {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 232.1,
            chartPreviousClose: 230.1,
            regularMarketTime: 1790812800,
          },
        },
      ],
    },
  };

  it("reads price/previous-close/time from chart meta", () => {
    assert.deepEqual(parseYahooChart(chart), {
      previousClose: 230.1,
      price: 232.1,
      date: new Date(1790812800 * 1000).toISOString().slice(0, 10),
    });
  });

  it("returns null for missing meta, garbage, and zero prev-close", () => {
    assert.equal(parseYahooChart({}), null);
    assert.equal(parseYahooChart({ chart: { result: [] } }), null);
    assert.equal(
      parseYahooChart({
        chart: { result: [{ meta: { ...chart.chart.result[0].meta, chartPreviousClose: 0 } }] },
      }),
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
