import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RequestTimeoutError,
  isRequestTimeout,
  withTimeout,
} from "./with-timeout";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes an answer through and never aborts", async () => {
    let signal!: AbortSignal;
    const answer = withTimeout((s) => {
      signal = s;
      return Promise.resolve("ok");
    }, 1_000);

    await expect(answer).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.aborted).toBe(false);
  });

  it("passes a failure through unchanged", async () => {
    const failure = new Error("refused");
    const answer = withTimeout(() => Promise.reject(failure), 1_000);

    await expect(answer).rejects.toBe(failure);
  });

  it("a request that never answers is aborted and rejected when the time is up", async () => {
    let signal!: AbortSignal;
    const answer = withTimeout((s) => {
      signal = s;
      return new Promise<never>(() => {});
    }, 20_000);
    const outcome = answer.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await outcome;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(isRequestTimeout(err)).toBe(true);
    expect((err as RequestTimeoutError).timeoutMs).toBe(20_000);
    expect((err as Error).message).toBe("no answer after 20s");
    expect(signal.aborted).toBe(true);
  });

  it("an answer that lands after the time is up changes nothing", async () => {
    let answerLate!: (value: string) => void;
    const answer = withTimeout(
      () =>
        new Promise<string>((resolve) => {
          answerLate = resolve;
        }),
      1_000,
    );
    const outcome = answer.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1_000);
    answerLate("late");

    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it("a request that throws before it starts is a rejection, not a thrown error", async () => {
    const failure = new Error("could not start");
    const answer = withTimeout(() => {
      throw failure;
    }, 1_000);

    await expect(answer).rejects.toBe(failure);
  });

  it("is not a timeout: any other error", () => {
    expect(isRequestTimeout(new Error("no answer after 20s"))).toBe(false);
    expect(isRequestTimeout(null)).toBe(false);
  });
});
