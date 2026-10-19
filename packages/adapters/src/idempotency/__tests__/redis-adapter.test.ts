import { describe, it, expect, vi } from "vitest";
import { RedisIdempotency } from "../redis-adapter";
import { redisKeyHash } from "../../redis/exec-or-throw";
import type { LoggerPort } from "@th/ports/logger";

function createMockLogger(): LoggerPort {
  return {
    child: vi.fn(() => createMockLogger()),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("RedisIdempotency", () => {
  it("get returns null when stored JSON is malformed", async () => {
    const fakeRedis: any = {
      get: vi
        .fn()
        // first call: status key => 'succeeded'
        .mockResolvedValueOnce("succeeded")
        // second call: result key => malformed json
        .mockResolvedValueOnce("{ not-json"),
    };

    const id = new RedisIdempotency(fakeRedis as any, "test");
    const res = await id.get("somekey");
    expect(res).toBeNull();
    expect(fakeRedis.get).toHaveBeenCalledTimes(2);
  });

  it("logs warning when stored JSON is malformed", async () => {
    const fakeRedis: any = {
      get: vi
        .fn()
        .mockResolvedValueOnce("succeeded")
        .mockResolvedValueOnce("{ not-valid-json"),
    };
    const logger = createMockLogger();

    const id = new RedisIdempotency(fakeRedis as any, "test", logger);
    const res = await id.get("mykey");

    expect(res).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "idempotency_malformed_json",
      expect.objectContaining({
        key: "mykey",
        namespace: "test",
        rawValue: "{ not-valid-json",
      }),
    );
  });

  it("run commits and returns fresh result", async () => {
    const setMock = vi.fn(async () => "OK");
    const execMock = vi.fn(async () => [
      [null, "OK"],
      [null, "OK"],
    ]);

    const fakeRedis: any = {
      set: setMock,
      get: vi.fn(async (k: string) => null),
      multi: () => ({ set: vi.fn().mockReturnThis(), exec: execMock }),
    };

    const id = new RedisIdempotency(fakeRedis as any, "test");
    const { fresh, result } = await id.run(
      "rk",
      60,
      async () => ({ ok: true }),
      60,
    );
    expect(fresh).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(fakeRedis.set).toHaveBeenCalled();
  });
});

describe("RedisIdempotency.status (read-only, never claims)", () => {
  it.each([
    [null, null],
    ["in_progress", "in_progress"],
    ["in_progress:owner-abc", "in_progress"],
    ["succeeded", "succeeded"],
    ["failed:boom", "failed"],
  ])("maps stored %s to %s", async (stored, expected) => {
    const fakeRedis: any = { get: vi.fn().mockResolvedValue(stored), set: vi.fn() };
    const id = new RedisIdempotency(fakeRedis, "test");
    await expect(id.status("k")).resolves.toBe(expected);
    expect(fakeRedis.get).toHaveBeenCalledWith("idem:test:k");
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});

// ioredis's exec() resolves instead of rejecting on failure: per-command
// errors arrive as `[err, result]` tuples and an aborted MULTI resolves null.
// commit must turn both into a rejection, or callers think the write landed.
describe("RedisIdempotency.commit (exec failures reject)", () => {
  function fakeRedisWithExec(exec: () => Promise<unknown>) {
    const multi = { set: vi.fn().mockReturnThis(), exec: vi.fn(exec) };
    return { redis: { multi: vi.fn(() => multi) } as any, multi };
  }

  it("resolves when every queued command succeeded", async () => {
    const { redis, multi } = fakeRedisWithExec(async () => [
      [null, "OK"],
      [null, "OK"],
    ]);
    const id = new RedisIdempotency(redis, "test");

    await expect(id.commit("ck", { ok: true }, 60)).resolves.toBeUndefined();
    expect(multi.set).toHaveBeenNthCalledWith(1, "idem:test:ck", "succeeded", "EX", 60);
    expect(multi.set).toHaveBeenNthCalledWith(2, "idemres:test:ck", '{"ok":true}', "EX", 60);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("rejects when exec resolves null (transaction aborted)", async () => {
    const { redis } = fakeRedisWithExec(async () => null);
    const id = new RedisIdempotency(redis, "test");

    await expect(id.commit("ck", { secret: "s3cr3t" })).rejects.toThrow(
      `redis idempotency commit aborted (keyHash=${redisKeyHash("ck")})`,
    );
  });

  it("rejects when a queued command carries an error, naming op and key hash but not the value", async () => {
    const cmdErr = new Error("OOM command not allowed");
    const { redis } = fakeRedisWithExec(async () => [
      [null, "OK"],
      [cmdErr, null],
    ]);
    const id = new RedisIdempotency(redis, "test");

    const err = await id.commit("ck", { secret: "s3cr3t" }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(
      `redis idempotency commit failed at command 1 [OOM] (keyHash=${redisKeyHash("ck")})`,
    );
    expect(err!.message).not.toContain("s3cr3t");
  });

  it("run marks the key failed and rethrows when the commit write fails", async () => {
    const multi = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[new Error("x"), null], [null, "OK"]]),
    };
    const setMock = vi.fn(async () => "OK");
    const redis: any = { set: setMock, multi: vi.fn(() => multi) };
    const id = new RedisIdempotency(redis, "test");

    await expect(id.run("rk", 60, async () => ({ ok: true }))).rejects.toThrow(
      "redis idempotency commit failed",
    );
    // begin (SET NX) then fail (SET failed:...) — the failed commit is not silent.
    expect(setMock).toHaveBeenLastCalledWith(
      "idem:test:rk",
      expect.stringMatching(/^failed:redis idempotency commit failed/),
      "EX",
      900,
    );
  });
});
