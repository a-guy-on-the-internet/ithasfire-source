// @vitest-environment jsdom
/**
 * `useDoorSale` against the REAL tRPC React client and the app's REAL React
 * Query defaults (`createQueryClient`, `mutations.retry: 1`), with only the
 * network swapped for a link the test answers by hand.
 *
 * Why the real defaults: the bug this file exists for lived in them. The
 * global `retry: 1` re-sent every refused sale on the same idempotency key a
 * second later; the server answered IDEMPOTENCY_LOCK_IN_PROGRESS, and that is
 * all the till ever saw. A test with a hand-built QueryClient would have
 * passed.
 *
 * No JSX: this file runs in the `unit` project, which compiles with the
 * classic runtime (see vitest.config.ts).
 */
import { createElement, useState, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { MutationObserver, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRouter } from "@th/trpc";

/** Android's back button: listeners in registration order, last one first. */
const rn = vi.hoisted(() => ({ back: [] as Array<() => boolean> }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      rn.back.push(listener);
      return {
        remove: () => {
          rn.back.splice(rn.back.indexOf(listener), 1);
        },
      };
    },
    exitApp: vi.fn(),
  },
}));
/** True when a listener handled it (the activity would NOT finish). */
const pressBack = () => [...rn.back].reverse().some((listener) => listener());

vi.mock("@sentry/react-native", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../../config/api", () => ({
  getTrpcHttpUrl: () => "http://scanner.test/trpc",
  getApiBaseUrl: () => "http://scanner.test",
}));
vi.mock("../../lib/capabilities", () => ({
  binarySupportsTapToPay: () => true,
  getAppEnv: () => "development",
}));

import { createQueryClient } from "../../query-client";
import { trpc } from "../../trpc";
import { SALE_MUTATION_OPTIONS } from "./sale-attempt";
import { cardClearedCopy } from "./sale-attempt";
import { SaleGuardProvider, useSaleGuardHost } from "./sale-guard";
import type { CartQuote } from "./sell-quote";
import { useDoorSale } from "./use-door-sale";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "33333333-3333-4333-8333-333333333333";
const GA = "22222222-2222-4222-8222-222222222222";
const ORDER = "55555555-5555-4555-8555-555555555555";

const QUOTE: CartQuote = {
  eventId: EVENT,
  currency: "usd",
  isComp: false,
  lines: [{ ticketTypeId: GA, qty: 2, unitPriceCents: 2_000, amountCents: 4_000 }],
  feesWaivedCents: 0,
  card: {
    ticketSubtotalCents: 4_000,
    discountCents: 0,
    ticketTotalCents: 4_000,
    platformFeeCents: 200,
    processingFeeCents: 168,
    taxLines: [{ code: "SALES", label: "Sales tax", rateBps: 925, amountCents: 404 }],
    taxAmountCents: 404,
    totalCents: 4_772,
  },
  cash: {
    ticketSubtotalCents: 4_000,
    discountCents: 0,
    ticketTotalCents: 4_000,
    platformFeeCents: 0,
    processingFeeCents: 0,
    taxLines: [{ code: "SALES", label: "Sales tax", rateBps: 925, amountCents: 370 }],
    taxAmountCents: 370,
    totalCents: 4_370,
  },
};

const CASH_SALE = {
  orderId: ORDER,
  isComp: false,
  amountCents: 4_370,
  ticketCount: 2,
  discountCents: 0,
  promoCodes: [],
  changeCents: 630,
  autoAdmitted: true,
  seatLabels: [],
};

const order = (status: string) => ({
  orderId: ORDER,
  status,
  paymentChannel: "POS",
  amountCents: 4_772,
  discountCents: 0,
  promoCodes: [],
  isComp: false,
  ticketCount: 2,
  tickets: [],
});

// ── The network ─────────────────────────────────────────────────────────────

/** A refusal as the tRPC client surfaces one: an app code on `data`. */
const refusal = (appCode: string, meta?: Record<string, unknown>) =>
  TRPCClientError.from({
    error: {
      code: -32600,
      message: appCode,
      data: { appCode, httpStatus: 400, ...(meta ? { meta } : {}) },
    },
  });
/** No response at all. */
const lostAnswer = () => TRPCClientError.from(new TypeError("Network request failed"));

type Handler = (input: Record<string, unknown>) => Promise<unknown>;
let handlers: Record<string, ReturnType<typeof vi.fn<Handler>>>;

