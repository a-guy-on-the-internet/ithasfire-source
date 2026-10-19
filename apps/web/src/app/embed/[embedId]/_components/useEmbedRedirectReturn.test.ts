import { StrictMode, createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RedirectPaymentIntentVerdict } from "@/lib/verify-redirect-payment-intent";

import type { EmbedServerAnswer } from "./embed-payment-status";
import {
  clearPendingMarker,
  hasHeldRedirectReturn,
  heldRedirectReturnKey,
  holdUnconfirmedOrder,
  pendingRedirectKey,
  releaseHeldOrder,
  sweepExpiredHeldRedirectReturns,
  useEmbedRedirectReturn,
  type AskEmbedServer,
} from "./useEmbedRedirectReturn";

describe("clearPendingMarker — an in-page purchase settles the redirect reminder", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("removes this embed's marker and leaves another embed's alone", () => {
    const marker = JSON.stringify({ paymentIntentId: "pi_1", at: Date.now() });
    window.sessionStorage.setItem(pendingRedirectKey("embed-1"), marker);
    window.sessionStorage.setItem(pendingRedirectKey("embed-2"), marker);
    clearPendingMarker("embed-1");
    expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toBeNull();
    expect(window.sessionStorage.getItem(pendingRedirectKey("embed-2"))).toBe(marker);
  });

  it("never throws when storage is blocked", () => {
    const spy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => clearPendingMarker("embed-1")).not.toThrow();
    spy.mockRestore();
  });
});

// The wiring (EmbedWidget's onPaymentSuccess clears it) is covered
// behaviourally in EmbedWidget.test.tsx.

// ─────────────────────────────────────────────────────────────────────────────
// The client secret on Stripe's return URL is the guest's proof of payment
// (the server answers it with door-admission ticket codes), so it leaves the
// URL the moment it is read, on every path, before anything is awaited. The
// return is held in per-embed sessionStorage until it settles or ends on a
// terminal screen; never localStorage.
// ─────────────────────────────────────────────────────────────────────────────

const verify = vi.hoisted(() => ({
  fn: vi.fn<[string | null, unknown], Promise<RedirectPaymentIntentVerdict>>(),
}));
vi.mock("@/lib/verify-redirect-payment-intent", () => ({
  verifyRedirectPaymentIntent: (secret: string | null, opts: unknown) =>
    verify.fn(secret, opts),
}));

// gitleaks:allow (fake test fixture)
const SECRET = "pi_r_secret_FakeFixtureNotReal";
const RETURN = `?payment_intent=pi_r&payment_intent_client_secret=${SECRET}&redirect_status=succeeded`;
const HELD = heldRedirectReturnKey("embed-1");
const MARKER = pendingRedirectKey("embed-1");

const paid = (kind: "succeeded" | "processing" | "live"): RedirectPaymentIntentVerdict => ({
  kind,
  paymentIntentId: "pi_r",
  amountCents: 4250,
  currency: "usd",
});

const urlHoldsSecret = () =>
  /payment_intent|redirect_status|_secret_/.test(window.location.href);
const storageHoldsSecret = () =>
  [window.sessionStorage, window.localStorage].some((store) =>
    Object.keys(store).some((key) => (store.getItem(key) ?? "").includes(SECRET)),
  );
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function mount(
  askServer: AskEmbedServer,
  { strict = false, seeded = true }: { strict?: boolean; seeded?: boolean } = {},
) {
  const onConfirmed = vi.fn();
  const onFailed = vi.fn();
  const view = renderHook(
    () =>
      useEmbedRedirectReturn({
        embedId: "embed-1",
        seeded,
        onConfirmed,
        onFailed,
        askServer,
      }),
    strict
      ? { wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) }
      : undefined,
  );
  return { ...view, onConfirmed, onFailed };
}

const answering = (answer: EmbedServerAnswer) =>
  vi.fn<Parameters<AskEmbedServer>, ReturnType<AskEmbedServer>>(async () => answer);

