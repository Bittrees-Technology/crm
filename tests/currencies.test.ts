import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currencyCodes,
  currencyGroups,
  validAmount,
  sumAmounts,
  formatAmount,
} from "../lib/currencies";
import { recordSchema } from "../lib/model";
test("all supported fiat, crypto, and Bittrees denominations validate and format", () => {
  assert.deepEqual(
    [...currencyGroups.flatMap((g) => g.options.map((o) => o[0]))].sort(),
    [...currencyCodes].sort(),
  );
  for (const currency of currencyCodes) {
    const record = recordSchema.parse({
      name: "Currency test",
      currency,
      value: "0.000000000000000001",
    });
    assert.equal(record.value, "0.000000000000000001");
    assert.equal(
      formatAmount(record.value, currency, "en-US"),
      `0.000000000000000001 ${currency}`,
    );
  }
  assert.equal(
    recordSchema.safeParse({ name: "Bad", currency: "FAKE" }).success,
    false,
  );
});
test("amounts reject invalid, excessive, and negative inputs without rounding", () => {
  for (const amount of [
    "",
    "-1",
    "1e-18",
    "1,234",
    "NaN",
    "0.0000000000000000001",
    "1000000000000.000000000000000001",
    -1,
    Infinity,
    NaN,
    1e-19,
  ]) {
    assert.equal(validAmount(amount), false, String(amount));
    assert.equal(
      recordSchema.safeParse({ name: "Bad", value: amount }).success,
      false,
    );
  }
  for (const amount of [
    0,
    12.5,
    1e-18,
    "0",
    "1000000000000",
    "123456789.123456789123456789",
  ])
    assert.equal(validAmount(amount), true, String(amount));
});
test("currency totals preserve 18 decimal places and large aggregates", () => {
  assert.equal(sumAmounts(["0.1", "0.2", 0.3]), "0.6");
  assert.equal(
    sumAmounts(["123456789.123456789123456789", "0.000000000000000001"]),
    "123456789.12345678912345679",
  );
  assert.equal(
    formatAmount(sumAmounts(Array(20).fill("1000000000000")), "BTREE", "en-US"),
    "20,000,000,000,000 BTREE",
  );
  assert.equal(sumAmounts([]), "0");
});
test("fiat displays conventional minimum digits while retaining exact fractions", () => {
  assert.equal(formatAmount("12.5", "EUR", "en-US"), "12.50 EUR");
  assert.equal(formatAmount(1200, "JPY", "en-US"), "1,200 JPY");
  assert.equal(
    formatAmount("1234.123456789123456789", "BIT", "de-DE"),
    "1.234,123456789123456789 BIT",
  );
});