const fakeLink: TRPCLink<AppRouter> = () => ({ op }) =>
  observable((observer) => {
    const handler = handlers[op.path];
    if (!handler) {
      observer.error(TRPCClientError.from(new Error(`no handler for ${op.path}`)));
      return;
    }
    handler(op.input as Record<string, unknown>).then(
      (data) => {
        observer.next({ result: { type: "data", data } });
        observer.complete();
      },
      (err: unknown) =>
        observer.error(
          err instanceof TRPCClientError
            ? err
            : TRPCClientError.from(err instanceof Error ? err : new Error(String(err))),
        ),
    );
  });

let queryClient: QueryClient;

/** The app root's guard, as `scanner-app.tsx` holds it, for the test to drive. */
let host: ReturnType<typeof useSaleGuardHost>;
const onSaleAtRisk = vi.fn();
const onSaleIdle = vi.fn();
/** The signed-in user the app root hands the guard. */
let hostUserId: string | null = "user-1";

function GuardHost({ children }: { children?: ReactNode }) {
  host = useSaleGuardHost({ onSaleAtRisk, onSaleIdle, userId: hostUserId });
  return createElement(SaleGuardProvider, {
    registry: host.registry,
    cardCleared: host.cardCleared,
    children,
  });
}

function wrapper({ children }: { children?: ReactNode }) {
  const [client] = useState(() => trpc.createClient({ links: [fakeLink] }));
  return createElement(trpc.Provider, {
    client,
    queryClient,
    children: createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(GuardHost, null, children),
    ),
  });
}

let keyCount = 0;
const newClientKey = () => `key-${++keyCount}`;
const TICKET_TYPES = [
  { id: GA, name: "General admission", unitPriceCents: 2_000, capacityRemaining: 100 },
];

function renderSale() {
  return renderHook(
    ({ eventId }: { eventId: string }) =>
      useDoorSale({ eventId, currency: "usd", ticketTypes: TICKET_TYPES, newClientKey }),
    { initialProps: { eventId: EVENT }, wrapper },
  );
}
type Sale = ReturnType<typeof renderSale>;

/** Two GA in the cart and the server's quote in. */
async function readyCart(h: Sale) {
  act(() => h.result.current.cart.adjust(GA, 2));
  await waitFor(() => expect(h.result.current.quote.state.kind).toBe("ready"));
}

async function openCashSheet(h: Sale) {
  await readyCart(h);
  act(() => h.result.current.actions.startCash());
  expect(h.result.current.stage.kind).toBe("cash");
}

const sentKeys = (fn: ReturnType<typeof vi.fn<Handler>>) =>
  fn.mock.calls.map(([input]) => input.clientKey);

/** Longer than React Query's first retry delay (1000ms). */
const PAST_RETRY_DELAY_MS = 1_200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  keyCount = 0;
  hostUserId = "user-1";
  onSaleAtRisk.mockClear();
  onSaleIdle.mockClear();
  queryClient = createQueryClient();
  handlers = {
    "pos.quoteCart": vi.fn<Handler>(async () => QUOTE),
    "pos.recordCashSale": vi.fn<Handler>(async () => CASH_SALE),
    "pos.startSale": vi.fn<Handler>(async () => ({
      orderId: ORDER,
      clientSecret: "pi_secret",
      amountCents: 4_772,
    })),
    "pos.cancelSale": vi.fn<Handler>(async () => ({ cancelled: true })),
    "pos.listSellableItems": vi.fn<Handler>(async () => ({ ticketTypes: [] })),
    "pos.completeSale": vi.fn<Handler>(async () => order("PENDING")),
  };
});

afterEach(() => {
  // No vitest globals here, so Testing Library can't unmount on its own.
  cleanup();
  queryClient.clear();
});

// ── The mutation options ────────────────────────────────────────────────────

describe("sale mutations never retry on their own", () => {
  it("control: the app's defaults DO retry a mutation (so this file can fail)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("refused");
    });
    const observer = new MutationObserver(createQueryClient(), { mutationFn: fn });
    await observer.mutate().catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("SALE_MUTATION_OPTIONS overrides the default: one call per press", async () => {
    const fn = vi.fn(async () => {
      throw new Error("refused");
    });
    const observer = new MutationObserver(createQueryClient(), {
      mutationFn: fn,
      ...SALE_MUTATION_OPTIONS,
    });
    await observer.mutate().catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a refused cash sale reaches the server ONCE, and the till sees the real refusal", async () => {
    handlers["pos.recordCashSale"]!.mockImplementation(async () => {
      throw refusal("CASH_AMOUNT_SHORT", { requiredTotalCents: 4_500 });
    });
    const h = renderSale();
    await openCashSheet(h);

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.busy).toBe(false));
    await sleep(PAST_RETRY_DELAY_MS);

    expect(handlers["pos.recordCashSale"]).toHaveBeenCalledTimes(1);
    // CASH_AMOUNT_SHORT, not "Still being processed".
    expect(h.result.current.attempt.lock).toBeNull();
    expect(h.result.current.attempt.mayAlreadyBeRecorded).toBe(false);
  });

  it("a refused card start reaches the server ONCE", async () => {
    handlers["pos.startSale"]!.mockImplementation(async () => {
      throw refusal("TICKET_TYPE_SOLD_OUT");
    });
    const h = renderSale();
    await readyCart(h);
    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.busy).toBe(false));
    await sleep(PAST_RETRY_DELAY_MS);
    expect(handlers["pos.startSale"]).toHaveBeenCalledTimes(1);
    expect(h.result.current.unresolved).toBe(false);
  });
});

