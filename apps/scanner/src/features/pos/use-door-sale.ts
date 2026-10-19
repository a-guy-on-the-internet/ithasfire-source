/**
 * The Sell screen's state machine: the cart, the promo codes, the server
 * quote, the sale's idempotency key, and every press (Tap to Pay, cash,
 * comp, closing a card sale). `sell-screen.tsx` only renders what this
 * returns.
 *
 * Everything about money is server-decided. The cart is priced by
 * `pos.quoteCart` (card AND cash: the same price, fees and tax online
 * checkout charges; cash carries no platform or processing fee, owner ruling
 * 2026-10-08) and sold through `pos.startSale` / `pos.recordCashSale`, which
 * re-price every line themselves. Nothing here works out a total.
 *
 *   browse ─ Tap to Pay ─▶ tap-to-pay ─ success ─────────────▶ result
 *      │                       └─ Cancel/Back ─▶ card-closing ─┬▶ browse (closed)
 *      │                                                       ├▶ result (it was paid)
 *      │                                                       └─ stays (unknown/failed)
 *      └─ Cash / Comp instead ─▶ cash ─ Confirm cash / Comp ──▶ result
 *
 * Idempotency: one key per sale (`sale-attempt.ts`). A lost answer keeps the
 * key and locks the cart, codes, email and the other tenders; pressing the
 * same tender again replays the stored sale instead of selling twice. The
 * sale mutations never retry on their own (`SALE_MUTATION_OPTIONS`).
 *
 * A sale GENERATION guards every await: a reset (Next sale, Clear, an event
 * switch, leaving the tab) bumps it, and an answer that lands for an older
 * generation is dropped instead of landing on the next sale's screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { binarySupportsTapToPay } from "../../lib/capabilities";
import { trpc } from "../../trpc";

import type { DoneSale } from "./cash-tender";
import {
  EMPTY_PROMO_STATE,
  cartKeyOf,
  createPromoController,
  isPromoSettled,
  normalizePromoCode,
  saleErrorMessage,
  type PromoContext,
  type PromoController,
  type PromoState,
  type PromoTicketSelection,
} from "./promo-entry";
import {
  CLOSE_DEFERRED_VIEW,
  NEW_ATTEMPT,
  SALE_MUTATION_OPTIONS,
  attemptAnswered,
  attemptFailed,
  closeOpenCardSale,
  cardClearedAfterCancel,
  closeOutcomeView,
  isUnresolved,
  keyForPress,
  saleLeaveRisk,
  stageAfterClose,
  tenderOpen,
  type CloseView,
  type CompletedSale,
  type SaleAttempt,
} from "./sale-attempt";
import {
  buyerEmailForSale,
  formatMoney,
  emailBlocksSale,
  readCashShortTotal,
  readTaxRefusal,
  type CartQuote,
  type SaleItems,
} from "./sell-quote";
import { useCardClearedNotice, useReportSaleGuard } from "./sale-guard";
import type { TicketTypeRow } from "./ticket-type-rows";
import { useDoorQuote } from "./use-door-quote";

type CartLine = { ticketTypeId: string; qty: number };

/**
 * The sale as it stood when the operator left the cart: the exact lines and
 * codes the quote priced, and that quote. Every sale call sends THESE, never
 * the live cart. `quote` is null only for a comp taken while the tax lookup
 * is down (a comp charges no tax, so it needs no quote).
 */
type SaleSnapshot = {
  items: SaleItems;
  promoCodes: string[] | undefined;
  quote: CartQuote | null;
};

export type Stage =
  | { kind: "browse" }
  | {
      kind: "cash";
      sale: SaleSnapshot;
      /** The server's cash total after a CASH_AMOUNT_SHORT refusal. */
      dueOverride: number | null;
    }
  | {
      kind: "tap-to-pay";
      orderId: string;
      clientSecret: string;
      /** `startSale.amountCents`: what the reader asks for. */
      amountCents: number;
      /** The card total the quote showed, for the "total changed" notice. */
      quotedCents: number | null;
    }
  | {
      kind: "card-closing";
      orderId: string;
      amountCents: number;
      /**
       * Null while the first close runs; then what the till knows. There is
       * no in-screen Clear (see `CloseOutcome`); leaving the tab is the way
       * out, behind "Clear this sale?".
       */
      view: CloseView | null;
    }
  | { kind: "result"; sale: DoneSale };

