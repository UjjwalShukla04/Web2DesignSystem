import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, costOf, createUsageTracker, loadLimits, prices, QuotaError } from "../src/usage.js";

test("cost is estimated from tokens and the price table", () => {
  // Default OpenAI price: $2.50 in / $10 out per 1M tokens.
  assert.deepEqual(costOf("openai", 10_000, 2_000), { inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.045 });
  assert.equal(costOf("gemini", 1_000_000, 0).costUsd, prices().gemini.input);
  assert.deepEqual(addUsage(costOf("openai", 1000, 0), costOf("openai", 0, 1000)), { inputTokens: 1000, outputTokens: 1000, costUsd: 0.0125 });
});

test("prices and limits can be configured, with safe defaults", () => {
  assert.deepEqual(prices({ OPENAI_PRICE_INPUT: "5", OPENAI_PRICE_OUTPUT: "15" }).openai, { input: 5, output: 15 });
  assert.deepEqual(prices({ OPENAI_PRICE_INPUT: "-1", OPENAI_PRICE_OUTPUT: "abc" }).openai, { input: 2.5, output: 10 });
  assert.deepEqual(loadLimits({}), { perUserPerDay: 50, dailyBudgetUsd: 0 });
  assert.deepEqual(loadLimits({ DAILY_GENERATIONS_PER_USER: "0", DAILY_BUDGET_USD: "3.5" }), { perUserPerDay: 0, dailyBudgetUsd: 3.5 });
});

test("per-user daily limit, counted per user", () => {
  const tracker = createUsageTracker({ perUserPerDay: 2, dailyBudgetUsd: 0 });
  tracker.reserve("a");
  tracker.reserve("a");
  assert.throws(() => tracker.reserve("a"), QuotaError);
  tracker.reserve("b"); // other users are unaffected
  tracker.release("a"); // a failed request is given back
  tracker.reserve("a");
  assert.equal(tracker.summary("a").remaining, 0);
  assert.equal(tracker.summary("b").remaining, 1);
});

test("daily budget stops server-key use for everyone once spent", () => {
  const tracker = createUsageTracker({ perUserPerDay: 0, dailyBudgetUsd: 0.05 });
  tracker.reserve("a");
  tracker.record("a", costOf("openai", 10_000, 2_000)); // $0.045
  tracker.reserve("b");
  tracker.record("b", costOf("openai", 10_000, 2_000)); // now $0.09
  assert.throws(() => tracker.reserve("c"), /daily AI budget is used up/);
  assert.equal(tracker.summary("c").budgetExhausted, true);
  assert.equal(tracker.summary("a").costUsd, 0.045, "each user sees only their own spend");
  assert.equal(tracker.summary("a").remaining, null, "no per-user limit configured");
});

test("counters reset at midnight UTC", () => {
  let now = new Date("2026-09-27T23:59:00Z");
  const tracker = createUsageTracker({ perUserPerDay: 1, dailyBudgetUsd: 0 }, () => now);
  tracker.reserve("a");
  assert.throws(() => tracker.reserve("a"), QuotaError);
  now = new Date("2026-09-28T00:01:00Z");
  tracker.reserve("a");
  assert.equal(tracker.summary("a").day, "2026-09-28");
});