// ── Outcomes ────────────────────────────────────────────────────────────────

describe("what a cash press leads to", () => {
  it("CASH_AMOUNT_SHORT keeps the sheet, shows the server's new total, re-asks the quote, and rotates the key", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw refusal("CASH_AMOUNT_SHORT", { requiredTotalCents: 4_500 });
    });
    const h = renderSale();
    await openCashSheet(h);
    const quotesBefore = handlers["pos.quoteCart"]!.mock.calls.length;

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.busy).toBe(false));

    const stage = h.result.current.stage;
    expect(stage.kind).toBe("cash");
    if (stage.kind === "cash") expect(stage.dueOverride).toBe(4_500);
    await waitFor(() =>
      expect(handlers["pos.quoteCart"]!.mock.calls.length).toBeGreaterThan(quotesBefore),
    );

    // The second press is a NEW attempt: the refused key is spent server-side.
    act(() => h.result.current.actions.confirmCash(4_500));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
    const [first, second] = sentKeys(handlers["pos.recordCashSale"]!);
    expect(second).not.toBe(first);
  });

  it("a tax refusal goes back to the cart, says why, and re-asks the quote", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw refusal("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false });
    });
    const h = renderSale();
    await openCashSheet(h);
    const quotesBefore = handlers["pos.quoteCart"]!.mock.calls.length;

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.busy).toBe(false));

    expect(h.result.current.stage.kind).toBe("browse");
    expect(h.result.current.saleError).not.toBeNull();
    await waitFor(() =>
      expect(handlers["pos.quoteCart"]!.mock.calls.length).toBeGreaterThan(quotesBefore),
    );
  });

  it("a lost answer keeps the key for THAT tender and shuts the others", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.busy).toBe(false));
    expect(h.result.current.attempt.lock).toEqual({ tender: "cash", reason: "no-answer" });
    expect(h.result.current.open.sheetComp).toBe(false);
    expect(h.result.current.open.card).toBe(false);

    // The replay goes out under the SAME key and lands the stored sale.
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
    const [first, second] = sentKeys(handlers["pos.recordCashSale"]!);
    expect(second).toBe(first);
  });

  it("a lost card start keeps the card's key and Cash won't open", async () => {
    handlers["pos.startSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await readyCart(h);
    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.busy).toBe(false));
    expect(h.result.current.attempt.lock?.tender).toBe("card");

    act(() => h.result.current.actions.startCash());
    expect(h.result.current.stage.kind).toBe("browse");

    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.stage.kind).toBe("tap-to-pay"));
    const [first, second] = sentKeys(handlers["pos.startSale"]!);
    expect(second).toBe(first);
  });
});

// ── Answers that land after the sale moved on ──────────────────────────────

describe("an answer for a sale that was cleared is dropped", () => {
  it("an event switch mid-press: the old event's cash sale never lands on the new screen", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.recordCashSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await openCashSheet(h);

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.busy).toBe(true));

    h.rerender({ eventId: OTHER_EVENT });
    expect(h.result.current.stage.kind).toBe("browse");
    expect(h.result.current.busy).toBe(false);

    await act(async () => {
      settle(CASH_SALE);
      await sleep(0);
    });
    expect(h.result.current.stage.kind).toBe("browse");
    expect(h.result.current.attempt.key).toBeNull();
  });

  it("an event switch mid-press: a late lost-answer doesn't lock the new event's till", async () => {
    let fail!: (err: unknown) => void;
    handlers["pos.startSale"]!.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)),
    );
    const h = renderSale();
    await readyCart(h);
    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.busy).toBe(true));

    h.rerender({ eventId: OTHER_EVENT });
    await act(async () => {
      fail(lostAnswer());
      await sleep(0);
    });
    expect(h.result.current.attempt.lock).toBeNull();
    expect(h.result.current.stage.kind).toBe("browse");
  });

  it("a card start that answers after a clear doesn't open the reader", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.startSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await readyCart(h);
    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.busy).toBe(true));

    act(() => h.result.current.actions.resetSale());
    await act(async () => {
      settle({ orderId: ORDER, clientSecret: "pi_secret", amountCents: 4_772 });
      await sleep(0);
    });
    expect(h.result.current.stage.kind).toBe("browse");
  });
});

