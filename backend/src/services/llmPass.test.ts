import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  oneLine,
  readPassFile,
  structuredParams,
  toCensusRow,
  toPassRows,
  writePassFile,
} from "./llmPass.js";

const ADDR = {
  houseNumber: "600",
  street: "Grant St",
  city: "Pittsburgh",
  stateOrRegion: "PA",
  postalCode: "15219",
  country: "United States",
  countryCode: "US",
};

describe("structuredParams + oneLine", () => {
  it("maps fields to Nominatim structured params", () => {
    assert.deepEqual(structuredParams(ADDR), {
      street: "600 Grant St",
      city: "Pittsburgh",
      state: "PA",
      postalcode: "15219",
      country: "United States",
    });
    assert.equal(
      oneLine(ADDR),
      "600 Grant St, Pittsburgh, PA, 15219, United States",
    );
  });

  it("drops empties and falls back to the country code", () => {
    const sparse = { ...ADDR, houseNumber: null, postalCode: null, country: null };
    assert.deepEqual(structuredParams(sparse), {
      street: "Grant St",
      city: "Pittsburgh",
      state: "PA",
      country: "US",
    });
  });
});

describe("toCensusRow", () => {
  it("passes complete US rows, rejects the rest", () => {
    assert.deepEqual(toCensusRow(ADDR), {
      street: "600 Grant St",
      city: "Pittsburgh",
      state: "PA",
      zip: "15219",
    });
    assert.equal(toCensusRow({ ...ADDR, postalCode: "K1A 0B1" }), null);
    assert.equal(toCensusRow({ ...ADDR, city: null }), null);
  });
});

describe("toPassRows", () => {
  it("pairs replies to inputs as pending rows", () => {
    const rows = toPassRows(
      [{ id: "e1", name: "N", original: "O" }],
      [{ original: "O", address: ADDR, confidence: 0.9, notes: "n", failureCause: null }],
      2,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "pending");
    assert.equal(rows[0]?.pass, 2);
    assert.equal(rows[0]?.formalized?.city, "Pittsburgh");
    assert.equal(rows[0]?.failureCause, null);
  });

  it("nulls the parse when the model failed", () => {
    const rows = toPassRows(
      [{ id: "e1", name: "N", original: "O" }],
      [{ original: "O", address: ADDR, confidence: 0.1, notes: "po", failureCause: "po-box" }],
      1,
    );
    assert.equal(rows[0]?.formalized, null);
    assert.equal(rows[0]?.failureCause, "po-box");
  });
});

describe("pass file roundtrip", () => {
  it("writes and reads rows, throws friendly when missing", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lp-")), "p.json");
    const rows = toPassRows(
      [{ id: "e1", name: "N", original: "O" }],
      [{ original: "O", address: ADDR, confidence: 1, notes: "", failureCause: null }],
      1,
    );
    writePassFile(1, rows, file);
    assert.deepEqual(readPassFile(1, file), rows);
    assert.throws(() => readPassFile(9, `${file}.missing`), /formalize:addresses --pass=9/);
  });
});
