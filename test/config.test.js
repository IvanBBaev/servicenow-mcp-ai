import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";

import { formatEnvValue } from "../build/core/config.js";

/** Serialise a value, parse it back through dotenv, and return the result. */
const roundTrip = (value) => dotenv.parse(`KEY=${formatEnvValue(value)}`).KEY;

test("round-trips plain values without quoting", () => {
  for (const value of [
    "examplepass",
    "jane.doe@example.com",
    "ven03019.service-now.com",
    "p@ssw0rd!",
    "has$dollar",
    'mid"quote',
    "mid'quote",
    "back\\slash",
    "with space",
  ]) {
    assert.equal(roundTrip(value), value, `value: ${JSON.stringify(value)}`);
  }
});

test("round-trips values that require quoting", () => {
  for (const value of [
    "",
    " leading",
    "trailing ",
    "with#hash",
    "#startshash",
    "'startsquote",
    '"startsquote',
    "ends#with space ",
  ]) {
    assert.equal(roundTrip(value), value, `value: ${JSON.stringify(value)}`);
  }
});

test("refuses values dotenv cannot round-trip", () => {
  // Needs quoting (leading space) and contains a backslash.
  assert.throws(() => formatEnvValue(" back\\slash"));
  // Contains a newline.
  assert.throws(() => formatEnvValue("line\nbreak"));
  // Needs quoting and contains both single and double quotes.
  assert.throws(() => formatEnvValue(" a'b\"c"));
});
