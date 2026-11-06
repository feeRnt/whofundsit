import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedBody, clearResponseCache } from "./responseCache.js";

describe("responseCache", () => {
  it("builds once then serves the cached string", async () => {
    clearResponseCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { n: builds };
    };
    assert.equal(await cachedBody("k", 60000, build), '{"n":1}');
    assert.equal(await cachedBody("k", 60000, build), '{"n":1}');
    assert.equal(builds, 1);
  });

  it("rebuilds after TTL expiry and isolates keys", async () => {
    clearResponseCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return builds;
    };
    assert.equal(await cachedBody("a", 0, build), "1");
    assert.equal(await cachedBody("a", 0, build), "2");
    assert.equal(await cachedBody("b", 60000, build), "3");
    assert.equal(await cachedBody("b", 60000, build), "3");
    assert.equal(builds, 3);
  });

  it("dedups concurrent first loads into one build", async () => {
    clearResponseCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "shared";
    };
    const results = await Promise.all([
      cachedBody("c", 60000, build),
      cachedBody("c", 60000, build),
      cachedBody("c", 60000, build),
      cachedBody("c", 60000, build),
      cachedBody("c", 60000, build),
    ]);
    assert.deepEqual(results, ["\"shared\"", "\"shared\"", "\"shared\"", "\"shared\"", "\"shared\""]);
    assert.equal(builds, 1);
  });

  it("does not cache failures and caps map size", async () => {
    clearResponseCache();
    let builds = 0;
    const failing = async (): Promise<string> => {
      builds += 1;
      throw new Error("boom");
    };
    await assert.rejects(() => cachedBody("f", 60000, failing), /boom/);
    await assert.rejects(() => cachedBody("f", 60000, failing), /boom/);
    assert.equal(builds, 2);

    clearResponseCache();
    for (let i = 0; i < 52; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cachedBody(`k${i}`, 60000, async () => i);
    }
    let rebuilds = 0;
    await cachedBody("k0", 60000, async () => {
      rebuilds += 1;
      return -1;
    });
    assert.equal(rebuilds, 1);
  });
});