/** A cart's lines as the sale procedures take them, or null when empty. */
function toSaleItems(cart: CartLine[]): SaleItems | null {
  const [first, ...rest] = cart.filter((line) => line.qty > 0);
  return first ? ([first, ...rest] as SaleItems) : null;
}
export function useDoorSale({
  eventId,
  currency,
  ticketTypes,
  newClientKey,
}: {
  eventId: string;
  /** The event's currency, for the amount in the card-cleared notice. */
  currency: string;
  ticketTypes: TicketTypeRow[];
  /** Mints a new idempotency key; called once per SALE, not per press. */
  newClientKey: () => string;
}) {
  const utils = trpc.useUtils();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [stage, setStageState] = useState<Stage>({ kind: "browse" });
  /**
   * Mirror of `stage` for reads AFTER an await: a handler's `stage` is the
   * render that created it, and a guard placed after an await would re-check
   * a stale snapshot and clobber a newer state.
   */
  const stageRef = useRef<Stage>(stage);
  const setStage = useCallback((next: Stage) => {
    stageRef.current = next;
    setStageState(next);
  }, []);
  const [attempt, setAttemptState] = useState<SaleAttempt>(NEW_ATTEMPT);
  const attemptRef = useRef<SaleAttempt>(attempt);
  const setAttempt = useCallback((next: SaleAttempt) => {
    attemptRef.current = next;
    setAttemptState(next);
  }, []);
  const [busy, setBusy] = useState(false);
  // Blocks same-tick double taps; `busy` drives the visible state.
  const busyRef = useRef(false);
  const [buyerEmail, setBuyerEmail] = useState("");
  /** The address the in-flight card sale was started with. */
  const cardEmailRef = useRef<string | null>(null);
  /** A sale-time refusal, shown on the cart and on the cash sheet. */
  const [saleError, setSaleError] = useState<string | null>(null);

  /**
   * Bumped by every reset. A handler notes it before its first await and
   * drops its answer if it changed meanwhile (`isStale`).
   */
  const saleGenRef = useRef(0);
  const isStale = (gen: number) => saleGenRef.current !== gen;
  useEffect(
    () => () => {
      // Unmounted (the tab was left after "Clear it anyway"): nothing in
      // flight may land.
      saleGenRef.current += 1;
    },
    [],
  );

  const startSale = trpc.pos.startSale.useMutation(SALE_MUTATION_OPTIONS);
  const recordCash = trpc.pos.recordCashSale.useMutation(SALE_MUTATION_OPTIONS);
  const cancelSale = trpc.pos.cancelSale.useMutation(SALE_MUTATION_OPTIONS);

  // ── Promo codes ────────────────────────────────────────────────────────
  const [promo, setPromo] = useState<PromoState>(EMPTY_PROMO_STATE);
  const [promoInput, setPromoInput] = useState("");
  const utilsRef = useRef(utils);
  useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);
  const promoContextRef = useRef<PromoContext>({ eventId, selections: [] });
  const promoControllerRef = useRef<PromoController | null>(null);
  if (promoControllerRef.current === null) {
    promoControllerRef.current = createPromoController({
      // Imperative on purpose (no cache): an Apply press always hits the
      // server and errors surface as thrown rejections rendered inline.
      preview: (request) =>
        utilsRef.current.client.promos.preview.query(request),
      onChange: setPromo,
      getCart: () => promoContextRef.current,
    });
  }
  const promoController = promoControllerRef.current;
  useEffect(() => () => promoControllerRef.current?.dispose(), []);

  const cartByTicketType = useMemo(() => {
    const m = new Map<string, number>();
    for (const line of cart)
      m.set(line.ticketTypeId, (m.get(line.ticketTypeId) ?? 0) + line.qty);
    return m;
  }, [cart]);
  const ticketNames = useMemo(
    () => new Map(ticketTypes.map((tt) => [tt.id, tt.name])),
    [ticketTypes],
  );
  const cartCount = cart.reduce((n, l) => n + l.qty, 0);
  const selections = useMemo<PromoTicketSelection[]>(
    () => cart.map((l) => ({ ticketTypeId: l.ticketTypeId, qty: l.qty })),
    [cart],
  );
  const cartKey = useMemo(() => cartKeyOf(selections), [selections]);
  const promoContext = useMemo(
    () => ({ eventId, selections }),
    [eventId, selections],
  );
  // Every cart change re-previews the codes (debounced in the controller).
  useEffect(() => {
    promoContextRef.current = promoContext;
    promoController.syncCart(promoContext);
  }, [promoController, promoContext]);

  const promoSettled = isPromoSettled(promo, cartKey);
  const settledCodes = useMemo(
    () => (promo.codes.length > 0 ? [...promo.codes] : undefined),
    [promo.codes],
  );

  // ── The quote ──────────────────────────────────────────────────────────
  const quote = useDoorQuote({
    eventId,
    lines: cart,
    promoCodes: promoSettled ? settledCodes : undefined,
    promoSettled,
  });
  const readyQuote = quote.state.kind === "ready" ? quote.state.quote : null;

  // ── Reset ──────────────────────────────────────────────────────────────
  /** Everything a finished (or abandoned) sale must leave behind. */
  const resetSale = useCallback(() => {
    saleGenRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setCart([]);
    setPromoInput("");
    setSaleError(null);
    setBuyerEmail("");
    cardEmailRef.current = null;
    promoController.reset();
    setAttempt(NEW_ATTEMPT);
    setStage({ kind: "browse" });
  }, [promoController, setAttempt, setStage]);

  // ── Leaving the tab ────────────────────────────────────────────────────
  /**
   * "Clear it anyway" from the app root (tab press, event switch, back). An
   * open card sale gets a best-effort cancel: `cancelSale` voids the
   * PaymentIntent before it releases anything, and refuses if the card went
   * through. Fired on the plain client, so it outlives this screen.
   *
   * The "don't take cash" notice is held by the app root (`sale-guard.ts`),
   * so it shows on THIS mount (Android back), on the next mount (tab press)
   * and through every cart edit, until the next sale completes or the
   * operator dismisses it. The cancel's answer re-words it.
   */
  const cardCleared = useCardClearedNotice();
  const {
    begin: beginCardNotice,
    update: updateCardNotice,
    dismiss: dismissCardNotice,
  } = cardCleared;
  const clearForLeave = useCallback(() => {
    const now = stageRef.current;
    if (now.kind === "tap-to-pay" || now.kind === "card-closing") {
      // The amount the reader was asking for names the OLD sale in the notice.
      const token = beginCardNotice(
        "unconfirmed",
        formatMoney(now.amountCents, currency),
      );
      utilsRef.current.client.pos.cancelSale.mutate({ orderId: now.orderId }).then(
        () => updateCardNotice(token, cardClearedAfterCancel(null)),
        (err: unknown) => updateCardNotice(token, cardClearedAfterCancel(err)),
      );
    }
    resetSale();
  }, [beginCardNotice, updateCardNotice, resetSale, currency]);
  useReportSaleGuard({
    getRisk: () =>
      saleLeaveRisk({
        stage: stageRef.current.kind,
        attempt: attemptRef.current,
        busy: busyRef.current,
      }),
    risk: saleLeaveRisk({ stage: stage.kind, attempt, busy }),
    // Nothing on the till: the app may let go of the event it pinned.
    // A press still sending isn't idle: it may become a sale or a key.
    idle: stage.kind === "browse" && cartCount === 0 && !busy,
    // The done screen: a refusal held for this sale waits for "New sale".
    done: stage.kind === "result",
    clear: clearForLeave,
  });

  // A cart, codes or key from one event must never carry into another. The
  // app pins the event once a sale is at risk, so this only runs for a sale
  // with nothing to lose, or one the operator chose to clear.
  useEffect(() => {
    resetSale();
  }, [eventId, resetSale]);

  const unresolved = isUnresolved(attempt);
  const emailInvalid = emailBlocksSale(buyerEmail);

  const adjust = (ticketTypeId: string, delta: number) => {
    // Not while a press is sending: it priced the cart as it stood.
    if (isUnresolved(attemptRef.current) || busyRef.current) return;
    setSaleError(null);
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.ticketTypeId === ticketTypeId);
      if (idx === -1) {
        if (delta <= 0) return prev;
        return [...prev, { ticketTypeId, qty: delta }];
      }
      const next = [...prev];
      const newQty = (next[idx]?.qty ?? 0) + delta;
      if (newQty <= 0) next.splice(idx, 1);
      else next[idx] = { ticketTypeId, qty: newQty };
      return next;
    });
  };

  const onApplyPromo = useCallback(() => {
    const code = normalizePromoCode(promoInput);
    if (code === "") return;
    void (async () => {
      await promoController.apply(code, promoContext);
      // A rejected code stays in the field so a typo can be fixed in place.
      if (promoController.getState().codes.includes(code)) setPromoInput("");
    })();
  }, [promoController, promoContext, promoInput]);

  const beginPress = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const endPress = () => {
    busyRef.current = false;
    setBusy(false);
  };

  /** The "N left" counts moved; ask for them again. */
  const refreshCatalogue = useCallback(() => {
    void utils.pos.listSellableItems.invalidate({ eventId });
  }, [utils, eventId]);

  // ── Card ───────────────────────────────────────────────────────────────
  const finishCardSale = useCallback(
    (order: CompletedSale) => {
      // Only for the card sale on screen: a late success from a reader
      // surface that was cleared must not land on the next sale.
      const now = stageRef.current;
      if (
        (now.kind !== "tap-to-pay" && now.kind !== "card-closing") ||
        now.orderId !== order.orderId
      ) {
        return;
      }
      setAttempt(NEW_ATTEMPT);
      refreshCatalogue();
      // A sale completed: an earlier "card sale cleared" notice is spent.
      dismissCardNotice();
      setStage({
        kind: "result",
        sale: {
          orderId: order.orderId,
          tender: "card",
          amountCents: order.amountCents,
          ticketCount: order.ticketCount,
          discountCents: order.discountCents,
          promoCodes: order.promoCodes,
          changeCents: 0,
          // POS card sales auto-admit inside the payment webhook's finalise.
          autoAdmitted: true,
          seatLabels: [],
          buyerEmail: cardEmailRef.current,
        },
      });
    },
    [dismissCardNotice, refreshCatalogue, setAttempt, setStage],
  );

  const onTapToPay = async () => {
    if (!binarySupportsTapToPay()) return; // the button is hidden then
    const asked = quote.askedInput;
    if (!readyQuote || !asked || stageRef.current.kind !== "browse") return;
    if (
      !tenderOpen("card", {
        quoteReady: true,
        hasCardTotal: readyQuote.card !== null,
        attempt: attemptRef.current,
        emailInvalid,
        busy: busyRef.current,
      })
    ) {
      return;
    }
    if (!beginPress()) return;
    const gen = saleGenRef.current;
    setSaleError(null);
    const { attempt: withKey, key } = keyForPress(
      attemptRef.current,
      newClientKey,
    );
    setAttempt(withKey);
    const email = buyerEmailForSale(buyerEmail);
    try {
      const started = await startSale.mutateAsync({
        eventId,
        clientKey: key,
        items: asked.items,
        ...(asked.promoCodes ? { promoCodes: asked.promoCodes } : {}),
        ...(email ? { buyerEmail: email } : {}),
      });
      if (isStale(gen)) return;
      setAttempt(attemptAnswered(attemptRef.current));
      cardEmailRef.current = email ?? null;
      setStage({
        kind: "tap-to-pay",
        orderId: started.orderId,
        clientSecret: started.clientSecret,
        amountCents: started.amountCents,
        quotedCents: readyQuote.card?.totalCents ?? null,
      });
    } catch (err) {
      if (isStale(gen)) return;
      const settled = attemptFailed(attemptRef.current, err, "card", newClientKey);
      setAttempt(settled.attempt);
      if (!settled.handled) {
        setSaleError(saleErrorMessage(err));
        if (readTaxRefusal(err)) quote.refetch();
      }
    } finally {
      if (!isStale(gen)) endPress();
    }
  };

  /**
   * Close the open card order after Cancel / Back on the reader screen. Only
   * a CLOSED order returns to the cart (where Cash is): a card the server
   * says was paid, or might have been, is never followed by cash.
   */
  const runCardClose = async (orderId: string) => {
    if (!beginPress()) {
      // Another press holds the till. Never leave "Closing…" spinning with
      // no way on: show the checking screen, whose Check again retries.
      const now = stageRef.current;
      if (now.kind === "card-closing" && now.orderId === orderId && now.view === null) {
        setStage({ ...now, view: CLOSE_DEFERRED_VIEW });
      }
      return;
    }
    const gen = saleGenRef.current;
    const outcome = await closeOpenCardSale({
      cancel: () => cancelSale.mutateAsync({ orderId }),
      check: () => utils.client.pos.completeSale.query({ orderId }),
    });
    if (isStale(gen)) return;
    endPress();
    const now = stageRef.current;
    // The poll may have settled this sale while the cancel was in flight.
    if (now.kind !== "card-closing" || now.orderId !== orderId) return;
    switch (stageAfterClose(outcome)) {
      case "done":
        if (outcome.kind === "paid") finishCardSale(outcome.order);
        return;
      case "cart":
        // A DIFFERENT sale from here on: the cancelled order's key is spent.
        setAttempt(NEW_ATTEMPT);
        setStage({ kind: "browse" });
        return;
      case "checking":
        setStage({
          ...now,
          view: closeOutcomeView(outcome) ?? CLOSE_DEFERRED_VIEW,
        });
    }
  };

  const onCardCancel = () => {
    const now = stageRef.current;
    if (now.kind !== "tap-to-pay") return;
    setStage({
      kind: "card-closing",
      orderId: now.orderId,
      amountCents: now.amountCents,
      view: null,
    });
    void runCardClose(now.orderId);
  };

  // While a close is unresolved, ask the server until it settles one way.
  const closingOrderId =
    stage.kind === "card-closing" && stage.view !== null
      ? stage.orderId
      : null;
  const closingPoll = trpc.pos.completeSale.useQuery(
    { orderId: closingOrderId ?? "" },
    {
      enabled: closingOrderId !== null,
      refetchInterval: 3_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  useEffect(() => {
    const data = closingPoll.data;
    const now = stageRef.current;
    if (!data || now.kind !== "card-closing" || now.orderId !== data.orderId) {
      return;
    }
    if (data.status === "SUCCEEDED") finishCardSale(data);
    else if (data.status === "CANCELLED") {
      setAttempt(NEW_ATTEMPT);
      setStage({ kind: "browse" });
    }
  }, [closingPoll.data, finishCardSale, setAttempt, setStage]);

  // ── Cash and comp ──────────────────────────────────────────────────────
  /** The tender gate as of NOW (refs, not the render's snapshot). */
  const gateNow = () => ({
    quoteReady: readyQuote !== null,
    hasCardTotal: readyQuote?.card != null,
    attempt: attemptRef.current,
    emailInvalid,
    busy: busyRef.current,
  });

  const onCashStart = () => {
    const asked = quote.askedInput;
    if (!readyQuote || !asked || stageRef.current.kind !== "browse") return;
    // A key held for a card attempt locks cash out; so does a key that may
    // already hold a sale.
    if (!tenderOpen("cash", gateNow())) return;
    setSaleError(null);
    setStage({
      kind: "cash",
      sale: { items: asked.items, promoCodes: asked.promoCodes, quote: readyQuote },
      dueOverride: null,
    });
  };

  /** Tax lookup down: a comp needs no quote, so it can still go through. */
  const onCompInstead = () => {
    const items = toSaleItems(cart);
    if (!items || stageRef.current.kind !== "browse") return;
    if (quote.state.kind !== "tax-refused") return;
    if (!tenderOpen("comp", gateNow())) return;
    setSaleError(null);
    setStage({
      kind: "cash",
      sale: { items, promoCodes: undefined, quote: null },
      dueOverride: null,
    });
  };

  /**
   * Cash AND comp: both are `recordCashSale`, told apart EXPLICITLY. A comp
   * sends `comp: true`; a paid sale sends `comp: false` with the cash
   * received (never `amountCollectedCents: 0` as an implied comp: a $0 cart
   * that is $0 because of a code is a sale).
   */
  const onDoorSale = async (
    door: { kind: "cash"; receivedCents: number } | { kind: "comp" },
  ) => {
    const now = stageRef.current;
    if (now.kind !== "cash" || !beginPress()) return;
    const gen = saleGenRef.current;
    setSaleError(null);
    const { attempt: withKey, key } = keyForPress(
      attemptRef.current,
      newClientKey,
    );
    setAttempt(withKey);
    const email = buyerEmailForSale(buyerEmail);
    try {
      const result = await recordCash.mutateAsync({
        eventId,
        clientKey: key,
        items: now.sale.items,
        ...(door.kind === "comp"
          ? { comp: true, amountCollectedCents: 0 }
          : {
              comp: false,
              amountCollectedCents: door.receivedCents,
              ...(now.sale.promoCodes ? { promoCodes: now.sale.promoCodes } : {}),
            }),
        ...(email ? { buyerEmail: email } : {}),
      });
      if (isStale(gen)) return;
      setAttempt(NEW_ATTEMPT);
      refreshCatalogue();
      setCart([]);
      setPromoInput("");
      setBuyerEmail("");
      promoController.reset();
      dismissCardNotice();
      setStage({
        kind: "result",
        sale: {
          orderId: result.orderId,
          tender: result.isComp ? "comp" : "cash",
          amountCents: result.amountCents,
          ticketCount: result.ticketCount,
          discountCents: result.discountCents,
          promoCodes: result.promoCodes,
          changeCents: result.changeCents,
          autoAdmitted: result.autoAdmitted,
          seatLabels: result.seatLabels,
          buyerEmail: email ?? null,
        },
      });
    } catch (err) {
      if (isStale(gen)) return;
      const settled = attemptFailed(attemptRef.current, err, door.kind, newClientKey);
      setAttempt(settled.attempt);
      if (settled.handled) return;
      const newTotal = readCashShortTotal(err);
      const current = stageRef.current;
      if (door.kind === "cash" && newTotal !== null && current.kind === "cash") {
        // The cash total moved after the quote. Show the new figure and let
        // the operator take it with a second press: never retried silently,
        // because the buyer has to hear it first.
        setStage({ ...current, dueOverride: newTotal });
        quote.refetch();
        return;
      }
      setSaleError(saleErrorMessage(err));
      if (readTaxRefusal(err)) {
        // Back to the cart, where a fresh quote shows the refusal and its
        // way out. Nothing was charged.
        setStage({ kind: "browse" });
        quote.refetch();
      }
    } finally {
      if (!isStale(gen)) endPress();
    }
  };

  const removePromo = useCallback(
    (code: string) => {
      void promoController.remove(code, promoContext);
    },
    [promoController, promoContext],
  );

  const backToCart = () => {
    setSaleError(null);
    setStage({ kind: "browse" });
  };

  const checkCardAgain = () => {
    const now = stageRef.current;
    if (now.kind === "card-closing") void runCardClose(now.orderId);
  };

  // ── What may be pressed ────────────────────────────────────────────────
  const gate = {
    quoteReady: readyQuote !== null,
    hasCardTotal: readyQuote?.card != null,
    attempt,
    emailInvalid,
    busy,
  };
  const sheetQuoteReady = stage.kind === "cash" && stage.sale.quote !== null;
  const onCart = stage.kind === "browse";

  return {
    stage,
    attempt,
    busy,
    unresolved,
    saleError,
    buyerEmail,
    setBuyerEmail,
    quote,
    cart: { cartByTicketType, cartCount, ticketNames, adjust },
    promo: {
      state: promo,
      input: promoInput,
      setInput: setPromoInput,
      apply: onApplyPromo,
      remove: removePromo,
    },
    // Each button is open only on the screen that shows it: the reader and
    // the card-closing screens have no tender at all.
    open: {
      card: onCart && tenderOpen("card", gate),
      cash: onCart && tenderOpen("cash", gate),
      compInstead:
        onCart && quote.state.kind === "tax-refused" && tenderOpen("comp", gate),
      sheetCash:
        stage.kind === "cash" &&
        tenderOpen("cash", { ...gate, quoteReady: sheetQuoteReady }),
      sheetComp: stage.kind === "cash" && tenderOpen("comp", gate),
    },
    /** "Card sale cleared": shown on the cart and the cash sheet. */
    cardCleared: {
      kind: cardCleared.kind,
      amount: cardCleared.amount,
      dismiss: dismissCardNotice,
    },
    /** A ready quote a card can't take: a code covers the whole cart. */
    freeWithCode:
      readyQuote !== null && readyQuote.card === null && cartCount > 0,
    actions: {
      tapToPay: () => void onTapToPay(),
      cancelCard: onCardCancel,
      checkCardAgain,
      finishCardSale,
      startCash: onCashStart,
      compInstead: onCompInstead,
      confirmCash: (receivedCents: number) =>
        void onDoorSale({ kind: "cash", receivedCents }),
      comp: () => void onDoorSale({ kind: "comp" }),
      backToCart,
      resetSale,
    },
  };
}
