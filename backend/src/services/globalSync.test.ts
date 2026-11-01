import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_REGIONS,
  buildCompanyQuery,
  parseCompanyRows,
  parseGleifAddress,
  parseGleifChildren,
} from "./globalSync.js";

describe("parseCompanyRows", () => {
  it("collapses exchange rows to one company per LEI", () => {
    const rows = parseCompanyRows({
      results: {
        bindings: [
          {
            companyLabel: { value: "Nestlé" },
            isin: { value: "CH0038863350" },
            lei: { value: "KY37LUS27QQX7BB93L28" },
            exchangeLabel: { value: "Swiss Stock Exchange" },
            hqLabel: { value: "Vevey" },
          },
          {
            companyLabel: { value: "Toyota" },
            isin: { value: "JP3633400001" },
            lei: { value: "5493006W3QUS5LMH6R84" },
            exchangeLabel: { value: "Tokyo Stock Exchange" },
          },
          {
            companyLabel: { value: "Toyota" },
            isin: { value: "JP3633400001" },
            lei: { value: "5493006W3QUS5LMH6R84" },
            exchangeLabel: { value: "Nagoya Stock Exchange" },
          },
          { companyLabel: { value: "Incomplete" } },
        ],
      },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      name: "Nestlé",
      isin: "CH0038863350",
      lei: "KY37LUS27QQX7BB93L28",
      exchanges: ["Swiss Stock Exchange"],
      hq: "Vevey",
    });
    assert.deepEqual(rows[1].exchanges, [
      "Tokyo Stock Exchange",
      "Nagoya Stock Exchange",
    ]);
  });
});

describe("parseGleifAddress", () => {
  it("prefers headquarters and joins address parts", () => {
    assert.deepEqual(
      parseGleifAddress({
        headquartersAddress: {
          addressLines: ["25 Sheppard Avenue West"],
          city: "North York",
          postalCode: "M2N 6S8",
          country: "CA",
        },
        legalAddress: {
          addressLines: ["ELSEWHERE"],
          city: "X",
          country: "US",
        },
      }),
      {
        joined: "25 Sheppard Avenue West, M2N 6S8 North York, CA",
        country: "CA",
      },
    );
  });

  it("falls back to the legal address and tolerates gaps", () => {
    assert.deepEqual(parseGleifAddress({}), null);
    assert.deepEqual(
      parseGleifAddress({ legalAddress: { city: "Vevey", country: "CH" } }),
      { joined: "Vevey, CH", country: "CH" },
    );
  });
});

describe("parseGleifChildren", () => {
  it("extracts child LEIs with names and addresses", () => {
    const kids = parseGleifChildren({
      data: [
        {
          id: "8945002SOXKVMWPWUH46",
          attributes: {
            entity: {
              legalName: { name: "Nestle Canada Inc." },
              headquartersAddress: {
                addressLines: ["25 Sheppard Avenue West"],
                city: "North York",
                postalCode: "M2N 6S8",
                country: "CA",
              },
            },
          },
        },
        { id: "broken" },
      ],
    });
    assert.equal(kids.length, 1);
    assert.equal(kids[0].lei, "8945002SOXKVMWPWUH46");
    assert.equal(kids[0].name, "Nestle Canada Inc.");
    assert.equal(
      kids[0].address?.joined,
      "25 Sheppard Avenue West, M2N 6S8 North York, CA",
    );
  });
});

describe("buildCompanyQuery", () => {
  it("scopes to a continent, excludes the USA, orders by sitelinks", () => {
    const q = buildCompanyQuery(200, "Q48");
    assert.ok(q.includes("wdt:P30 wd:Q48"));
    assert.ok(q.includes("FILTER(?country != wd:Q30)"));
    assert.ok(q.includes("ORDER BY DESC(?links)"));
    assert.ok(q.includes("LIMIT 200"));
  });

  it("region quotas sum to a full GLOBAL_LIMIT", () => {
    const total = GLOBAL_REGIONS.reduce((n, r) => n + r.share, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  });
});