describe("useEmbedRedirectReturn — the client secret leaves the URL at once", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    verify.fn.mockReset();
    window.history.replaceState(null, "", `/embed/embed-1${RETURN}`);
  });

  it("the URL is clean before Stripe.js is asked and before the first server call", async () => {
    let urlAtVerify: string | null = null;
    let urlAtAsk: string | null = null;
    const askServer = vi.fn<Parameters<AskEmbedServer>, ReturnType<AskEmbedServer>>(async () => {
      urlAtAsk = window.location.search;
      return { outcome: "confirmed", orderId: "order-r" };
    });
    // Stripe.js never answers: what the URL holds before any await settles.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    verify.fn.mockImplementationOnce(async () => {
      urlAtVerify = window.location.search;
      await gate;
      return paid("succeeded");
    });

    const { result } = mount(askServer);
    expect(result.current.state).toBe("verifying");
    expect(urlHoldsSecret()).toBe(false);
    expect(window.location.pathname).toBe("/embed/embed-1");
    // Held for a reload mid-verify, in sessionStorage only.
    expect(window.sessionStorage.getItem(HELD)).toContain(SECRET);
    expect(Object.keys(window.localStorage)).toEqual([]);

    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(urlAtVerify).toBe("");
    expect(urlAtAsk).toBe("");
    expect(askServer).toHaveBeenCalledWith(SECRET, expect.anything());
  });

  it.each<[string, () => void, string | null]>([
    ["confirmed", () => {
      verify.fn.mockResolvedValue(paid("succeeded"));
    }, null],
    ["processing", () => {
      verify.fn.mockResolvedValue(paid("processing"));
    }, null],
    ["paid-unconfirmed (the server says not paid)", () => {
      verify.fn.mockResolvedValue(paid("succeeded"));
    }, "paid-unconfirmed"],
    ["paid-unconfirmed (nobody answered)", () => {
      verify.fn.mockResolvedValue(paid("succeeded"));
    }, "paid-unconfirmed"],
    ["dead", () => {
      verify.fn.mockResolvedValue({ kind: "dead", status: "requires_payment_method" });
    }, null],
    ["live", () => {
      verify.fn.mockResolvedValue(paid("live"));
    }, "unverified"],
    ["unknown", () => {
      verify.fn.mockResolvedValue({ kind: "unknown" });
    }, "unverified"],
  ])("%s → no secret on the URL; in storage only while paid-unconfirmed", async (name, arrange, endState) => {
    arrange();
    const answer: EmbedServerAnswer = name.includes("not paid")
      ? { outcome: "not_paid", orderId: "order-r", paymentIntentStatus: "requires_payment_method" }
      : name.includes("nobody")
        ? { outcome: "unanswered", final: false }
        : name === "processing"
          ? { outcome: "processing", orderId: "order-r" }
          : { outcome: "confirmed", orderId: "order-r" };
    const { result, onConfirmed, onFailed } = mount(answering(answer));
    await flush();

    expect(result.current.state).toBe(endState);
    expect(urlHoldsSecret()).toBe(false);
    // paid-unconfirmed keeps the held return (sessionStorage only), so a
    // reload asks the server again; every other outcome lets it go.
    const keepsHeld = endState === "paid-unconfirmed";
    expect(storageHoldsSecret()).toBe(keepsHeld);
    expect(Object.keys(window.localStorage)).toEqual([]);
    if (keepsHeld) expect(window.sessionStorage.getItem(HELD)).toContain(SECRET);
    else expect(window.sessionStorage.getItem(HELD)).toBeNull();
    if (name === "dead") expect(onFailed).toHaveBeenCalledTimes(1);
    if (name === "confirmed" || name === "processing") {
      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(MARKER)).toBeNull();
    }
    if (endState !== null) {
      // The terminal screen leaves the reminder: the id, never the secret.
      expect(window.sessionStorage.getItem(MARKER)).toContain("pi_r");
    }
  });

  it("Check again on paid-unconfirmed still asks with the secret, from memory", async () => {
    verify.fn.mockResolvedValue(paid("succeeded"));
    const askServer = vi
      .fn<Parameters<AskEmbedServer>, ReturnType<AskEmbedServer>>()
      .mockResolvedValueOnce({ outcome: "unanswered", final: false })
      .mockResolvedValueOnce({ outcome: "confirmed", orderId: "order-r" });
    const { result, onConfirmed } = mount(askServer);
    await flush();
    expect(result.current.state).toBe("paid-unconfirmed");
    expect(urlHoldsSecret()).toBe(false);

    await act(async () => {
      result.current.checkAgain();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(askServer).toHaveBeenCalledTimes(2);
    expect(askServer.mock.calls[1]?.[0]).toBe(SECRET);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(storageHoldsSecret()).toBe(false);
  });

  it("a reload mid-verify (the URL already clean) picks the held return up and checks again", async () => {
    verify.fn.mockImplementationOnce(() => new Promise(() => {}));
    const first = mount(answering({ outcome: "confirmed", orderId: "order-r" }));
    expect(urlHoldsSecret()).toBe(false);
    first.unmount();

    // The reload: a clean URL, so the server render did not seed it.
    verify.fn.mockResolvedValue(paid("succeeded"));
    const askServer = answering({ outcome: "confirmed", orderId: "order-r" });
    const second = mount(askServer, { seeded: false });
    await flush();
    expect(verify.fn).toHaveBeenLastCalledWith(SECRET, expect.anything());
    expect(askServer).toHaveBeenCalledWith(SECRET, expect.anything());
    expect(second.onConfirmed).toHaveBeenCalledTimes(1);
    expect(storageHoldsSecret()).toBe(false);
  });

  it("StrictMode's dev re-run of the effect still verifies the return its first run took off the URL", async () => {
    verify.fn.mockResolvedValue(paid("succeeded"));
    const askServer = answering({ outcome: "confirmed", orderId: "order-r" });
    const { result, onConfirmed } = mount(askServer, { strict: true });
    await flush();
    expect(urlHoldsSecret()).toBe(false);
    expect(askServer).toHaveBeenCalledTimes(1);
    expect(askServer).toHaveBeenCalledWith(SECRET, expect.anything());
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBeNull();
  });

  it("StrictMode with storage blocked: the re-run still has the return, from memory", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      verify.fn.mockResolvedValue(paid("succeeded"));
      const askServer = answering({ outcome: "confirmed", orderId: "order-r" });
      const { onConfirmed } = mount(askServer, { strict: true });
      await flush();
      expect(urlHoldsSecret()).toBe(false);
      expect(askServer).toHaveBeenCalledWith(SECRET, expect.anything());
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("any reload after a terminal screen gets the reminder over an open widget, and nothing is re-verified", async () => {
    verify.fn.mockResolvedValue(paid("live"));
    const first = mount(answering({ outcome: "confirmed", orderId: "order-r" }));
    await flush();
    expect(first.result.current.state).toBe("unverified");
    first.unmount();
    verify.fn.mockClear();

    const second = mount(answering({ outcome: "confirmed", orderId: "order-r" }), { seeded: false });
    await flush();
    expect(verify.fn).not.toHaveBeenCalled();
    expect(second.result.current.state).toBeNull();
    expect(second.result.current.pendingNotice).toBe(true);
  });

  it("a held return older than 30 minutes is dropped, not resumed", async () => {
    window.history.replaceState(null, "", "/embed/embed-1");
    window.sessionStorage.setItem(
      HELD,
      JSON.stringify({
        clientSecret: SECRET,
        paymentIntentId: "pi_r",
        failedHint: false,
        at: Date.now() - 31 * 60 * 1000,
      }),
    );
    const { result } = mount(answering({ outcome: "confirmed", orderId: "order-r" }), { seeded: false });
    await flush();
    expect(verify.fn).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
    expect(window.sessionStorage.getItem(HELD)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// paid-unconfirmed (Stripe.js says paid, the server has not confirmed) keeps
// the held return for its 30 minutes, so an iframe reload asks the server
// again instead of showing the "check your email" notice beside an open
// widget, which invites a second purchase.
// ─────────────────────────────────────────────────────────────────────────────

describe("useEmbedRedirectReturn — a reload on paid-unconfirmed asks the server again", () => {
  const T0 = new Date("2026-10-12T20:00:00Z").getTime();
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    verify.fn.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    window.history.replaceState(null, "", `/embed/embed-1${RETURN}`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lands on the return; the server does not confirm, ten seconds later. */
  const landUnconfirmed = async () => {
    verify.fn.mockResolvedValue(paid("succeeded"));
    const askServer = vi.fn<Parameters<AskEmbedServer>, ReturnType<AskEmbedServer>>(
      async () => {
        vi.setSystemTime(Date.now() + 10_000);
        return { outcome: "unanswered", final: false };
      },
    );
    const first = mount(askServer);
    await flush();
    expect(first.result.current.state).toBe("paid-unconfirmed");
    expect(window.sessionStorage.getItem(HELD)).toContain(SECRET);
    expect(window.sessionStorage.getItem(MARKER)).toContain("pi_r");
    first.unmount();
    verify.fn.mockClear();
  };

  it("within 30 minutes: the held return stays, and the reload verifies and asks the server again", async () => {
    await landUnconfirmed();

    vi.setSystemTime(T0 + 29 * 60 * 1000);
    const askServer = answering({ outcome: "confirmed", orderId: "order-r" });
    const reload = mount(askServer, { seeded: false });
    await flush();
    expect(verify.fn).toHaveBeenCalledWith(SECRET, expect.anything());
    expect(askServer).toHaveBeenCalledWith(SECRET, expect.anything());
    expect(reload.onConfirmed).toHaveBeenCalledTimes(1);
    expect(reload.result.current.pendingNotice).toBe(false);
    // Confirmed: the secret and the reminder go.
    expect(storageHoldsSecret()).toBe(false);
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });

  it("past 30 minutes: the held return has expired, the reload asks nothing and shows the notice", async () => {
    await landUnconfirmed();

    // Past the held return's window (from its read at T0), still inside the
    // marker's (written when the server's answer came, ten seconds later).
    vi.setSystemTime(T0 + 30 * 60 * 1000 + 1_000);
    const askServer = answering({ outcome: "confirmed", orderId: "order-r" });
    const reload = mount(askServer, { seeded: false });
    await flush();
    expect(verify.fn).not.toHaveBeenCalled();
    expect(askServer).not.toHaveBeenCalled();
    expect(reload.result.current.state).toBeNull();
    expect(reload.result.current.pendingNotice).toBe(true);
    expect(storageHoldsSecret()).toBe(false);
  });

  it("a final refusal lets the held return go (asking again cannot change it)", async () => {
    verify.fn.mockResolvedValue(paid("succeeded"));
    const { result } = mount(answering({ outcome: "unanswered", final: true }));
    await flush();
    expect(result.current.state).toBe("paid-unconfirmed");
    expect(result.current.final).toBe(true);
    expect(storageHoldsSecret()).toBe(false);
    expect(window.sessionStorage.getItem(MARKER)).toContain("pi_r");
  });

  it("Check again that is still unconfirmed keeps the held return, at its first read's time", async () => {
    verify.fn.mockResolvedValue(paid("succeeded"));
    const { result } = mount(answering({ outcome: "unanswered", final: false }));
    await flush();
    vi.setSystemTime(T0 + 5 * 60 * 1000);
    await act(async () => {
      result.current.checkAgain();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.stillUnconfirmed).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(HELD)!).at).toBe(T0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A read checks only its own embed's held return, so every widget mount
// sweeps every embed's dead ones: a secret is never kept past its window by
// an embed that does not load again.
// ─────────────────────────────────────────────────────────────────────────────

describe("sweepExpiredHeldRedirectReturns — no held secret outlives its window", () => {
  const held = (at: number) =>
    JSON.stringify({ clientSecret: SECRET, paymentIntentId: "pi_r", failedHint: false, at });
  const OTHER = heldRedirectReturnKey("embed-other");
  const STALE = heldRedirectReturnKey("embed-stale");
  const BROKEN = heldRedirectReturnKey("embed-broken");

  beforeEach(() => {
    window.sessionStorage.clear();
    verify.fn.mockReset();
    window.history.replaceState(null, "", "/embed/embed-1");
  });

  it("deletes every embed's expired or unreadable held return, and keeps live ones and other keys", () => {
    window.sessionStorage.setItem(OTHER, held(Date.now() - 60_000));
    window.sessionStorage.setItem(STALE, held(Date.now() - 31 * 60 * 1000));
    window.sessionStorage.setItem(BROKEN, "{not json");
    window.sessionStorage.setItem(MARKER, JSON.stringify({ paymentIntentId: "pi_r", at: 0 }));

    sweepExpiredHeldRedirectReturns();

    expect(window.sessionStorage.getItem(OTHER)).not.toBeNull();
    expect(window.sessionStorage.getItem(STALE)).toBeNull();
    expect(window.sessionStorage.getItem(BROKEN)).toBeNull();
    // Not a held return: not the sweep's to touch.
    expect(window.sessionStorage.getItem(MARKER)).not.toBeNull();
  });

  it("runs on every widget mount, for other embeds' held returns too", async () => {
    window.sessionStorage.setItem(STALE, held(Date.now() - 31 * 60 * 1000));
    mount(answering({ outcome: "confirmed", orderId: "order-r" }), { seeded: false });
    await flush();
    expect(window.sessionStorage.getItem(STALE)).toBeNull();
    expect(storageHoldsSecret()).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    const spy = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(() => sweepExpiredHeldRedirectReturns()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hasHeldRedirectReturn — a resumed return counts as a redirect return", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("true for a held return, false for none", () => {
    expect(hasHeldRedirectReturn("embed-1")).toBe(false);
    window.sessionStorage.setItem(HELD, JSON.stringify({ clientSecret: SECRET, at: Date.now() }));
    expect(hasHeldRedirectReturn("embed-1")).toBe(true);
    expect(hasHeldRedirectReturn("embed-2")).toBe(false);
  });

  it("false, without throwing, when storage is blocked", () => {
    window.sessionStorage.setItem(HELD, JSON.stringify({ clientSecret: SECRET, at: Date.now() }));
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(hasHeldRedirectReturn("embed-1")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// An in-frame payment Stripe said went through, whose order the server has
// not confirmed, is held as a redirect return so a remount asks again. The
// widget-level behaviour is in EmbedWidget.test.tsx; these pin the helpers.
describe("holdUnconfirmedOrder / releaseHeldOrder — an in-frame order held for a remount", () => {
  const ORDER = "pi_inframe_secret_FakeFixtureNotReal";
  const OTHER = "pi_other_secret_FakeFixtureNotReal";
  const heldNow = () =>
    JSON.parse(window.sessionStorage.getItem(HELD) ?? "null") as {
      clientSecret: string;
      paymentIntentId: string | null;
      failedHint: boolean;
      at: number;
    } | null;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds the order as a redirect return with no failure hint, in sessionStorage only", () => {
    holdUnconfirmedOrder("embed-1", ORDER);
    expect(heldNow()).toMatchObject({
      clientSecret: ORDER,
      paymentIntentId: "pi_inframe",
      failedHint: false,
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("holding the same order again keeps the first time (the window is not restarted); another order replaces it", () => {
    holdUnconfirmedOrder("embed-1", ORDER);
    const first = heldNow()?.at;
    vi.advanceTimersByTime(60_000);
    holdUnconfirmedOrder("embed-1", ORDER);
    expect(heldNow()?.at).toBe(first);
    holdUnconfirmedOrder("embed-1", OTHER);
    expect(heldNow()?.clientSecret).toBe(OTHER);
  });

  it("is marked in-frame, and so does not make the load count as a redirect return (its referrer names the host page)", () => {
    holdUnconfirmedOrder("embed-1", ORDER);
    expect(heldNow()).toMatchObject({ inFrame: true });
    expect(hasHeldRedirectReturn("embed-1")).toBe(false);
    // A real return's hold still counts.
    window.sessionStorage.setItem(HELD, JSON.stringify({ clientSecret: SECRET, at: Date.now() }));
    expect(hasHeldRedirectReturn("embed-1")).toBe(true);
  });

  it("is swept like any held return once its window has passed", () => {
    holdUnconfirmedOrder("embed-1", ORDER);
    vi.advanceTimersByTime(30 * 60 * 1000);
    sweepExpiredHeldRedirectReturns();
    expect(window.sessionStorage.getItem(HELD)).toBeNull();
  });

  it("release lets go of THIS order's hold only, and of no other embed's", () => {
    holdUnconfirmedOrder("embed-1", ORDER);
    holdUnconfirmedOrder("embed-2", ORDER);
    releaseHeldOrder("embed-1", OTHER);
    expect(heldNow()?.clientSecret).toBe(ORDER);
    releaseHeldOrder("embed-1", ORDER);
    expect(window.sessionStorage.getItem(HELD)).toBeNull();
    expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-2"))).not.toBeNull();
  });

  it("never throws when storage is blocked", () => {
    for (const method of ["setItem", "getItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    }
    expect(() => holdUnconfirmedOrder("embed-1", ORDER)).not.toThrow();
    expect(() => releaseHeldOrder("embed-1", ORDER)).not.toThrow();
  });
});