// ── Closing a card sale ─────────────────────────────────────────────────────

/** Tap to Pay answered; the reader screen is up. */
async function openReader(h: Sale) {
  await readyCart(h);
  act(() => h.result.current.actions.tapToPay());
  await waitFor(() => expect(h.result.current.stage.kind).toBe("tap-to-pay"));
}

async function cancelCard(h: Sale) {
  act(() => h.result.current.actions.cancelCard());
  await waitFor(() => expect(h.result.current.busy).toBe(false));
}

describe("Cancel on the reader screen", () => {
  it("a cancel that goes through returns to the cart with a fresh key", async () => {
    const h = renderSale();
    await openReader(h);
    await cancelCard(h);
    expect(h.result.current.stage.kind).toBe("browse");
    expect(h.result.current.attempt.key).toBeNull();
  });

  it("a cancel that finds the card PAID shows the card sale, never the cart's Cash", async () => {
    handlers["pos.cancelSale"]!.mockImplementation(async () => {
      throw refusal("ORDER_NOT_PENDING");
    });
    handlers["pos.completeSale"]!.mockImplementation(async () => order("SUCCEEDED"));
    const h = renderSale();
    await openReader(h);
    await cancelCard(h);
    const stage = h.result.current.stage;
    expect(stage.kind).toBe("result");
    if (stage.kind === "result") expect(stage.sale.tender).toBe("card");
  });

  it("a LOST cancel on a PENDING order: unknown, cancel sent ONCE, Check again re-sends it", async () => {
    handlers["pos.cancelSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openReader(h);
    await cancelCard(h);
    await sleep(PAST_RETRY_DELAY_MS);

    // SALE_MUTATION_OPTIONS on cancelSale: no automatic retry.
    expect(handlers["pos.cancelSale"]).toHaveBeenCalledTimes(1);
    const stage = h.result.current.stage;
    expect(stage.kind).toBe("card-closing");
    if (stage.kind === "card-closing") {
      expect(stage.view?.label).toBe("Card sale not closed");
      expect(stage.view?.explanation).toMatch(/may have gone through/);
      expect(stage.view?.explanation).not.toMatch(/unpaid/i);
    }
    expect(h.result.current.open.cash).toBe(false);

    act(() => h.result.current.actions.checkCardAgain());
    await waitFor(() => expect(h.result.current.stage.kind).toBe("browse"));
    expect(handlers["pos.cancelSale"]).toHaveBeenCalledTimes(2);
  });

  // There is no "refused" outcome: a refusal can't tell the till whether the
  // card went through, so it is unknown like any other, and the screen has
  // no Clear of its own. Leaving the tab ("Clear it anyway") is the way out.
  it.each(["INSUFFICIENT_ROLE", "NOT_A_POS_ORDER", "EVENT_NOT_FOUND"])(
    "a %s refusal is unknown: no in-screen Clear, Cash stays shut",
    async (code) => {
      handlers["pos.cancelSale"]!.mockImplementation(async () => {
        throw refusal(code);
      });
      const h = renderSale();
      await openReader(h);
      await cancelCard(h);
      const stage = h.result.current.stage;
      expect(stage.kind).toBe("card-closing");
      if (stage.kind === "card-closing") {
        expect(stage.view?.label).toBe("Card sale not closed");
        expect(stage.view?.settling).toBe(false);
      }
      expect(Object.keys(h.result.current.actions)).not.toContain(
        "clearAfterFailedClose",
      );
      expect(h.result.current.open.cash).toBe(false);
      expect(h.result.current.open.card).toBe(false);
    },
  );

  it("PAID but not finalised: 'Confirming card', settling, and the poll stays on", async () => {
    handlers["pos.cancelSale"]!.mockImplementation(async () => {
      throw refusal("ORDER_NOT_PROCESSABLE");
    });
    handlers["pos.completeSale"]!.mockImplementation(async () => order("PROCESSING"));
    const h = renderSale();
    await openReader(h);
    await cancelCard(h);
    const stage = h.result.current.stage;
    expect(stage.kind).toBe("card-closing");
    if (stage.kind === "card-closing") expect(stage.view?.settling).toBe(true);
  });

  it("the poll moves an unknown close on by itself once the server says SUCCEEDED", async () => {
    handlers["pos.cancelSale"]!.mockImplementation(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openReader(h);
    await cancelCard(h);
    expect(h.result.current.stage.kind).toBe("card-closing");

    handlers["pos.completeSale"]!.mockImplementation(async () => order("SUCCEEDED"));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"), {
      timeout: 5_000,
    });
  });
});

