import React from "react";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reload of the confirmed URL (`?step=confirmed&order=<id>`) restores that
 * order's confirmation only for THIS event and a status the in-session
 * confirmation shows; anything else falls back to the empty picker with a
 * notice. Before this, the URL kept the cart's `t=` and a reload showed the
 * picker with the same tickets selected, one click from buying again.
 */

const server = vi.hoisted(() => ({
  myOrder: undefined as unknown,
  /** The load's error, or null. */
  error: null as unknown,
  isError: false,
  isFetching: false,
  refetch: (() => {}) as () => unknown,
  queried: [] as unknown[],
  meta: [] as unknown[],
}));
vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      getMyOrder: {
        useQuery: (
          input: unknown,
          options: { enabled?: boolean; meta?: unknown },
        ) => {
          if (options.enabled) {
            server.queried.push(input);
            server.meta.push(options.meta);
          }
          const failed = options.enabled && Boolean(server.error);
          return {
            data: options.enabled && !failed ? server.myOrder : undefined,
            error: failed ? server.error : null,
            isError: failed,
            isFetching: options.enabled ? server.isFetching : false,
            refetch: server.refetch,
          };
        },
      },
    },
  },
}));
const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: sentry.captureException,
}));
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  restoreStateAfterPhase,
  restoredConfirmationVerdict,
  type RestoreSessionStatus,
} from "./restored-confirmation";
import { useConfirmedOrder } from "./useConfirmedOrder";
import { CheckoutRestoreNotice } from "./CheckoutRestoreNotice";
import { CheckoutConfirmedPending } from "./CheckoutConfirmedPending";

/** The shapes a tRPC client error arrives in. */
const NOT_FOUND = {
  message: "ORDER_NOT_FOUND",
  data: { code: "NOT_FOUND", appCode: "ORDER_NOT_FOUND", httpStatus: 404 },
};
const SERVER_500 = {
  message: "Invalid `prisma.event.findUnique()` invocation",
  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "orders.getMyOrder" },
};
const NETWORK = new TypeError("Failed to fetch");
const UNAUTHORIZED = {
  message: "UNAUTHORIZED",
  data: { code: "UNAUTHORIZED", httpStatus: 401 },
};

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const CHARGES = {
  subtotalCents: 7000,
  platformFeeCents: 100,
  processingFeeCents: 230,
  taxCents: 0,
  creditCents: 0,
  totalCents: 7330,
  buyerFeeMode: "PASS_THROUGH",
};
const myOrder = (status: string, eventId = EVENT_ID) => ({
  id: ORDER_ID,
  status,
  eventId,
  charges: CHARGES,
  items: [
    {
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 2,
      unitPriceCents: 3500,
      amountCents: 7000,
    },
  ],
});

describe("restoredConfirmationVerdict", () => {
  const base = {
    eventId: EVENT_ID,
    session: "signed-in" as const,
    error: null,
  };

  it.each(["SUCCEEDED", "PROCESSING"] as const)(
    "%s for this event confirms",
    (status) => {
      expect(
        restoredConfirmationVerdict({
          ...base,
          order: { eventId: EVENT_ID, status },
        }),
      ).toBe("confirm");
    },
  );

  it.each([
    "PENDING",
    "PART_REFUNDED",
    "REFUNDED",
    "DISPUTED",
    "CANCELLED",
  ] as const)(
    "%s falls back",
    (status) => {
      expect(
        restoredConfirmationVerdict({
          ...base,
          order: { eventId: EVENT_ID, status },
        }),
      ).toBe("fallback");
    },
  );

  it("an order of ANOTHER event falls back, whatever its status", () => {
    expect(
      restoredConfirmationVerdict({
        ...base,
        order: { eventId: OTHER_EVENT_ID, status: "SUCCEEDED" },
      }),
    ).toBe("fallback");
  });

  it("ORDER_NOT_FOUND is an answer: falls back", () => {
    expect(
      restoredConfirmationVerdict({ ...base, order: undefined, error: NOT_FOUND }),
    ).toBe("fallback");
  });

  // The live-run defect: a 500 on the first reload (dev DB in recovery)
  // showed "We can't show that order here" and erased the confirmed URL.
  it.each([
    ["a 500", SERVER_500],
    ["a network error", NETWORK],
    ["UNAUTHORIZED while the session says signed in", UNAUTHORIZED],
    ["an unknown throw", "boom"],
  ])("%s is transient: unavailable, never fallback", (_, error) => {
    expect(
      restoredConfirmationVerdict({ ...base, order: undefined, error }),
    ).toBe("unavailable");
  });

  it("a FAILED session read is transient, not signed out", () => {
    expect(
      restoredConfirmationVerdict({
        ...base,
        session: "unknown",
        order: undefined,
      }),
    ).toBe("unavailable");
  });

  it("signed out falls back; a loading session waits", () => {
    expect(
      restoredConfirmationVerdict({
        ...base,
        session: "signed-out",
        order: undefined,
      }),
    ).toBe("fallback");
    expect(
      restoredConfirmationVerdict({
        ...base,
        session: "loading",
        order: undefined,
      }),
    ).toBe("pending");
  });

  it("waits while the order loads", () => {
    expect(restoredConfirmationVerdict({ ...base, order: undefined })).toBe(
      "pending",
    );
  });
});

