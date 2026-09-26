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
    "dev00000.service-now.com",
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

test("L2-11: backslashes and mixed quotes round-trip through the literal quote forms", () => {
  for (const value of [
    " back\\slash",
    "C:\\Program Files\\ca.pem ",
    "#x\\",
    " a'b\"c",
    "'\\n'",
  ]) {
    assert.equal(roundTrip(value), value, `value: ${JSON.stringify(value)}`);
  }
  // A backslash in a value that needs quoting uses single quotes (literal).
  assert.equal(formatEnvValue(" back\\slash"), "' back\\slash'");
});

test("refuses values dotenv cannot round-trip", () => {
  // Contains a newline.
  assert.throws(() => formatEnvValue("line\nbreak"));
  assert.throws(() => formatEnvValue("carriage\rreturn"));
  // Needs quoting and contains single, double and back quotes.
  assert.throws(() => formatEnvValue(" a'b\"c`d"));
});
