import test from "node:test";
import assert from "node:assert";
import { sum } from "../src/math.js";

test("sum additionne deux nombres", () => {
  assert.equal(sum(1, 2), 3);
});
