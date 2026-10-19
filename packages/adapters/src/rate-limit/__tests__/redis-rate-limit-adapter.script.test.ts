import { describe, expect, it, vi } from "vitest";

import {
  CONSUME_SCRIPT,
  RedisRateLimitAdapter,
} from "../redis-rate-limit-adapter";

/**
 * A guard on the Lua TEXT, not a substitute for the integration test.
 *
 * The property: an ALLOWED hit issues only INCR (plus EXPIRE on a brand-new
 * key); TTL runs only when the key is over max. Upstash bills every
 * `redis.call` inside the EVAL, so a TTL back on the allowed path silently
 * raises the cost of every request (see the billing note on CONSUME_SCRIPT).
 *
 * Neither other test catches that in CI: the unit test's fake `eval` is a JS
 * re-implementation that ignores the script, and the integration test, which
 * runs the real Lua, is `skipIf(CI)`. So this reads the exported string and
 * checks which commands sit inside the `count > max` branch. It proves
 * nothing about what the script DOES at runtime; that is the integration
 * test's job.
 */

/** Every `redis.call('X', …)` / `redis.pcall('X', …)` with its offset. */
const redisCalls = (script: string) =>
  [...script.matchAll(/redis\.p?call\(\s*['"]([A-Za-z]+)['"]/g)].map((m) => ({
    command: m[1]!.toUpperCase(),
    index: m.index!,
  }));

/**
 * [start, end) of the body of the `count > max` branch: from just after its
 * `then` to the `elseif` / `else` / `end` that closes it at the same depth.
 * Lua block openers here are `if`, `for`, `while`, `function`, `repeat`.
 */
const denyBranchRange = (script: string): [number, number] => {
  const head = /\b(?:else)?if\s+count\s*>\s*max\s+then\b/.exec(script);
  if (!head) {
    throw new Error(
      "CONSUME_SCRIPT has no `count > max` branch; update this guard to match the new script",
    );
  }
  const start = head.index + head[0].length;
  const token = /\b(if|for|while|function|repeat|elseif|else|end|until)\b/g;
  token.lastIndex = start;
  let depth = 0;
  for (let m = token.exec(script); m; m = token.exec(script)) {
    const word = m[1];
    if (word === "if" || word === "for" || word === "while" || word === "function" || word === "repeat") {
      depth += 1;
    } else if (word === "end" || word === "until") {
      if (depth === 0) return [start, m.index];
      depth -= 1;
    } else if (depth === 0) {
      // `elseif` / `else` of the same chain closes the deny branch.
      return [start, m.index];
    }
  }
  throw new Error("unterminated `count > max` branch in CONSUME_SCRIPT");
};

describe("CONSUME_SCRIPT text (billing guard)", () => {
  const [denyStart, denyEnd] = denyBranchRange(CONSUME_SCRIPT);
  const calls = redisCalls(CONSUME_SCRIPT);
  const inDeny = (i: number) => i >= denyStart && i < denyEnd;

  it("finds the redis calls it is guarding (the parser still matches)", () => {
    expect(calls.map((c) => c.command)).toEqual(
      expect.arrayContaining(["INCR", "EXPIRE", "TTL"]),
    );
  });

  it("calls TTL only inside the `count > max` (deny) branch", () => {
    const ttlCalls = calls.filter((c) => c.command === "TTL" || c.command === "PTTL");
    expect(ttlCalls.length).toBeGreaterThan(0);
    for (const call of ttlCalls) {
      expect(inDeny(call.index), `TTL at offset ${call.index}`).toBe(true);
    }
  });

  it("issues only INCR / EXPIRE outside the deny branch", () => {
    const outside = calls.filter((c) => !inDeny(c.index)).map((c) => c.command);
    expect(outside.length).toBeGreaterThan(0);
    expect([...new Set(outside)].sort()).toEqual(["EXPIRE", "INCR"]);
  });

  it("is the script the adapter actually sends", async () => {
    const redis = { eval: vi.fn(async () => [1, 60]) };
    await new RedisRateLimitAdapter(redis as never).consume("k", 5, 60);
    expect(redis.eval.mock.calls[0]?.[0]).toBe(CONSUME_SCRIPT);
  });
});

describe("the guard's own parser", () => {
  it("would catch a TTL moved onto the allowed path", () => {
    const regressed = CONSUME_SCRIPT.replace(
      "local ttl = 0",
      "local ttl = redis.call('TTL', key)",
    );
    expect(regressed).not.toBe(CONSUME_SCRIPT);
    const [s, e] = denyBranchRange(regressed);
    const leaked = redisCalls(regressed).filter(
      (c) => c.command === "TTL" && !(c.index >= s && c.index < e),
    );
    expect(leaked).toHaveLength(1);
  });
});
