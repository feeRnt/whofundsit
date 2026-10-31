import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  joinTwseCode,
  parseTwseBalance,
  rocQuarterEnd,
  twNameKey,
} from "./regionalTwse.js";

describe("rocQuarterEnd", () => {
  it("converts ROC year + quarter to Gregorian quarter-end", () => {
    assert.equal(rocQuarterEnd("115", "2"), "2026-06-30");
    assert.equal(rocQuarterEnd("115", "1"), "2026-03-31");
    assert.equal(rocQuarterEnd("115", "3"), "2026-09-30");
    assert.equal(rocQuarterEnd("115", "4"), "2026-12-31");
    assert.equal(rocQuarterEnd("xx", "2"), null);
    assert.equal(rocQuarterEnd("115", "5"), null);
  });
});

describe("parseTwseBalance", () => {
  it("parses the TSMC row (NTD thousands -> units)", () => {
    const row = parseTwseBalance({
      年度: "115",
      季別: "2",
      公司代號: "2330",
      公司名稱: "台積電",
      資產總計: "9375654727.00",
    });
    assert.deepEqual(row, {
      code: "2330",
      name: "台積電",
      assets: 9375654727000,
      date: "2026-06-30",
    });
  });

  it("rejects rows without a code or assets", () => {
    assert.equal(parseTwseBalance({}), null);
    assert.equal(parseTwseBalance({ 公司代號: "2330" }), null);
  });
});

describe("joinTwseCode", () => {
  const tickerToLei = new Map([["2330", "549300KB6NK5SBD14S87"]]);
  const nameToLei = new Map([[twNameKey("台積電"), "549300KB6NK5SBD14S87"]]);

  it("prefers the ticker map, falls back to names", () => {
    assert.deepEqual(joinTwseCode("2330", "台積電", tickerToLei, nameToLei), {
      lei: "549300KB6NK5SBD14S87",
      via: "ticker",
    });
    assert.deepEqual(
      joinTwseCode("9999", "台積電", new Map(), nameToLei),
      { lei: "549300KB6NK5SBD14S87", via: "name" },
    );
    assert.equal(joinTwseCode("9999", "不存在", new Map(), new Map()), null);
  });
});
