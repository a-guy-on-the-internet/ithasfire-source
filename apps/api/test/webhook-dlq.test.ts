import { describe, expect, it, vi } from "vitest";

import { WebhookDlq } from "../src/lib/webhook-dlq";

// ioredis's exec() resolves instead of rejecting on failure: per-command
// errors arrive as `[err, result]` tuples and an aborted MULTI resolves null.
// A Stripe event whose DLQ write failed must not look stored.

const item = {
  stripeEventId: "evt_123",
  eventType: "charge.refunded",
  payload: '{"secret":"s3cr3t"}',
  error: "boom",
  receivedAt: "2026-10-07T12:00:00.000Z",
};

function fakeRedis(exec: () => Promise<unknown>, opts: { count?: number } = {}) {
  const multi = {
    hset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zrem: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn(exec),
  };
  const redis = {
    multi: vi.fn(() => multi),
    zcard: vi.fn(async () => opts.count ?? 1),
    zrange: vi.fn(async () => ["evt_old"]),
  };
  return { redis: redis as any, multi };
}

const tupleError = () => [
  [
    Object.assign(new Error("OOM command not allowed"), {
      command: { name: "hset", args: ["webhook_dlq:event:evt_123", item.payload] },
    }),
    null,
  ],
  [null, 1],
  [null, 1],
];

async function caught(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!;
}

describe("WebhookDlq.push", () => {
  it("resolves when the write succeeded", async () => {
    const { redis, multi } = fakeRedis(async () => [
      [null, 5],
      [null, 1],
      [null, 1],
    ]);
    await expect(new WebhookDlq(redis).push(item)).resolves.toBeUndefined();
    expect(multi.hset).toHaveBeenCalledWith(
      "webhook_dlq:event:evt_123",
      expect.objectContaining({ stripeEventId: "evt_123", payload: item.payload }),
    );
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("rejects when exec resolves null (transaction aborted)", async () => {
    const { redis } = fakeRedis(async () => null);
    await expect(new WebhookDlq(redis).push(item)).rejects.toThrow(
      /^redis webhook dlq push aborted \(keyHash=[0-9a-f]{12}\)$/,
    );
    expect(redis.zcard).not.toHaveBeenCalled();
  });

  it("rejects on an error tuple without leaking the event payload", async () => {
    const { redis } = fakeRedis(async () => tupleError());
    const err = await caught(new WebhookDlq(redis).push(item));
    expect(err.message).toMatch(
      /^redis webhook dlq push failed at command 0 \[OOM\] \(keyHash=[0-9a-f]{12}\)$/,
    );
    expect(JSON.stringify(err) + err.message).not.toContain("s3cr3t");
  });

  it("resolves and reports (step dlq_trim) when only the trim MULTI fails", async () => {
    const { redis, multi } = fakeRedis(async () => [[null, 1]], { count: 501 });
    multi.exec
      .mockResolvedValueOnce([
        [null, 5],
        [null, 1],
        [null, 1],
      ])
      .mockResolvedValueOnce(null);
    const reportError = vi.fn();
    await expect(new WebhookDlq(redis, reportError).push(item)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect((err as Error).message).toMatch(/^redis webhook dlq trim aborted/);
    expect(ctx).toMatchObject({ tags: { step: "dlq_trim" } });
  });

  it("still resolves when the trim fails and there is no or a throwing reporter", async () => {
    for (const reporter of [undefined, () => { throw new Error("down"); }]) {
      const { redis, multi } = fakeRedis(async () => [[null, 1]], { count: 501 });
      multi.exec
        .mockResolvedValueOnce([[null, 5], [null, 1], [null, 1]])
        .mockResolvedValueOnce(null);
      await expect(new WebhookDlq(redis, reporter).push(item)).resolves.toBeUndefined();
    }
  });
});

describe("WebhookDlq.remove", () => {
  it("resolves when both commands succeeded", async () => {
    const { redis, multi } = fakeRedis(async () => [
      [null, 1],
      [null, 1],
    ]);
    await expect(new WebhookDlq(redis).remove("evt_123")).resolves.toBeUndefined();
    expect(multi.del).toHaveBeenCalledWith("webhook_dlq:event:evt_123");
    expect(multi.zrem).toHaveBeenCalledWith("webhook_dlq:index", "evt_123");
  });

  it("rejects when exec resolves null", async () => {
    const { redis } = fakeRedis(async () => null);
    await expect(new WebhookDlq(redis).remove("evt_123")).rejects.toThrow(
      /^redis webhook dlq remove aborted/,
    );
  });

  it("rejects on an error tuple", async () => {
    const { redis } = fakeRedis(async () => [
      [new Error("WRONGTYPE Operation against a key"), null],
      [null, 1],
    ]);
    await expect(new WebhookDlq(redis).remove("evt_123")).rejects.toThrow(
      /^redis webhook dlq remove failed at command 0 \[WRONGTYPE\]/,
    );
  });
});