// ── The navigation guard ────────────────────────────────────────────────────

describe("leaving the Sell tab while a sale is at risk", () => {
  it("a plain cart leaves without asking", async () => {
    const h = renderSale();
    await readyCart(h);
    const go = vi.fn();
    act(() => host.guard(go));
    expect(go).toHaveBeenCalledOnce();
    expect(h.result.current.stage.kind).toBe("browse");
  });

  it("a tap in the SAME frame as the press is guarded (the risk is read live)", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.startSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await readyCart(h);
    const go = vi.fn();
    act(() => {
      h.result.current.actions.tapToPay();
      host.guard(go);
    });
    expect(go).not.toHaveBeenCalled();
    expect(host.pending?.risk).toBe("sending");
    await waitFor(() => expect(handlers["pos.startSale"]).toHaveBeenCalled());
    await act(async () => {
      settle({ orderId: ORDER, clientSecret: "pi_secret", amountCents: 4_772 });
      await sleep(0);
    });
    // The copy follows the live risk: the press became an open card sale.
    expect(host.pending?.risk).toBe("card");
  });

  it("Keep it keeps the sale; Clear it anyway clears it and goes", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.unresolved).toBe(true));

    const go = vi.fn();
    act(() => host.guard(go));
    expect(host.pending?.risk).toBe("unresolved");
    act(() => host.pending!.keep());
    expect(go).not.toHaveBeenCalled();
    expect(h.result.current.unresolved).toBe(true);

    act(() => host.guard(go));
    act(() => host.pending!.clearAnyway());
    expect(go).toHaveBeenCalledOnce();
    expect(h.result.current.unresolved).toBe(false);
    expect(h.result.current.stage.kind).toBe("browse");
  });

  it("the confirm goes away by itself when the sale stops being at risk", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.unresolved).toBe(true));
    const go = vi.fn();
    act(() => host.guard(go));
    expect(host.pending).not.toBeNull();

    // The replay lands the stored sale: done screen, nothing at risk.
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
    await waitFor(() => expect(host.pending).toBeNull());
    expect(go).not.toHaveBeenCalled();
  });

  it("Clear it anyway on an open card sale fires a best-effort cancel and leaves 'don't take cash'", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.cancelSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await openReader(h);
    act(() => host.guard(() => undefined));
    expect(host.pending?.risk).toBe("card");
    act(() => host.pending!.clearAnyway());
    await waitFor(() =>
      expect(handlers["pos.cancelSale"]).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER }),
      ),
    );
    // Before the cancel answers: the cautious wording, at once.
    expect(h.result.current.cardCleared.kind).toBe("unconfirmed");
    // The event switch the operator asked for: the next screen still says it.
    h.rerender({ eventId: OTHER_EVENT });
    expect(h.result.current.cardCleared.kind).toBe("unconfirmed");
    await act(async () => {
      settle({ cancelled: true });
      await sleep(0);
    });
    expect(h.result.current.cardCleared.kind).toBe("cancelled");
  });

  it("pins the event the moment a sale is at risk", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);
    expect(onSaleAtRisk).not.toHaveBeenCalled();
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.unresolved).toBe(true));
    expect(onSaleAtRisk).toHaveBeenCalled();
  });

  it("Android back: asks while a sale is at risk, means Keep it while asking, and leaves otherwise", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);
    let handled = true;
    act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(false);

    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.unresolved).toBe(true));
    act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(true);
    expect(host.pending?.risk).toBe("unresolved");

    act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(true);
    expect(host.pending).toBeNull();
    expect(h.result.current.unresolved).toBe(true);
  });
});

// ── The card-cleared notice ─────────────────────────────────────────────────

/** Open card sale → the guard → "Clear it anyway". */
async function clearOpenCardSale(h: Sale, how: "back" | "tab") {
  await openReader(h);
  if (how === "back") {
    act(() => {
      pressBack();
    });
  } else {
    act(() => host.guard(() => undefined));
  }
  expect(host.pending?.risk).toBe("card");
  act(() => host.pending!.clearAnyway());
  await waitFor(() => expect(handlers["pos.cancelSale"]).toHaveBeenCalled());
}

