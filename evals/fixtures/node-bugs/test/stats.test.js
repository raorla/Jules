import test from "node:test";
import assert from "node:assert";
import { average, roundTo } from "../src/stats.js";

test("average fait la moyenne", () => {
  assert.equal(average([1, 2, 3]), 2);
});

test("roundTo arrondit au plus proche", () => {
  assert.equal(roundTo(1.234, 2), 1.23);
  assert.equal(roundTo(1.236, 2), 1.24);
});
