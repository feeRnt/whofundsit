import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "./pipeline.js";

describe("formatDuration", () => {
  it("renders seconds, minutes, and hours", () => {
    assert.equal(formatDuration(45), "45 seconds");
    assert.equal(formatDuration(110), "2 minutes");
    assert.equal(formatDuration(18744 * 1.1), "5.7 hours");
  });
});
