import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_MIN_INTERVAL_MS,
  changePct,
  isQuoteRequestAllowed,
  parseAllowedOrigins,
  parseYahooChart,
  quoteLimit,
  yahooSymbol,
} from "./stockQuote.js";

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

describe("api pacing", () => {
  it("gates quote fetches at a polite 1/s (no published Yahoo cap)", async () => {
    assert.equal(QUOTE_MIN_INTERVAL_MS, 1000);
    assert.equal(typeof quoteLimit, "function");
    const t0 = Date.now();
    await Promise.all([quoteLimit(async () => {}), quoteLimit(async () => {})]);
    assert.ok(Date.now() - t0 >= 800, "quote calls unpaced");
  });
});

describe("parseAllowedOrigins", () => {
  it("normalizes to origins and drops junk", () => {
    assert.deepEqual(
      parseAllowedOrigins("https://a.example/x, http://b.example:4000, nope, "),
      ["https://a.example", "http://b.example:4000"],
    );
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(""), []);
  });
});

describe("isQuoteRequestAllowed", () => {
  const allowed = ["https://edge.example"];
  it("is open when no allowlist is configured", () => {
    assert.equal(isQuoteRequestAllowed(undefined, undefined, []), true);
  });
  it("accepts a matching origin or referer", () => {
    assert.equal(
      isQuoteRequestAllowed("https://edge.example", undefined, allowed),
      true,
    );
    assert.equal(
      isQuoteRequestAllowed(undefined, "https://edge.example/p?q=1", allowed),
      true,
    );
  });
  it("rejects strangers, missing headers, and garbage", () => {
    assert.equal(
      isQuoteRequestAllowed("https://evil.example", undefined, allowed),
      false,
    );
    assert.equal(isQuoteRequestAllowed(undefined, undefined, allowed), false);
    assert.equal(
      isQuoteRequestAllowed("not a url", "also not", allowed),
      false,
    );
  });
});
