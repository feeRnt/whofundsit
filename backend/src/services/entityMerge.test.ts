import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planMerge } from "./entityMerge.js";

const KEEP = "openalex:F4320307808";
const DROP = "openalex:I4210135004";

describe("planMerge", () => {
  it("repoints touching flows and drops merge-created self-loops", () => {
    const plan = planMerge(
      [
        { id: "g1", sourceEntityId: KEEP, targetEntityId: DROP }, // self-grant -> self-loop
        { id: "g2", sourceEntityId: KEEP, targetEntityId: "openalex:I1" }, // untouched
        { id: "f1", sourceEntityId: "13f:X", targetEntityId: DROP }, // repoint target
        { id: "f2", sourceEntityId: DROP, targetEntityId: "openalex:I2" }, // repoint source
      ],
      KEEP,
      DROP,
    );
    assert.deepEqual(plan.repoint.sort(), ["f1", "f2", "g1"]);
    assert.deepEqual(plan.dropSelf, ["g1"]);
  });

  it("ignores unrelated flows", () => {
    const plan = planMerge(
      [{ id: "x", sourceEntityId: "a", targetEntityId: "b" }],
      KEEP,
      DROP,
    );
    assert.deepEqual(plan.repoint, []);
    assert.deepEqual(plan.dropSelf, []);
  });
});
