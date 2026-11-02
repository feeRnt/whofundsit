import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GLEIF_MIN_INTERVAL_MS,
  GLOBAL_REGIONS,
  SPARQL_MIN_INTERVAL_MS,
  buildCompanyQuery,
  buildIndustryQuery,
  gleifLimit,
  parseCompanyRows,
  parseGleifAddress,
  parseGleifChildren,
  parseIndustryBindings,
  sanitizeLeis,
  sparqlLimit,
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

describe("api pacing", () => {
  it("pins limiter intervals to the ToS-derived ceilings", () => {
    // Wikidata publishes no req/s cap (descriptive UA + reasonable load
    // only): 5s is our conservative courtesy posture. GLEIF publishes
    // 60 req/min/user (official API docs): 1100ms paces ~55/min with margin.
    assert.equal(SPARQL_MIN_INTERVAL_MS, 5000);
    assert.equal(GLEIF_MIN_INTERVAL_MS, 1100);
    assert.equal(typeof sparqlLimit, "function");
    assert.equal(typeof gleifLimit, "function");
  });

  it("spaces GLEIF calls through the shared limiter", async () => {
    const t0 = Date.now();
    await Promise.all([gleifLimit(async () => {}), gleifLimit(async () => {})]);
    // 1 x 1100ms gap with slack for timer slop.
    assert.ok(Date.now() - t0 >= 900, "gleif calls unpaced");
  });
});

describe("buildIndustryQuery", () => {
  it("builds a VALUES batch with P452 lookup and stable order", () => {
    const q = buildIndustryQuery(["5493006W3QUS5LMH6R84", "KY37LUS27QQX7BB93L28"]);
    assert.ok(
      q.includes('VALUES ?lei { "5493006W3QUS5LMH6R84" "KY37LUS27QQX7BB93L28" }'),
    );
    assert.ok(q.includes("wdt:P1278 ?lei"));
    assert.ok(q.includes("OPTIONAL { ?company wdt:P452 ?ind. }"));
    assert.ok(q.includes("ORDER BY ?lei ?indLabel"));
  });

  it("drops malformed LEIs before they reach the query", () => {
    assert.deepEqual(
      sanitizeLeis([
        "5493006W3QUS5LMH6R84",
        "nope",
        '5493006W3QUS5LMH6R84" OR 1=1',
        "short",
      ]),
      ["5493006W3QUS5LMH6R84"],
    );
  });
});

describe("parseIndustryBindings", () => {
  it("takes the first label per LEI, null when P452 is absent", () => {
    const out = parseIndustryBindings({
      results: {
        bindings: [
          { lei: { value: "L1" }, indLabel: { value: "clothing industry" } },
          { lei: { value: "L1" }, indLabel: { value: "fashion" } },
          { lei: { value: "L2" } },
        ],
      },
    });
    assert.equal(out.get("L1"), "clothing industry");
    assert.equal(out.get("L2"), null);
    assert.equal(out.has("L3"), false);
  });
});
