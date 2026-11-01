import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickIsinTicker } from "./openfigi.js";

describe("pickIsinTicker", () => {
  it("prefers common stock on any exchange, else the first ticker", () => {
    assert.deepEqual(
      pickIsinTicker([
        { ticker: "VOD", exchCode: "LN", securityType: "ADR" },
        { ticker: "VOD", exchCode: "US", securityType: "Common Stock" },
      ]),
      { ticker: "VOD", exchCode: "US" },
    );
    assert.deepEqual(
      pickIsinTicker([{ ticker: "7203", exchCode: "JP", securityType: "ADR" }]),
      { ticker: "7203", exchCode: "JP" },
    );
  });

  it("returns null when nothing has a ticker and exchange", () => {
    assert.equal(pickIsinTicker([]), null);
    assert.equal(pickIsinTicker([{ ticker: "X" }]), null);
    assert.equal(pickIsinTicker([{ exchCode: "US" }]), null);
  });
});