describe("the card-cleared notice", () => {
  it("Android back + Clear it anyway: shows on the SAME mount, at once", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    expect(h.result.current.stage.kind).toBe("browse");
    expect(h.result.current.cardCleared.kind).not.toBeNull();
    // Nothing else carries it: the sale error stays free for the next press.
    expect(h.result.current.saleError).toBeNull();
  });

  it("survives adjust and startCash, and shows in the cash stage", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    await waitFor(() => expect(h.result.current.cardCleared.kind).toBe("cancelled"));

    act(() => h.result.current.cart.adjust(GA, 1));
    expect(h.result.current.cardCleared.kind).toBe("cancelled");
    await openCashSheet(h);
    expect(h.result.current.stage.kind).toBe("cash");
    expect(h.result.current.cardCleared.kind).toBe("cancelled");
  });

  it("survives compInstead (tax down), and shows on the comp sheet", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    handlers["pos.quoteCart"]!.mockImplementation(async () => {
      throw refusal("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false });
    });
    // A cart never quoted before, so the refusal is the answer it gets.
    act(() => h.result.current.cart.adjust(GA, 3));
    await waitFor(() => expect(h.result.current.quote.state.kind).toBe("tax-refused"));
    act(() => h.result.current.actions.compInstead());
    expect(h.result.current.stage.kind).toBe("cash");
    expect(h.result.current.cardCleared.kind).not.toBeNull();
  });

  it("Dismiss clears it", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    act(() => h.result.current.cardCleared.dismiss());
    expect(h.result.current.cardCleared.kind).toBeNull();
  });

  it("a cancel that answers AFTER a dismiss doesn't bring it back", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.cancelSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    act(() => h.result.current.cardCleared.dismiss());
    await act(async () => {
      settle({ cancelled: true });
      await sleep(0);
    });
    expect(h.result.current.cardCleared.kind).toBeNull();
  });

  it("the next completed sale clears it", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "back");
    await openCashSheet(h);
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
    expect(h.result.current.cardCleared.kind).toBeNull();
  });

  it("names the OLD sale by the amount the reader was asking for", async () => {
    // The reader asks for a total that differs from the quote's card total
    // (4_772), so a notice that read the quote would show the wrong amount.
    handlers["pos.startSale"]!.mockImplementationOnce(async () => ({
      orderId: ORDER,
      clientSecret: "pi_secret",
      amountCents: 4_900,
    }));
    // The cancel never answers, so the notice stays "unconfirmed" (the title
    // asserted below). The default handler answers at once and races the read.
    handlers["pos.cancelSale"]!.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const h = renderSale();
    await clearOpenCardSale(h, "tab");
    expect(h.result.current.cardCleared.kind).toBe("unconfirmed");
    expect(h.result.current.cardCleared.amount).toBe("$49.00");
    const { title } = cardClearedCopy(
      h.result.current.cardCleared.kind!,
      h.result.current.cardCleared.amount,
    );
    expect(title).toBe("Don't take cash for the $49.00 card sale you cleared");
  });

  describe("an older cancel's answer can't re-word a newer notice", () => {
    /** Open the reader and "Clear it anyway" from the tab bar. */
    async function clearAgain(h: Sale, nthCancel: number) {
      await openReader(h);
      act(() => host.guard(() => undefined));
      act(() => host.pending!.clearAnyway());
      await waitFor(() =>
        expect(handlers["pos.cancelSale"]).toHaveBeenCalledTimes(nthCancel),
      );
    }

    it("sale 1 answers 'cancelled' after sale 2 said 'maybe-paid': it stays maybe-paid", async () => {
      let settleFirst!: (value: unknown) => void;
      handlers["pos.cancelSale"]!
        .mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))
        .mockImplementationOnce(async () => {
          throw refusal("ORDER_NOT_PROCESSABLE");
        });
      const h = renderSale();
      await clearAgain(h, 1);
      expect(h.result.current.cardCleared.kind).toBe("unconfirmed");
      await clearAgain(h, 2);
      await waitFor(() => expect(h.result.current.cardCleared.kind).toBe("maybe-paid"));

      await act(async () => {
        settleFirst({ cancelled: true });
        await sleep(0);
      });
      expect(h.result.current.cardCleared.kind).toBe("maybe-paid");
    });

    it("sale 1 answers after a cash sale completed (notice cleared): it stays cleared", async () => {
      let settleFirst!: (value: unknown) => void;
      handlers["pos.cancelSale"]!.mockImplementationOnce(
        () => new Promise((resolve) => (settleFirst = resolve)),
      );
      const h = renderSale();
      await clearAgain(h, 1);
      await openCashSheet(h);
      act(() => h.result.current.actions.confirmCash(4_370));
      await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
      expect(h.result.current.cardCleared.kind).toBeNull();

      await act(async () => {
        settleFirst({ cancelled: true });
        await sleep(0);
      });
      expect(h.result.current.cardCleared.kind).toBeNull();
    });
  });

  it("Android back is swallowed while a notice is held, and works again after Dismiss", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "tab");
    expect(h.result.current.cardCleared.kind).not.toBeNull();
    // No risk now (the cart was cleared), only the notice.
    expect(host.pending).toBeNull();
    expect(pressBack()).toBe(true);
    expect(h.result.current.cardCleared.kind).not.toBeNull();

    act(() => h.result.current.cardCleared.dismiss());
    expect(pressBack()).toBe(false);
  });

  it("a different signed-in user dismisses it; the same user's re-render doesn't", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "tab");
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).not.toBeNull();

    hostUserId = "user-2";
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).toBeNull();
  });

  it("a sign-out and the SAME user signing back in keeps it (a 401 mid-shift)", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "tab");

    hostUserId = null;
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).not.toBeNull();

    hostUserId = "user-1";
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).not.toBeNull();
  });

  it("a sign-out and a DIFFERENT user signing in dismisses it", async () => {
    const h = renderSale();
    await clearOpenCardSale(h, "tab");

    hostUserId = null;
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).not.toBeNull();

    hostUserId = "user-2";
    h.rerender({ eventId: EVENT });
    expect(h.result.current.cardCleared.kind).toBeNull();
  });

  // Each answer to the best-effort cancel re-words the notice.
  it.each([
    ["the cancel goes through", async () => ({ cancelled: true }), "cancelled"],
    [
      "ORDER_NOT_FOUND (nothing to charge)",
      async () => {
        throw refusal("ORDER_NOT_FOUND");
      },
      "cancelled",
    ],
    [
      "ORDER_NOT_PROCESSABLE (Stripe wouldn't void it)",
      async () => {
        throw refusal("ORDER_NOT_PROCESSABLE");
      },
      "maybe-paid",
    ],
    [
      "no answer",
      async () => {
        throw lostAnswer();
      },
      "unconfirmed",
    ],
    [
      "any other refusal",
      async () => {
        throw refusal("INSUFFICIENT_ROLE");
      },
      "unconfirmed",
    ],
  ] as const)("%s → %s", async (_name, answer, kind) => {
    handlers["pos.cancelSale"]!.mockImplementationOnce(answer);
    const h = renderSale();
    await clearOpenCardSale(h, "tab");
    await waitFor(() => expect(h.result.current.cardCleared.kind).toBe(kind));
  });
});

