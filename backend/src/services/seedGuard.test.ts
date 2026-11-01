import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wipeRefusal } from "./seedGuard.js";

describe("wipeRefusal", () => {
  it("allows wiping an empty demo database", () => {
    assert.equal(wipeRefusal(0, 0, undefined), null);
  });

  it("refuses a populated database without explicit opt-in", () => {
    const msg = wipeRefusal(21514, 9362, undefined);
    assert.ok(msg?.includes("21514 entities"));
    assert.ok(msg?.includes("DEMO_WIPE_OK=1"));
  });

  it("allows a populated database with DEMO_WIPE_OK=1", () => {
    assert.equal(wipeRefusal(21514, 9362, "1"), null);
  });

  it("treats any other flag value as unset", () => {
    assert.ok(wipeRefusal(1, 0, "0")?.startsWith("refusing"));
    assert.ok(wipeRefusal(0, 1, "")?.startsWith("refusing"));
  });
});
