// @vitest-environment jsdom
/**
 * A refusal that arrives while a door sale is open waits for the sale.
 *
 * Real pieces: the sale guard's host and the Sell screen's report of its risk
 * (`features/pos/sale-guard.ts`), `useDenialHeldForSale`, `useAccessRevocation`,
 * the app's tRPC client and query client. The session query is the one
 * `useScannerSession` runs; the composition is `scanner-app.tsx`'s, pinned by
 * the source guard at the end.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement, useState } from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
}));
vi.mock("../features/network/use-network-state", () => ({
  useNetworkState: () => "online",
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/react-native", () => ({
  captureException: sentry.captureException,
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../config/api", () => ({
  getTrpcHttpUrl: () => "http://scanner.test/trpc",
  getApiBaseUrl: () => "http://scanner.test",
}));
const localDb = vi.hoisted(() => ({ clearAttendeeData: vi.fn() }));
vi.mock("./local-db", () => ({ clearAttendeeData: localDb.clearAttendeeData }));

import {
  SaleGuardProvider,
  useCardClearedNotice,
  useReportSaleGuard,
  useSaleGuardHost,
  type CardClearedNotice,
} from "../features/pos/sale-guard";
import type { LeaveRisk } from "../features/pos/sale-attempt";
import {
  refusal,
  trpcWrapper,
  type Handler,
  type Handlers,
} from "../../test/harness/fake-trpc-link";
import { createQueryClient } from "../query-client";
import { trpc } from "../trpc";
import { useAccessRevocation } from "./use-access-revocation";
import { useDenialHeldForSale } from "./use-denial-held-for-sale";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const CONTEXT = {
  operator: { humanId: "human-1", displayName: "Op", email: "op@example.test" },
  orgs: [{ orgId: "org-1", orgName: "Org", role: "SCANNER" }],
};
const wipe = localDb.clearAttendeeData;
/** The hold's cap in these tests (3 minutes in the app). */
const HOLD_CAP_MS = 400;

let queryClient: QueryClient;
let handlers: Handlers;
let getSessionContext: ReturnType<typeof vi.fn<Handler>>;

/** What the app shows, read after each render. */
const seen: {
  denied: boolean;
  sellMounted: boolean;
  /** The card-cleared notice the denied screen is handed. */
  deniedNotice: Pick<CardClearedNotice, "kind" | "amount"> | null;
  /** The risk the cap's clear left behind, as the denied screen is handed it. */
  deniedClearedSale: LeaveRisk | null;
} = { denied: false, sellMounted: false, deniedNotice: null, deniedClearedSale: null };
type Sale = { risk: LeaveRisk | null; idle: boolean; done?: boolean };
/** The Sell screen's sale, for the test to drive. */
let setSale: (sale: Sale) => void;
/** `pos.cancelSale`, as `clearForLeave` sends it for an open card sale. */
const cancelSale = vi.fn<() => Promise<void>>();
/** The cancel's answer, for the test to give. */
let cancelAnswer: { resolve: () => void; reject: (err: unknown) => void };
/** Makes the app's cap callback throw. */
let capThrows = false;
/**
 * Whether the shell shows the Sell screen. Off: the operator is on another
 * tab, or the Sell tab is loading (it attaches nothing).
 */
let sellShown = true;

/** `useDoorSale`'s part: its report, and `clearForLeave`. */
function SellScreen() {
  const [sale, set] = useState<Sale>({ risk: null, idle: true });
  setSale = set;
  const notice = useCardClearedNotice();
  useReportSaleGuard({
    getRisk: () => sale.risk,
    risk: sale.risk,
    idle: sale.idle,
    done: sale.done ?? false,
    clear: () => {
      if (sale.risk === "card") {
        const token = notice.begin("unconfirmed", "$24.00");
        cancelSale().then(
          () => notice.update(token, "cancelled"),
          () => notice.update(token, "unconfirmed"),
        );
      }
      set({ risk: null, idle: true });
    },
  });
  return null;
}

/** `scanner-app.tsx`'s part in this. */
function App() {
  const session = trpc.scanner.getSessionContext.useQuery(
    {},
    { retry: false, staleTime: 60_000 },
  );
  const accessDenied = session.error?.data?.code === "FORBIDDEN";
  const { denied, saleAtRisk, saleIdle, riskChanged } = useDenialHeldForSale(
    accessDenied,
    {
      capMs: HOLD_CAP_MS,
      onCapReached: () => {
        if (capThrows) throw new Error("clear failed");
        saleGuard.clearNow();
      },
      onDenialEnded: () => saleGuard.forgetCleared(),
    },
  );
  useAccessRevocation({ userId: "human-1", accessDenied: denied });
  const saleGuard = useSaleGuardHost({
    onSaleAtRisk: saleAtRisk,
    onSaleIdle: saleIdle,
    onRiskChange: riskChanged,
    userId: "human-1",
  });
  seen.denied = denied;
  seen.sellMounted = !denied;
  seen.deniedNotice = denied
    ? { kind: saleGuard.cardCleared.kind, amount: saleGuard.cardCleared.amount }
    : null;
  seen.deniedClearedSale = denied ? saleGuard.clearedByApp : null;
  // The denied screen replaces the shell, Sell tab included.
  if (denied) return null;
  return createElement(SaleGuardProvider, {
    registry: saleGuard.registry,
    cardCleared: saleGuard.cardCleared,
    children: sellShown ? createElement(SellScreen) : null,
  });
}

