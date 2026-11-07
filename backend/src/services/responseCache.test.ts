import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cachedBody, cachedStream, clearResponseCache } from "./responseCache.js";

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

describe("cachedStream", () => {
  it("writes emitted rows as one JSON array, byte-identical to stringify", async () => {
    clearResponseCache();
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i, s: `row-${i}` }));
    const file = await cachedStream("s", 60000, async (emit) => {
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await emit(row);
      }
    });
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(rows));
  });

  it("reuses the file within TTL and rebuilds after expiry", async () => {
    clearResponseCache();
    let builds = 0;
    const build = async (emit: (row: unknown) => Promise<void>) => {
      builds += 1;
      await emit(builds);
    };
    const first = await cachedStream("t", 60000, build);
    assert.equal(fs.readFileSync(first, "utf8"), "[1]");
    assert.equal(await cachedStream("t", 60000, build), first);
    assert.equal(builds, 1);
    assert.equal(fs.readFileSync(await cachedStream("t", 0, build), "utf8"), "[2]");
    assert.equal(builds, 2);
  });

  it("writes [] for no rows and never caches failures", async () => {
    clearResponseCache();
    const empty = await cachedStream("e", 60000, async () => {});
    assert.equal(fs.readFileSync(empty, "utf8"), "[]");

    let builds = 0;
    const failing = async (emit: (row: unknown) => Promise<void>): Promise<void> => {
      builds += 1;
      await emit({ half: true });
      throw new Error("boom");
    };
    await assert.rejects(() => cachedStream("f", 60000, failing), /boom/);
    await assert.rejects(() => cachedStream("f", 60000, failing), /boom/);
    assert.equal(builds, 2);
  });

  it("treats Infinity TTL as cache-until-restart", async () => {
    clearResponseCache();
    let builds = 0;
    const file = await cachedStream("inf", Infinity, async (emit) => {
      builds += 1;
      await emit(builds);
    });
    assert.equal(await cachedStream("inf", Infinity, async () => {}), file);
    assert.equal(fs.readFileSync(file, "utf8"), "[1]");
    assert.equal(builds, 1);
    assert.equal(await cachedBody("inf", Infinity, async () => 1), "1");
    assert.equal(await cachedBody("inf", Infinity, async () => 2), "1");
  });

  it("dedups concurrent first builds into one file", async () => {
    clearResponseCache();
    let builds = 0;
    const build = async (emit: (row: unknown) => Promise<void>) => {
      builds += 1;
      await new Promise((r) => setTimeout(r, 20));
      await emit("shared");
    };
    const files = await Promise.all([
      cachedStream("d", 60000, build),
      cachedStream("d", 60000, build),
      cachedStream("d", 60000, build),
    ]);
    assert.deepEqual(files, [files[0], files[0], files[0]]);
    assert.equal(fs.readFileSync(files[0], "utf8"), '["shared"]');
    assert.equal(builds, 1);
  });
});
