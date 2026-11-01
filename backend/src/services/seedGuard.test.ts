import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSeedProgress, wipeRefusal } from "./seedGuard.js";

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

describe("renderSeedProgress", () => {
  it("renders a 20-char bar with counts and percent", () => {
    assert.equal(
      renderSeedProgress("entities", 500, 1000),
      "[Loading entities] [##########----------] 500/1000 (50%)",
    );
    assert.equal(
      renderSeedProgress("flows", 40030, 40030),
      "[Loading flows] [####################] 40030/40030 (100%)",
    );
  });

  it("treats an empty load as complete without dividing by zero", () => {
    assert.equal(
      renderSeedProgress("entities", 0, 0),
      "[Loading entities] [####################] 0/0 (100%)",
    );
  });
});