// ── Remounts (the tab path) ─────────────────────────────────────────────────

/**
 * The app as the tab bar runs it: the guard host stays, the Sell screen
 * unmounts and mounts again.
 */
function renderTabs() {
  const sell: { current: ReturnType<typeof useDoorSale> | null } = { current: null };
  let setShown!: (shown: boolean) => void;
  function SellProbe() {
    sell.current = useDoorSale({ eventId: EVENT, currency: "usd", ticketTypes: TICKET_TYPES, newClientKey });
    return null;
  }
  function Tabs() {
    const [shown, set] = useState(true);
    setShown = set;
    return shown ? createElement(SellProbe) : null;
  }
  render(createElement(Tabs), { wrapper });
  const show = (shown: boolean) =>
    act(() => {
      if (!shown) sell.current = null;
      setShown(shown);
    });
  return { sell, show };
}

describe("the notice across a Sell remount", () => {
  async function openReaderIn(tabs: ReturnType<typeof renderTabs>) {
    act(() => tabs.sell.current!.cart.adjust(GA, 2));
    await waitFor(() => expect(tabs.sell.current!.quote.state.kind).toBe("ready"));
    act(() => tabs.sell.current!.actions.tapToPay());
    await waitFor(() => expect(tabs.sell.current!.stage.kind).toBe("tap-to-pay"));
  }

  it("a tab press + Clear it anyway: the next Sell mount shows it", async () => {
    const tabs = renderTabs();
    await openReaderIn(tabs);
    act(() => host.guard(() => tabs.show(false)));
    act(() => host.pending!.clearAnyway());
    expect(tabs.sell.current).toBeNull();
    tabs.show(true);
    expect(tabs.sell.current!.cardCleared.kind).not.toBeNull();
    expect(tabs.sell.current!.stage.kind).toBe("browse");
  });

  it("Android back works while the Sell screen is gone, even with a notice held", async () => {
    const tabs = renderTabs();
    await openReaderIn(tabs);
    act(() => host.guard(() => tabs.show(false)));
    act(() => host.pending!.clearAnyway());
    expect(tabs.sell.current).toBeNull();
    // Held, but nowhere on screen: back must not be dead on Home or Scan.
    expect(host.cardCleared.kind).not.toBeNull();
    expect(pressBack()).toBe(false);

    // Sell is up again, with the notice and its Dismiss: back holds for it.
    tabs.show(true);
    expect(tabs.sell.current!.cardCleared.kind).not.toBeNull();
    expect(pressBack()).toBe(true);
  });

  it("after a dismiss, a remount shows nothing stale", async () => {
    const tabs = renderTabs();
    await openReaderIn(tabs);
    act(() => host.guard(() => undefined));
    act(() => host.pending!.clearAnyway());
    act(() => tabs.sell.current!.cardCleared.dismiss());
    tabs.show(false);
    tabs.show(true);
    expect(tabs.sell.current!.cardCleared.kind).toBeNull();
  });

  it("after a completed sale, a remount shows nothing stale", async () => {
    const tabs = renderTabs();
    await openReaderIn(tabs);
    act(() => host.guard(() => undefined));
    act(() => host.pending!.clearAnyway());
    await waitFor(() => expect(tabs.sell.current!.cardCleared.kind).toBe("cancelled"));
    act(() => tabs.sell.current!.cart.adjust(GA, 2));
    await waitFor(() => expect(tabs.sell.current!.quote.state.kind).toBe("ready"));
    act(() => tabs.sell.current!.actions.startCash());
    act(() => tabs.sell.current!.actions.confirmCash(4_370));
    await waitFor(() => expect(tabs.sell.current!.stage.kind).toBe("result"));
    act(() => tabs.sell.current!.actions.resetSale());
    tabs.show(false);
    tabs.show(true);
    expect(tabs.sell.current!.cardCleared.kind).toBeNull();
  });
});

