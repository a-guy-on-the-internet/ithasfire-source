import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearStripeRedirectParams,
  readStripeRedirectParams,
  redirectPaymentIntentId,
} from "./stripe-redirect-return";

// gitleaks:allow (fake test fixture)
const FAKE_SECRET = "pi_3Abc_secret_FakeFixtureNotReal";

describe("redirectPaymentIntentId — a client secret is never an id", () => {
  it("accepts ids with underscores", () => {
    expect(redirectPaymentIntentId("pi_3Abc_def", null)).toBe("pi_3Abc_def");
  });

  it("refuses a client secret in the payment_intent param, and derives the id from the secret instead", () => {
    expect(redirectPaymentIntentId(FAKE_SECRET, null)).toBeNull();
    expect(redirectPaymentIntentId(FAKE_SECRET, FAKE_SECRET)).toBe("pi_3Abc");
  });

  it("the params reader never surfaces a secret as paymentIntentId", () => {
    const read = readStripeRedirectParams(
      new URLSearchParams({ payment_intent: FAKE_SECRET }),
    );
    expect(read?.paymentIntentId).toBeNull();
  });
});

// The replay in clearStripeRedirectParams models next 16.3.0-preview.8's
// App Router: its `Router` effect patches `history.replaceState` (and copies
// `__NA` into every state it writes), and that effect can run AFTER the
// embed's. Re-check these when bumping Next.
describe("clearStripeRedirectParams — tells the App Router once it is listening", () => {
  const RETURN_URL = `/embed/embed-1?view=list&payment_intent=pi_r&payment_intent_client_secret=${FAKE_SECRET}&redirect_status=succeeded`;
  const nativeReplaceState = window.history.replaceState.bind(window.history);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    nativeReplaceState(null, "", "/");
  });

  it("an unpatched call (no __NA after it) is replayed exactly once, through the router's patch", () => {
    nativeReplaceState(null, "", RETURN_URL);
    clearStripeRedirectParams();
    expect(window.location.search).toBe("?view=list");
    expect(window.history.state).toBeNull();

    // The router's effect runs now and patches replaceState.
    const patched = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation((data, unused, url) => {
        nativeReplaceState({ ...(data ?? {}), __NA: true }, unused, url);
      });
    vi.runAllTimers();

    expect(patched).toHaveBeenCalledTimes(1);
    expect(patched).toHaveBeenCalledWith(null, "", window.location.href);
    expect(window.location.search).toBe("?view=list");
    // Nothing further is queued: one replay, not a loop.
    vi.runAllTimers();
    expect(patched).toHaveBeenCalledTimes(1);
  });

  it("a patched call (the router copied __NA over) is not replayed", () => {
    nativeReplaceState({ __NA: true }, "", RETURN_URL);
    const patched = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation((data, unused, url) => {
        const current = window.history.state as { __NA?: unknown } | null;
        nativeReplaceState({ ...(data ?? {}), __NA: current?.__NA }, unused, url);
      });

    clearStripeRedirectParams();
    expect(patched).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?view=list");
    vi.runAllTimers();
    expect(patched).toHaveBeenCalledTimes(1);
  });

  it("a URL without Stripe's params is left alone", () => {
    nativeReplaceState(null, "", "/embed/embed-1?view=list");
    const spy = vi.spyOn(window.history, "replaceState");
    clearStripeRedirectParams();
    vi.runAllTimers();
    expect(spy).not.toHaveBeenCalled();
  });
});