const renderApp = () => {
  const Wrapper = trpcWrapper(
    () => queryClient,
    () => handlers,
  );
  return render(createElement(Wrapper, null, createElement(App)));
};

/** The re-check finds the role gone (foreground, back online, list refused). */
const refusedOnRecheck = async () => {
  getSessionContext.mockRejectedValue(refusal("FORBIDDEN", "INSUFFICIENT_ROLE"));
  await act(() => queryClient.refetchQueries());
  await waitFor(() =>
    expect(
      queryClient.getQueryCache().findAll({ queryKey: [["scanner", "getSessionContext"]] })[0]
        ?.state.status,
    ).toBe("error"),
  );
};
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

beforeEach(() => {
  wipe.mockReset();
  sentry.captureException.mockReset();
  seen.denied = false;
  seen.sellMounted = false;
  seen.deniedNotice = null;
  seen.deniedClearedSale = null;
  capThrows = false;
  sellShown = true;
  cancelSale.mockReset();
  cancelSale.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        cancelAnswer = { resolve, reject };
      }),
  );
  queryClient = createQueryClient();
  getSessionContext = vi.fn<Handler>(async () => CONTEXT);
  handlers = { "scanner.getSessionContext": getSessionContext };
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("a refusal during an open sale", () => {
  const startApp = async () => {
    renderApp();
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(1));
    await settle();
  };

  it("a card sale in flight is held: the Sell screen stays and nothing is wiped, within the cap", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();

    expect(seen.denied).toBe(false);
    expect(seen.sellMounted).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("the card answers: the done screen stays up until New sale, then the denial takes effect", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();
    expect(seen.denied).toBe(false);

    // The done screen ("paid, admitted"): nothing at risk, not moved on.
    act(() => setSale({ risk: null, idle: false, done: true }));
    await settle();
    expect(seen.denied).toBe(false);
    expect(wipe).not.toHaveBeenCalled();

    // "New sale": an empty till.
    act(() => setSale({ risk: null, idle: true }));
    await waitFor(() => expect(seen.denied).toBe(true));
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    // Nothing was open to cancel.
    expect(cancelSale).not.toHaveBeenCalled();
    expect(seen.deniedNotice).toEqual({ kind: null, amount: null });
  });

  it("the card fails back to the cart: the denial takes effect, without a new sale", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();

    act(() => setSale({ risk: null, idle: false }));
    await waitFor(() => expect(seen.denied).toBe(true));
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });

  it("a card sale still open at the cap is cleared on purpose: cancel sent, and the denied screen says not to take cash", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();
    expect(seen.denied).toBe(false);

    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    expect(cancelSale).toHaveBeenCalledTimes(1);
    expect(seen.deniedNotice).toEqual({ kind: "unconfirmed", amount: "$24.00" });
    expect(seen.deniedClearedSale).toBe("card");
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    // The cancel answers after the Sell screen is gone: the denied screen's
    // notice follows it.
    await act(async () => {
      cancelAnswer.resolve();
    });
    await waitFor(() =>
      expect(seen.deniedNotice).toEqual({ kind: "cancelled", amount: "$24.00" }),
    );
  });

  it("an attempt that stays unresolved is released by the cap, and the denied screen says the sale may stand", async () => {
    await startApp();
    act(() => setSale({ risk: "unresolved", idle: false }));
    await refusedOnRecheck();
    await settle();
    expect(seen.denied).toBe(false);

    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    // No card to cancel; the key may hold a sale the server recorded.
    expect(cancelSale).not.toHaveBeenCalled();
    expect(seen.deniedClearedSale).toBe("unresolved");
    expect(seen.deniedNotice).toEqual({ kind: null, amount: null });
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });

  it("a press still sending at the cap: the denied screen says the sale may stand", async () => {
    await startApp();
    act(() => setSale({ risk: "sending", idle: false }));
    await refusedOnRecheck();
    await settle();

    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    expect(seen.deniedClearedSale).toBe("sending");
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });

  it("the done screen left up until the cap: the denial takes effect, nothing to cancel", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();
    act(() => setSale({ risk: null, idle: false, done: true }));
    await settle();
    expect(seen.denied).toBe(false);

    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    expect(cancelSale).not.toHaveBeenCalled();
    expect(seen.deniedNotice).toEqual({ kind: null, amount: null });
    expect(seen.deniedClearedSale).toBeNull();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });

  it("a clear that throws at the cap: the denial still takes effect, and it is reported", async () => {
    capThrows = true;
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();

    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    const reports = sentry.captureException.mock.calls.filter(
      ([, context]) =>
        (context as { tags?: { branch?: string } } | undefined)?.tags?.branch ===
        "denial_cap_clear_failed",
    );
    expect(reports).toHaveLength(1);
  });

  it("the till idle releases it too", async () => {
    await startApp();
    act(() => setSale({ risk: "card", idle: false }));
    await refusedOnRecheck();
    await settle();

    act(() => setSale({ risk: null, idle: true }));
    await waitFor(() => expect(seen.denied).toBe(true));
    // Let the wipe finish here, not in the next test.
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });

  it("with no sale open, the refusal takes effect at once", async () => {
    await startApp();

    await refusedOnRecheck();

    await waitFor(() => expect(seen.denied).toBe(true));
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
  });
});