// ── Letting go of the event pin ─────────────────────────────────────────────

describe("the till reports when it is idle", () => {
  it("not when the risk goes away (the done screen), but on Next sale", async () => {
    handlers["pos.recordCashSale"]!.mockImplementationOnce(async () => {
      throw lostAnswer();
    });
    const h = renderSale();
    await openCashSheet(h);
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.unresolved).toBe(true));
    expect(onSaleAtRisk).toHaveBeenCalled();
    onSaleIdle.mockClear();

    // The replay lands: nothing at risk, but "Change $6.30" is on screen.
    act(() => h.result.current.actions.confirmCash(4_370));
    await waitFor(() => expect(h.result.current.stage.kind).toBe("result"));
    expect(onSaleIdle).not.toHaveBeenCalled();

    act(() => h.result.current.actions.resetSale());
    expect(onSaleIdle).toHaveBeenCalledOnce();
  });

  it("a cart emptied back to zero is idle; a cart with tickets isn't", async () => {
    const h = renderSale();
    onSaleIdle.mockClear();
    await readyCart(h);
    expect(onSaleIdle).not.toHaveBeenCalled();
    act(() => h.result.current.cart.adjust(GA, -2));
    expect(onSaleIdle).toHaveBeenCalledOnce();
  });

  it("a press still sending isn't idle: no release, and the steppers hold", async () => {
    let settle!: (value: unknown) => void;
    handlers["pos.startSale"]!.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const h = renderSale();
    await readyCart(h);
    onSaleIdle.mockClear();
    act(() => h.result.current.actions.tapToPay());
    await waitFor(() => expect(h.result.current.busy).toBe(true));

    // The operator can't step the cart to 0 under the press...
    act(() => h.result.current.cart.adjust(GA, -2));
    expect(h.result.current.cart.cartCount).toBe(2);
    expect(onSaleIdle).not.toHaveBeenCalled();
    // ...and even an `idle` report that lags the live risk is ignored.
    act(() => host.registry.notifyIdle(true));
    expect(onSaleIdle).not.toHaveBeenCalled();

    await act(async () => {
      settle({ orderId: ORDER, clientSecret: "pi_secret", amountCents: 4_772 });
      await sleep(0);
    });
    await waitFor(() => expect(h.result.current.stage.kind).toBe("tap-to-pay"));
  });

  it("the Sell screen going away is idle", async () => {
    const h = renderSale();
    await readyCart(h);
    onSaleIdle.mockClear();
    h.unmount();
    expect(onSaleIdle).toHaveBeenCalled();
  });
});
