import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENFIGI_KEYED_INTERVAL_MS,
  OPENFIGI_KEYLESS_INTERVAL_MS,
  pickIsinTicker,
} from "./openfigi.js";

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

describe("api pacing", () => {
  it("paces at the documented ceiling (mapping API rate-limit table)", () => {
    // Official docs: 25 req/min keyless, 250 keyed (per IP/key, 60s
    // windows). Liberal reading = run AT the ceiling (~96%), never past:
    // 2500ms keyless, 250ms keyed. (No timing assertion: the keyless
    // 2.5s instance is too slow to exercise; the shared primitive and
    // sibling gates already prove the mechanics.)
    assert.equal(OPENFIGI_KEYLESS_INTERVAL_MS, 2500);
    assert.equal(OPENFIGI_KEYED_INTERVAL_MS, 250);
  });
});