describe("what a cap cleared belongs to that refusal", () => {
  it("access given back and refused again later, with no sale open: the denied screen says nothing about a sale", async () => {
    renderApp();
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(1));
    await settle();
    act(() => setSale({ risk: "sending", idle: false }));
    await refusedOnRecheck();
    await waitFor(() => expect(seen.denied).toBe(true), { timeout: 2_000 });
    expect(seen.deniedClearedSale).toBe("sending");
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    // Access given back. The Sell tab comes back still loading, so no Sell
    // screen attaches; the operator moves on.
    sellShown = false;
    getSessionContext.mockResolvedValue(CONTEXT);
    await act(() => queryClient.refetchQueries());
    await waitFor(() => expect(seen.denied).toBe(false));

    // Hours later, refused again with nothing on the till.
    await refusedOnRecheck();
    await waitFor(() => expect(seen.denied).toBe(true));
    expect(seen.deniedClearedSale).toBeNull();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(2));
  });
});

describe("the sale guard host's record of what it cleared", () => {
  const entry = (risk: LeaveRisk | null, clear: () => void = () => {}) => ({
    getRisk: () => risk,
    clear,
  });
  const host = (userId: string | null = "human-1") =>
    renderHook((props: { userId: string | null }) => useSaleGuardHost(props), {
      initialProps: { userId },
    });

  it("is dropped when a Sell screen attaches again", () => {
    const h = host();
    act(() => h.result.current.registry.attach(entry("sending")));
    act(() => h.result.current.clearNow());
    expect(h.result.current.clearedByApp).toBe("sending");

    act(() => h.result.current.registry.attach(entry(null)));
    expect(h.result.current.clearedByApp).toBeNull();
  });

  it("is dropped when a different operator signs in, and kept through a sign-out", () => {
    const h = host();
    act(() => h.result.current.registry.attach(entry("unresolved")));
    act(() => h.result.current.clearNow());

    h.rerender({ userId: null });
    expect(h.result.current.clearedByApp).toBe("unresolved");
    h.rerender({ userId: "human-1" });
    expect(h.result.current.clearedByApp).toBe("unresolved");

    h.rerender({ userId: "human-2" });
    expect(h.result.current.clearedByApp).toBeNull();
  });

  it("a card clear that throws before its notice: the risk is still recorded, with no card notice", () => {
    const h = host();
    act(() =>
      h.result.current.registry.attach(
        entry("card", () => {
          throw new Error("clear failed");
        }),
      ),
    );
    let thrown: unknown = null;
    act(() => {
      try {
        h.result.current.clearNow();
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toEqual(new Error("clear failed"));
    expect(h.result.current.clearedByApp).toBe("card");
    expect(h.result.current.cardCleared.kind).toBeNull();
  });
});

describe("scanner-app.tsx wiring (source guard)", () => {
  it("holds the denial for an open sale, and feeds the guard's signals to it", () => {
    const source = readFileSync(resolve(__dirname, "../scanner-app.tsx"), "utf8");
    expect(source).toMatch(
      /useDenialHeldForSale\(\s*accessDenied,\s*\{\s*onCapReached: \(\) => saleGuard\.clearNow\(\),/,
    );
    expect(source).toMatch(/cardCleared=\{saleGuard\.cardCleared\}/);
    expect(source).toMatch(/clearedSale=\{saleGuard\.clearedByApp\}/);
    expect(source).toMatch(/onDenialEnded: \(\) => saleGuard\.forgetCleared\(\),/);
    expect(source).toMatch(/onRiskChange: riskChanged,/);
    expect(source).toMatch(/accessDenied: denied,/);
    expect(source).toMatch(/onSaleAtRisk: \(\) => \{\s*eventPin\.pin\(\);\s*saleAtRisk\(\);/);
    expect(source).toMatch(/onSaleIdle: \(\) => \{\s*eventPin\.release\(\);\s*saleIdle\(\);/);
    expect(source).toMatch(/if \(denied\) \{/);
    expect(source).not.toMatch(/if \(accessDenied\) \{/);
  });
});
