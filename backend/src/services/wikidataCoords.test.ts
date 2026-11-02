import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { p625ByLei, parseWktPoint, selectP625Leis } from "./wikidataCoords.js";

describe("parseWktPoint", () => {
  it("parses Point(lon lat), longitude first", () => {
    assert.deepEqual(parseWktPoint("Point(12.568888888 55.676111111)"), {
      lat: 55.676111111,
      lng: 12.568888888,
    });
    assert.deepEqual(parseWktPoint("Point(-0.1276 51.5074)"), {
      lat: 51.5074,
      lng: -0.1276,
    });
  });

  it("rejects garbage and out-of-range", () => {
    assert.equal(parseWktPoint("Point(200 10)"), null);
    assert.equal(parseWktPoint("Point(10 95)"), null);
    assert.equal(parseWktPoint("hello"), null);
    assert.equal(parseWktPoint(undefined), null);
    assert.equal(parseWktPoint(42), null);
  });
});

describe("p625ByLei", () => {
  it("prefers HQ coords, falls back to direct, skips missing LEI", () => {
    const out = p625ByLei([
      { lei: { value: "LEI1" }, hqCoord: { value: "Point(2 48)" }, coord: { value: "Point(3 49)" } },
      { lei: { value: "LEI2" }, coord: { value: "Point(-73 40)" } },
      { hqCoord: { value: "Point(0 0)" } },
      { lei: { value: "LEI3" } },
    ]);
    assert.deepEqual(out.get("LEI1"), { coords: { lat: 48, lng: 2 }, via: "hq" });
    assert.deepEqual(out.get("LEI2"), { coords: { lat: 40, lng: -73 }, via: "direct" });
    assert.equal(out.has("LEI3"), false);
    assert.equal(out.size, 2);
  });
});

describe("selectP625Leis", () => {
  it("splits main vs dead and dedupes", () => {
    const rows = [
      { id: "lei:AAA", geoStatus: "pending" },
      { id: "lei:BBB", geoStatus: "failed" },
      { id: "lei:BBB", geoStatus: "failed" },
      { id: "34088:Assets", geoStatus: "pending" },
    ];
    assert.deepEqual(selectP625Leis(rows, "main"), ["AAA"]);
    assert.deepEqual(selectP625Leis(rows, "dead"), ["BBB"]);
  });
});
