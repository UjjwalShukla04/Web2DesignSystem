import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/cache.js";

function setup(ttlMs = 1000, maxEntries = 2) {
  let clock = 0;
  const cache = createCache<string>({ ttlMs, maxEntries, now: () => clock });
  let runs = 0;
  const produce = (value: string) => async () => {
    runs++;
    return value;
  };
  return { cache, produce, advance: (ms: number) => (clock += ms), runs: () => runs };
}

test("reuses a result within the TTL and reports it as cached", async () => {
  const { cache, produce, runs } = setup();
  const first = await cache.get("a", produce("A"));
  const second = await cache.get("a", produce("A2"));
  assert.deepEqual([first.value, first.cached], ["A", false]);
  assert.deepEqual([second.value, second.cached], ["A", true]);
  assert.equal(runs(), 1);
});

test("expired results are produced again", async () => {
  const { cache, produce, advance, runs } = setup(1000);
  await cache.get("a", produce("A"));
  advance(1001);
  const again = await cache.get("a", produce("A2"));
  assert.deepEqual([again.value, again.cached], ["A2", false]);
  assert.equal(runs(), 2);
});

test("fresh bypasses the cache and replaces the entry", async () => {
  const { cache, produce, runs } = setup();
  await cache.get("a", produce("A"));
  const fresh = await cache.get("a", produce("A2"), { fresh: true });
  assert.deepEqual([fresh.value, fresh.cached], ["A2", false]);
  assert.equal((await cache.get("a", produce("A3"))).value, "A2");
  assert.equal(runs(), 2);
});

test("identical requests in flight share one run", async () => {
  const { cache, runs } = setup();
  let calls = 0;
  let release!: (v: string) => void;
  const slow = () => {
    calls++;
    return new Promise<string>((resolve) => (release = resolve));
  };
  const one = cache.get("a", slow);
  const two = cache.get("a", slow);
  release("A");
  assert.deepEqual((await Promise.all([one, two])).map((r) => r.value), ["A", "A"]);
  assert.equal(calls, 1);
  assert.equal(runs(), 0);
});

test("failures are not cached", async () => {
  const { cache, produce } = setup();
  await assert.rejects(cache.get("a", async () => { throw new Error("boom"); }), /boom/);
  assert.equal((await cache.get("a", produce("A"))).cached, false);
});

test("keeps at most maxEntries, evicting the least recently used", async () => {
  const { cache, produce, runs } = setup(10_000, 2);
  await cache.get("a", produce("A"));
  await cache.get("b", produce("B"));
  await cache.get("a", produce("A")); // touch a: b is now least recently used
  await cache.get("c", produce("C")); // evicts b
  assert.equal(cache.size, 2);
  assert.equal((await cache.get("a", produce("A"))).cached, true);
  assert.equal((await cache.get("b", produce("B"))).cached, false);
  assert.equal(runs(), 4);
});

test("a TTL of 0 disables caching", async () => {
  const { cache, produce, runs } = setup(0);
  await cache.get("a", produce("A"));
  await cache.get("a", produce("A"));
  assert.equal(runs(), 2);
  assert.equal(cache.size, 0);
});
