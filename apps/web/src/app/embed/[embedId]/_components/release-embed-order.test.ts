import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const traced = vi.hoisted(() => ({
  calls: [] as Array<{ label: string; error: unknown }>,
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError:
    (label: string, expected?: (err: unknown) => boolean) =>
    (error: unknown) => {
      if (expected?.(error)) return;
      traced.calls.push({ label, error });
    },
}));

import { RELEASE_ORDER_TIMEOUT_MS } from "./embed-request-timeouts";
import { releaseEmbedOrder } from "./release-embed-order";

/**
 * One release of one order (`embeds.releaseGuestOrder`): one call, one
 * bounded wait, never a rejection, and nothing of the request in a trace.
 *
 * The refusals are in the shape the server sends them: a TRPCClientError
 * with `data.code` (the tRPC code) and `data.appCode` (see `appCodeToTrpc`
 * and the error formatter in packages/transport/trpc/src/utils.ts).
 */

const SECRET = "pi_3Abc_secret_s3cr3tV4lue";

const refusal = (code: string, appCode?: string) =>
  Object.assign(new Error(appCode ?? code), {
    data: { code, ...(appCode ? { appCode } : {}) },
  });

beforeEach(() => {
  vi.useFakeTimers();
  traced.calls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("releaseEmbedOrder — the server's answer", () => {
  it.each(["released", "gone", "kept"] as const)(
    "'%s' is passed on as it came, from one call",
    async (outcome) => {
      const send = vi.fn(async () => ({ outcome, orderId: "order-1" }));

      await expect(releaseEmbedOrder(send)).resolves.toBe(outcome);

      expect(send).toHaveBeenCalledTimes(1);
      expect(traced.calls).toEqual([]);
    },
  );

  it("an answer this build does not know is not read as 'released'", async () => {
    const send = vi.fn(
      async () => ({ outcome: "archived", orderId: "order-1" }) as never,
    );

    await expect(releaseEmbedOrder(send)).resolves.toBe("unanswered");
  });
});

describe("releaseEmbedOrder — a call that fails", () => {
  it.each([
    ["the page may not host this embed", refusal("FORBIDDEN", "EMBED_ORIGIN_NOT_ALLOWED"), "EMBED_ORIGIN_NOT_ALLOWED"],
    ["no such embed", refusal("NOT_FOUND", "EMBED_NOT_FOUND"), "EMBED_NOT_FOUND"],
    ["the endpoint's budget is spent", refusal("TOO_MANY_REQUESTS"), "TOO_MANY_REQUESTS"],
    ["a server error", refusal("INTERNAL_SERVER_ERROR"), "INTERNAL_SERVER_ERROR"],
    ["a malformed input", refusal("BAD_REQUEST"), "BAD_REQUEST"],
    ["an unrecognised thrown value", new Error("boom"), "no code"],
  ])(
    "%s → 'unanswered', never a rejection, no second call, traced by its kind alone",
    async (_what, error, kind) => {
      const send = vi.fn(async () => {
        throw error;
      });

      await expect(releaseEmbedOrder(send)).resolves.toBe("unanswered");

      expect(send).toHaveBeenCalledTimes(1);
      expect(traced.calls).toHaveLength(1);
      expect(traced.calls[0]?.label).toBe("embed.releaseOrderFailed");
      // A fresh Error, not the one the call threw.
      expect(traced.calls[0]?.error).not.toBe(error);
      expect((traced.calls[0]?.error as Error).message).toBe(
        `embeds.releaseGuestOrder failed: ${kind}`,
      );
    },
  );

  it.each([
    ["the order's own budget is spent", refusal("TOO_MANY_REQUESTS", "RATE_LIMITED")],
    ["not this embed's order, or made before the binding", refusal("CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH")],
    ["a lost connection", new TypeError("Failed to fetch")],
    [
      "a lost connection wrapped by the tRPC client",
      Object.assign(new Error("fetch failed"), {
        cause: new TypeError("Failed to fetch"),
      }),
    ],
  ])(
    "%s → 'unanswered' and NOT traced (expected)",
    async (_what, error) => {
      const send = vi.fn(async () => {
        throw error;
      });

      await expect(releaseEmbedOrder(send)).resolves.toBe("unanswered");

      expect(send).toHaveBeenCalledTimes(1);
      expect(traced.calls).toHaveLength(0);
    },
  );

  it.each([
    ["Failed to fetch"],
    ["NetworkError when attempting to fetch resource."],
    ["Load failed"],
    ["fetch failed"],
  ])("the network message %j is not traced, bare or as a cause", async (message) => {
    for (const error of [
      new TypeError(message),
      Object.assign(new Error("wrapped"), { cause: new TypeError(message) }),
    ]) {
      await releaseEmbedOrder(async () => {
        throw error;
      });
    }
    expect(traced.calls).toHaveLength(0);
  });

  it("a TypeError that is our own bug is still traced, bare or as a cause", async () => {
    for (const error of [
      new TypeError("x is not a function"),
      Object.assign(new Error("wrapped"), {
        cause: new TypeError("x is not a function"),
      }),
    ]) {
      await releaseEmbedOrder(async () => {
        throw error;
      });
    }
    expect(traced.calls).toHaveLength(2);
  });

  it("an app code with the wrong tRPC code is still traced", async () => {
    await releaseEmbedOrder(async () => {
      throw refusal("INTERNAL_SERVER_ERROR", "RATE_LIMITED");
    });
    expect(traced.calls).toHaveLength(1);
  });

  it("a TypeError that carries a server answer (data) is still traced", async () => {
    const error = Object.assign(new TypeError("odd"), {
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
    await releaseEmbedOrder(async () => {
      throw error;
    });
    expect(traced.calls.map((c) => c.label)).toEqual([
      "embed.releaseOrderFailed",
    ]);
  });

  it("a send that throws before it returns a promise is the same failure", async () => {
    const send = vi.fn(() => {
      throw new Error("no client");
    });

    await expect(releaseEmbedOrder(send)).resolves.toBe("unanswered");
    expect(traced.calls.map((call) => call.label)).toEqual([
      "embed.releaseOrderFailed",
    ]);
  });

  it("nothing of the request reaches a trace: not the client secret, not the error that carried it", async () => {
    // An error that quotes the request, as a transport error can.
    const error = Object.assign(
      new Error(`POST failed for {"clientSecret":"${SECRET}"}`),
      {
        data: { code: SECRET },
        meta: { body: { clientSecret: SECRET } },
        cause: new Error(SECRET),
      },
    );
    const send = vi.fn(async () => {
      throw error;
    });

    await releaseEmbedOrder(send);

    const [call] = traced.calls;
    const reported = call?.error as Error & { cause?: unknown };
    expect(reported.message).toBe("embeds.releaseGuestOrder failed: no code");
    expect(reported.cause).toBeUndefined();
    expect(`${reported.message} ${reported.stack ?? ""}`).not.toContain(
      "s3cr3tV4lue",
    );
    expect(JSON.stringify(traced.calls)).not.toContain("s3cr3tV4lue");
  });
});

describe("releaseEmbedOrder — a call nobody answers", () => {
  it(`stops waiting after ${RELEASE_ORDER_TIMEOUT_MS / 1000} s: 'unanswered', one call, and a trace that says so`, async () => {
    const send = vi.fn(() => new Promise<never>(() => undefined));
    let outcome: string | null = null;
    void releaseEmbedOrder(send).then((result) => {
      outcome = result;
    });

    await vi.advanceTimersByTimeAsync(RELEASE_ORDER_TIMEOUT_MS - 1);
    expect(outcome).toBeNull();

    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBe("unanswered");
    expect(send).toHaveBeenCalledTimes(1);
    expect(traced.calls.map((call) => call.label)).toEqual([
      "embed.releaseOrderTimedOut",
    ]);
  });

  it.each(["released", "gone", "kept"] as const)(
    "the server answers '%s' after the wait → handed to onLateAnswer, once, after 'unanswered' was returned",
    async (outcome) => {
      let answer: (result: { outcome: typeof outcome; orderId: string }) => void =
        () => undefined;
      const send = vi.fn(
        () =>
          new Promise<{ outcome: typeof outcome; orderId: string }>((resolve) => {
            answer = resolve;
          }),
      );
      const onLateAnswer = vi.fn();
      const release = releaseEmbedOrder(send, { onLateAnswer });
      await vi.advanceTimersByTimeAsync(RELEASE_ORDER_TIMEOUT_MS);
      await expect(release).resolves.toBe("unanswered");
      expect(onLateAnswer).not.toHaveBeenCalled();

      answer({ outcome, orderId: "order-1" });
      await vi.advanceTimersByTimeAsync(0);

      expect(onLateAnswer.mock.calls).toEqual([[outcome]]);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("an answer inside the wait is returned, and never handed over a second time as late", async () => {
    const onLateAnswer = vi.fn();
    const send = vi.fn(async () => ({
      outcome: "released" as const,
      orderId: "order-1",
    }));

    await expect(releaseEmbedOrder(send, { onLateAnswer })).resolves.toBe(
      "released",
    );
    await vi.advanceTimersByTimeAsync(RELEASE_ORDER_TIMEOUT_MS * 2);

    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("a call that fails after the wait hands nothing over: a failure is never 'released'", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const onLateAnswer = vi.fn();
    const release = releaseEmbedOrder(send, { onLateAnswer });
    await vi.advanceTimersByTimeAsync(RELEASE_ORDER_TIMEOUT_MS);
    await release;

    fail(refusal("CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH"));
    await vi.advanceTimersByTimeAsync(0);

    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("an answer that comes after the wait is not waited for, and a late failure is still traced by its kind", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const release = releaseEmbedOrder(send);
    await vi.advanceTimersByTimeAsync(RELEASE_ORDER_TIMEOUT_MS);
    await expect(release).resolves.toBe("unanswered");

    fail(refusal("TOO_MANY_REQUESTS"));
    await vi.advanceTimersByTimeAsync(0);

    expect(traced.calls.map((call) => call.label)).toEqual([
      "embed.releaseOrderTimedOut",
      "embed.releaseOrderFailed",
    ]);
  });
});
