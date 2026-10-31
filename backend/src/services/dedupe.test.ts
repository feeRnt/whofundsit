import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, groupDuplicates, idGroup } from "./dedupe.js";

function row(id: string, name: string) {
  return {
    id,
    name,
    type: "Company",
    source: "bulk-zip",
    tickers: [],
    lat: 1,
    lng: 2,
    businessAddress: null,
  };
}

describe("dedupeKey", () => {
  it("folds case, punctuation, parens, and legal suffixes", () => {
    assert.equal(dedupeKey("Exxon Mobil Corporation"), "EXXONMOBIL");
    assert.equal(dedupeKey("EXXON MOBIL CORP"), "EXXONMOBIL");
    assert.equal(
      dedupeKey("Colgate-Palmolive (United States)"),
      "COLGATEPALMOLIVE",
    );
    assert.equal(dedupeKey("Colgate-Palmolive Company"), "COLGATEPALMOLIVE");
  });
});

describe("idGroup", () => {
  it("shares numeric CIK prefixes, isolates the rest by full id", () => {
    assert.equal(idGroup("1000045:Assets"), "1000045");
    assert.equal(idGroup("1000045:Debt"), "1000045");
    assert.equal(idGroup("openalex:F1"), "openalex:F1");
    assert.equal(idGroup("openalex:I2"), "openalex:I2");
  });
});

describe("groupDuplicates", () => {
  it("groups Exxon-style CIK twins, never same-CIK concept rows", () => {
    const groups = groupDuplicates([
      row("1000045:Assets", "OLD MARKET CAPITAL CORPORATION"),
      row("1000045:LongTermDebt", "OLD MARKET CAPITAL CORPORATION"),
      row("2115436:Assets", "Exxon Mobil Corporation"),
      row("34088:Assets", "Exxon Mobil Corporation"),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].map((m) => m.id),
      ["2115436:Assets", "34088:Assets"],
    );
  });

  it("groups Colgate-style funder/institution twins", () => {
    const groups = groupDuplicates([
      row("openalex:F4320307808", "Colgate-Palmolive Company"),
      row("openalex:I4210135004", "Colgate-Palmolive (United States)"),
    ]);
    assert.equal(groups.length, 1);
  });
});