describe("restoreStateAfterPhase — the fallback notice", () => {
  it("stays on the picker it was shown over", () => {
    expect(restoreStateAfterPhase("failed", "selecting")).toBe("failed");
  });

  it("goes for good once the phase leaves selecting", () => {
    const afterHold = restoreStateAfterPhase("failed", "holding");
    expect(afterHold).toBeNull();
    // Stepping back to the tickets later does not bring it back.
    expect(restoreStateAfterPhase(afterHold, "selecting")).toBeNull();
  });

  it("leaves a restore in progress or confirmed alone", () => {
    expect(restoreStateAfterPhase("restoring", "confirmed")).toBe("restoring");
    expect(restoreStateAfterPhase("confirmed", "confirmed")).toBe("confirmed");
  });
});

describe("useConfirmedOrder — restoring from the URL", () => {
  afterEach(() => {
    server.myOrder = undefined;
    server.error = null;
    server.isFetching = false;
    server.refetch = () => {};
    server.isError = false;
    server.queried = [];
    server.meta = [];
  });

  const restoreArgs = (
    session: RestoreSessionStatus = "signed-in",
  ) => ({
    isConfirmed: true,
    orderId: ORDER_ID,
    pageOrder: null,
    restore: { eventId: EVENT_ID, session },
  });

  it("an eligible order is shown, from getMyOrder's charged figures", () => {
    server.myOrder = myOrder("SUCCEEDED");
    const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
    expect(result.current.restoreVerdict).toBe("confirm");
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("not ready");
    expect(result.current.order.amountGrossCents).toBe(7000);
    expect(result.current.quantities).toEqual({ "tt-ga": 2 });
    expect(server.queried).toEqual([{ orderId: ORDER_ID }]);
  });

  it.each([
    ["PROCESSING", "processing"],
    ["SUCCEEDED", "paid"],
  ] as const)(
    "a restored %s order lands on the confirmation with payment %s",
    (status, payment) => {
      server.myOrder = myOrder(status);
      const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
      expect(result.current.restoreVerdict).toBe("confirm");
      expect(result.current).toMatchObject({ status: "ready", payment });
    },
  );

  it("another event's order is never shown: loading view, fallback verdict", () => {
    server.myOrder = myOrder("SUCCEEDED", OTHER_EVENT_ID);
    const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
    expect(result.current.restoreVerdict).toBe("fallback");
    expect(result.current.status).toBe("loading");
  });

  it("an ineligible status is never shown", () => {
    server.myOrder = myOrder("REFUNDED");
    const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
    expect(result.current.restoreVerdict).toBe("fallback");
    expect(result.current.status).toBe("loading");
  });

  it("ORDER_NOT_FOUND falls back (loading view for the one render)", () => {
    server.error = NOT_FOUND;
    const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
    expect(result.current.restoreVerdict).toBe("fallback");
    expect(result.current.status).toBe("loading");
  });

  it.each([
    ["a 500", SERVER_500],
    ["a network error", NETWORK],
    ["UNAUTHORIZED with a session", UNAUTHORIZED],
  ])("%s stays put: restore-unavailable with a retry that refetches", (_, error) => {
    server.error = error;
    const refetch = vi.fn();
    server.refetch = refetch;
    const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
    expect(result.current.restoreVerdict).toBe("unavailable");
    expect(result.current.status).toBe("restore-unavailable");
    if (result.current.status !== "restore-unavailable") throw new Error("x");
    result.current.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a retry that comes back with the order goes through the normal verdict", () => {
    server.error = SERVER_500;
    const { result, rerender } = renderHook(() =>
      useConfirmedOrder(restoreArgs()),
    );
    expect(result.current.restoreVerdict).toBe("unavailable");
    server.error = null;
    server.myOrder = myOrder("SUCCEEDED");
    rerender();
    expect(result.current.restoreVerdict).toBe("confirm");
    expect(result.current.status).toBe("ready");
    server.myOrder = undefined;
    server.error = NOT_FOUND;
    rerender();
    expect(result.current.restoreVerdict).toBe("fallback");
  });

  // Defensive: with better-auth 1.6.x a session retry clears `error`, so the
  // page shows "loading" instead. This pins the flag should that change.
  it("a session retry in flight shows as retrying (the order query is off)", () => {
    const args = (sessionRefetching: boolean) => ({
      ...restoreArgs("unknown"),
      restore: {
        eventId: EVENT_ID,
        session: "unknown" as const,
        refetchSession: vi.fn(),
        sessionRefetching,
      },
    });
    const idle = renderHook(() => useConfirmedOrder(args(false)));
    expect(idle.result.current).toMatchObject({
      status: "restore-unavailable",
      retrying: false,
    });
    const busy = renderHook(() => useConfirmedOrder(args(true)));
    expect(busy.result.current).toMatchObject({
      status: "restore-unavailable",
      retrying: true,
    });
  });

  describe("UNAUTHORIZED with a session is reported once", () => {
    // Before, not after: the transient-error cases above report too.
    beforeEach(() => {
      sentry.captureException.mockReset();
    });

    it("once per order id, not on every render or retry", () => {
      // "Missing actor human id": permanent, and dropped by the global
      // logger before Sentry.
      server.error = { ...UNAUTHORIZED, message: "Missing actor human id" };
      const { result, rerender } = renderHook(() =>
        useConfirmedOrder(restoreArgs()),
      );
      rerender();
      rerender();
      // A retry that fails the same way arrives as a NEW error object.
      server.error = { ...UNAUTHORIZED, message: "Missing actor human id" };
      if (result.current.status === "restore-unavailable") {
        result.current.retry();
      }
      rerender();
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Missing actor human id" }),
        expect.objectContaining({
          tags: { area: "checkout.restore", kind: "unauthorized-with-session" },
          extra: { orderId: ORDER_ID },
        }),
      );
      // The UI is unchanged: still a retry.
      expect(result.current.status).toBe("restore-unavailable");
    });

    it("a 500 or a NOT_FOUND is not reported here (the global logger owns those)", () => {
      server.error = SERVER_500;
      renderHook(() => useConfirmedOrder(restoreArgs()));
      server.error = NOT_FOUND;
      renderHook(() => useConfirmedOrder(restoreArgs()));
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it("without a restore (the redirect-return path) nothing is reported here", () => {
      server.error = UNAUTHORIZED;
      renderHook(() =>
        useConfirmedOrder({ isConfirmed: true, orderId: ORDER_ID, pageOrder: null }),
      );
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it("a throwing reporter changes nothing", () => {
      sentry.captureException.mockImplementationOnce(() => {
        throw new Error("sentry down");
      });
      server.error = UNAUTHORIZED;
      const { result } = renderHook(() => useConfirmedOrder(restoreArgs()));
      expect(result.current.status).toBe("restore-unavailable");
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });

  it("a failed SESSION read retries the session, not the order", () => {
    const refetch = vi.fn();
    const refetchSession = vi.fn();
    server.refetch = refetch;
    const { result } = renderHook(() =>
      useConfirmedOrder({
        ...restoreArgs("unknown"),
        restore: { eventId: EVENT_ID, session: "unknown", refetchSession },
      }),
    );
    expect(result.current.status).toBe("restore-unavailable");
    if (result.current.status !== "restore-unavailable") throw new Error("x");
    result.current.retry();
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
    expect(server.queried).toEqual([]);
  });

  it("while restoring, a failure is one inline message: never the toast", () => {
    server.myOrder = myOrder("SUCCEEDED");
    renderHook(() => useConfirmedOrder(restoreArgs()));
    const meta = server.meta[0] as {
      silentWhen?: (e: unknown) => boolean;
      noToast?: boolean;
    };
    // No toast for ANY failure (the picker's notice says it)…
    expect(meta.noToast).toBe(true);
    // …ORDER_NOT_FOUND is an expected refusal: not reported at all…
    expect(
      meta.silentWhen?.({ data: { appCode: "ORDER_NOT_FOUND" } }),
    ).toBe(true);
    // …anything else still goes to the console and Sentry.
    expect(meta.silentWhen?.(new Error("boom"))).toBe(false);
  });

  it("the redirect-return path keeps the default error handling (no meta)", () => {
    server.myOrder = myOrder("SUCCEEDED");
    renderHook(() =>
      useConfirmedOrder({ isConfirmed: true, orderId: ORDER_ID, pageOrder: null }),
    );
    expect(server.meta[0]).toBeUndefined();
  });

  it("asks nothing until the session is known, and nothing when signed out", () => {
    server.myOrder = myOrder("SUCCEEDED");
    const loading = renderHook(() =>
      useConfirmedOrder(restoreArgs("loading")),
    );
    expect(loading.result.current.restoreVerdict).toBe("pending");
    expect(loading.result.current.status).toBe("loading");
    const signedOut = renderHook(() =>
      useConfirmedOrder(restoreArgs("signed-out")),
    );
    expect(signedOut.result.current.restoreVerdict).toBe("fallback");
    expect(server.queried).toEqual([]);
  });

  it("without `restore`, the existing path is unchanged (no verdict)", () => {
    server.myOrder = myOrder("REFUNDED", OTHER_EVENT_ID);
    const { result } = renderHook(() =>
      useConfirmedOrder({ isConfirmed: true, orderId: ORDER_ID, pageOrder: null }),
    );
    expect(result.current.restoreVerdict).toBeNull();
    expect(result.current.status).toBe("ready");
  });
});

describe("CheckoutConfirmedPending — restore-unavailable", () => {
  it("neutral copy, a working retry and My tickets; never 'paid'", () => {
    const onRetry = vi.fn();
    render(
      <CheckoutConfirmedPending
        status="restore-unavailable"
        orderId={ORDER_ID}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("checkout.restoredOrderLoadFailed");
    // Not the "Your payment went through" copy: the id is unverified.
    expect(screen.queryByText("checkout.confirmedOrderUnavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "checkout.restoredOrderRetry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("link", { name: "checkout.restoredOrderMyTickets" });
    expect(link.getAttribute("href")).toBe("/my-tickets");
  });

  it("a retry in flight is disabled and says so", () => {
    render(
      <CheckoutConfirmedPending
        status="restore-unavailable"
        orderId={ORDER_ID}
        onRetry={() => {}}
        retrying
      />,
    );
    const button = screen.getByRole("button", {
      name: "checkout.restoredOrderRetrying",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("CheckoutRestoreNotice", () => {
  it("says the order can't be shown and links to My tickets", () => {
    render(<CheckoutRestoreNotice />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("checkout.restoredOrderUnavailable");
    const link = screen.getByRole("link", {
      name: "checkout.restoredOrderMyTickets",
    });
    expect(link.getAttribute("href")).toBe("/my-tickets");
  });
});
