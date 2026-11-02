import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCensusCsv,
  isUsShaped,
  parseCensusResponse,
  parseUsAddress,
  splitCsvLine,
} from "./censusBatch.js";

describe("parseUsAddress", () => {
  it("splits SEC-shaped rows with comma or merged state+zip tails", () => {
    assert.deepEqual(
      parseUsAddress("600 GRANT ST, ROOM 1500, PITTSBURGH, PA, 15219-2800"),
      {
        street: "600 GRANT ST, ROOM 1500",
        city: "PITTSBURGH",
        state: "PA",
        zip: "15219-2800",
      },
    );
    assert.deepEqual(
      parseUsAddress("4600 Silver Hill Rd, Washington, DC 20233"),
      {
        street: "4600 Silver Hill Rd",
        city: "Washington",
        state: "DC",
        zip: "20233",
      },
    );
  });

  it("rejects rows without a US state+zip tail", () => {
    // GLEIF US rows carry no state code: Nominatim keeps them.
    assert.equal(
      parseUsAddress("1209 ORANGE ST, 19801 WILMINGTON, US"),
      null,
    );
    assert.equal(
      parseUsAddress("33 CHARTERHOUSE STREET, EC1M 6HA LONDON, GB"),
      null,
    );
    // State-centroid expansions and digitless streets: not Census-shaped.
    assert.equal(parseUsAddress("Illinois, United States"), null);
    assert.equal(parseUsAddress("MAIN STREET, SPRINGFIELD, IL, 62701"), null);
    // Bogus state codes never parse, even in the right shape.
    assert.equal(parseUsAddress("12 RUE X, MAROUSI, GR, 15125"), null);
    assert.equal(parseUsAddress("—"), null);
    assert.equal(parseUsAddress(""), null);
  });

  it("accepts zip-less rows with a blank zip, rejects PO boxes", () => {
    assert.deepEqual(
      parseUsAddress("3651 FAU BLVD SUITE 400, BOCA RATON, FL"),
      {
        street: "3651 FAU BLVD SUITE 400",
        city: "BOCA RATON",
        state: "FL",
        zip: "",
      },
    );
    assert.equal(
      parseUsAddress("PO BOX 123, SPRINGFIELD, IL, 62701"),
      null,
    );
    assert.equal(
      parseUsAddress("P.O. BOX 309, UGLAND HOUSE, KY1-1104 GRAND CAYMAN, KY"),
      null,
    );
  });
});

describe("isUsShaped", () => {
  it("flags US rows the parser rejects, stays silent on foreign", () => {
    assert.equal(isUsShaped("100 SHOCKOE SLIP FL 2, 23219-4100 RICHMOND, US"), true);
    assert.equal(
      isUsShaped("MAIN STREET, SPRINGFIELD, IL, 62701"),
      true,
    );
    assert.equal(
      isUsShaped("33 CHARTERHOUSE STREET, EC1M 6HA LONDON, GB"),
      false,
    );
    assert.equal(isUsShaped("15125 MAROUSI, GR"), false);
    assert.equal(isUsShaped("Illinois, United States"), false);
    // Cayman KY1-1104 is not a US zip: stays foreign-skipped.
    assert.equal(
      isUsShaped("P.O. BOX 309, UGLAND HOUSE, KY1-1104 GRAND CAYMAN, KY"),
      false,
    );
    // Live false positive: "UR,, 50450" is Kuala Lumpur, not a US tail.
    assert.equal(
      isUsShaped(
        "B-23A-02, G-VESTOR TOWER,, PAVILION EMBASSY, 200 JALAN AMPANG,, 50450 W.P. KUALA LUMPUR,, 50450",
      ),
      false,
    );
  });
});

describe("splitCsvLine", () => {
  it("handles quoted commas and escaped quotes", () => {
    assert.deepEqual(splitCsvLine('a,b,c'), ["a", "b", "c"]);
    assert.deepEqual(splitCsvLine('1,"4600 SILVER HILL RD, DC","-76.9,38.9"'), [
      "1",
      "4600 SILVER HILL RD, DC",
      "-76.9,38.9",
    ]);
    assert.deepEqual(splitCsvLine('"a""b",c'), ['a"b', "c"]);
  });
});

describe("buildCensusCsv", () => {
  it("emits headerless id,street,city,state,zip with quoting", () => {
    const csv = buildCensusCsv([
      {
        id: "0",
        addr: {
          street: "600 GRANT ST, ROOM 1500",
          city: "PITTSBURGH",
          state: "PA",
          zip: "15219",
        },
      },
    ]);
    assert.equal(csv, '0,"600 GRANT ST, ROOM 1500",PITTSBURGH,PA,15219\n');
    const noZip = buildCensusCsv([
      {
        id: "1",
        addr: {
          street: "3651 FAU BLVD SUITE 400",
          city: "BOCA RATON",
          state: "FL",
          zip: "",
        },
      },
    ]);
    assert.equal(noZip, "1,3651 FAU BLVD SUITE 400,BOCA RATON,FL,\n");
  });
});

describe("parseCensusResponse", () => {
  const MATCH =
    '0,"4600 Silver Hill Rd, Washington, DC 20233",Match,Exact,' +
    '"4600 SILVER HILL RD, WASHINGTON, DC 20233","-76.92744,38.99077",123,Left';
  const NON_EXACT =
    '1,"99 Main St, Springfield, IL 62701",Match,Non_Exact,' +
    '"99 MAIN ST, SPRINGFIELD, IL 62701","-89.65001,39.78172",124,Right';

  it("reads lon-first coords without swapping them", () => {
    const out = parseCensusResponse(`${MATCH}\n${NON_EXACT}\n`);
    assert.deepEqual(out.get("0"), { lat: 38.99077, lng: -76.92744 });
    assert.deepEqual(out.get("1"), { lat: 39.78172, lng: -89.65001 });
  });

  it("misses on No_Match, Tie, garbage, and out-of-range coords", () => {
    const out = parseCensusResponse(
      [
        '2,"Nowhere, XX 00000",No_Match,,,"",,',
        '3,"Tie St, Austin, TX 78701",Tie,,,"",,',
        '4,"Bad, Austin, TX 78701",Match,Exact,"BAD","abc,def",,',
        '5,"Swap, Austin, TX 78701",Match,Exact,"SWAP","30.2,-97.7",,',
        "",
      ].join("\n"),
    );
    assert.equal(out.get("2"), null);
    assert.equal(out.get("3"), null);
    assert.equal(out.get("4"), null);
    // "30.2,-97.7" as lon,lat would put lat at -97.7: dropped, not swapped.
    assert.equal(out.get("5"), null);
  });
});
