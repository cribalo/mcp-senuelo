// Unit test for the D1 cache behind /stats.json (src/stats.ts), with a fake D1. No server needed.
// Usage: node scripts/stats-test.mjs   (Node 22.18+ imports the TypeScript directly)
import assert from "node:assert/strict";
import { statsBody } from "../src/stats.ts";

const kv = new Map();
const DB = {
  prepare(sql) {
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async first() {
        assert.match(sql, /FROM kv WHERE key = 'stats'/);
        return kv.get("stats") ?? null;
      },
      async run() {
        assert.match(sql, /INSERT INTO kv/);
        kv.set("stats", { value: args[0], updated_at: args[1] });
      }
    };
  }
};
let computed = 0;
const fake = async () => ({ generated_at: `run-${++computed}`, totals: { requests: 7 } });
const env = { DB };
const t0 = Date.parse("2026-11-10T10:00:00Z");

const a = await statsBody(env, t0, fake);
const b = await statsBody(env, t0 + 60_000, fake);
assert.equal(computed, 1, "two requests within 5 minutes compute once");
assert.equal(a, b, "the second request gets the stored body unchanged");
assert.deepEqual(JSON.parse(a), { generated_at: "run-1", totals: { requests: 7 } });

await statsBody(env, t0 + 301_000, fake);
assert.equal(computed, 2, "after 5 minutes it recomputes");

// A broken kv table must not break /stats.json.
let c2 = 0;
const broken = { DB: { prepare: () => ({ bind() { return this; }, first: async () => { throw new Error("no such table: kv"); }, run: async () => { throw new Error("no such table: kv"); } }) } };
const body = await statsBody(broken, t0, async () => ({ n: ++c2 }));
assert.deepEqual(JSON.parse(body), { n: 1 });
console.log("ok   stats cache: 4 checks");
