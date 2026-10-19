/**
 * `fetchWithInstrumentation`: a fetch that throws is a Sentry issue, unless the
 * app aborted the request itself (a time limit, `lib/with-timeout.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock("@sentry/react-native", () => ({
  captureException: sentry.captureException,
  captureMessage: vi.fn(),
  addBreadcrumb: sentry.addBreadcrumb,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("./config/api", () => ({
  getTrpcHttpUrl: () => "http://scanner.test/trpc",
  getApiBaseUrl: () => "http://scanner.test",
}));

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { fetchWithInstrumentation } from "./trpc";

const URL_ = "http://scanner.test/trpc/tickets.scanTicket";
const abortError = () =>
  Object.assign(new Error("Aborted"), { name: "AbortError" });

beforeEach(() => {
  sentry.captureException.mockReset();
  sentry.addBreadcrumb.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a fetch that throws", () => {
  it("is reported as a network failure", async () => {
    const failure = new TypeError("Network request failed");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(failure)));

    await expect(fetchWithInstrumentation(URL_, { method: "POST" })).rejects.toBe(failure);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0]?.[1]?.tags).toEqual({
      fetch_failure: "network",
    });
  });

  it("aborted by the app: a breadcrumb, not an issue", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw abortError();
      }),
    );

    await expect(
      fetchWithInstrumentation(URL_, { method: "POST", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "fetch", level: "info" }),
    );
  });

  it("an AbortError without a signal on the call is not reported either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortError())));

    await expect(fetchWithInstrumentation(URL_)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
