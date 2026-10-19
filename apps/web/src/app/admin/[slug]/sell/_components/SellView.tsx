"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { keepPreviousData, skipToken } from "@tanstack/react-query";
import { YStack } from "tamagui";
import {
  Button,
  Modal,
  Spinner,
  StyledSelect,
  Text,
  useNotify,
  useTranslations,
  type StyledSelectOption,
} from "@th/ui";
import { SCANNER_TERMS_VERSION } from "@th/types";

import { trpc } from "@/trpc";
import { formatCents } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

import { CashTillPanel } from "./CashTillPanel";
import { LastSaleBar } from "./LastSaleBar";
import { ManualTaxRateDialog } from "./ManualTaxRateDialog";
import { ScannerTermsGate } from "./ScannerTermsGate";
import { SellCatalogue } from "./SellCatalogue";
import {
  ReaderOpenSaleView,
  ReaderWaitingView,
  SaleDoneView,
  SupportNotice,
} from "./SaleStates";
import { TenderChoice, type ReaderOption } from "./TenderChoice";
import {
  cartTicketCount,
  newSaleClientKey,
  setAdjustableAmount,
  stepQuantity,
  toSaleItems,
  type Cart,
  type SellableItem,
} from "./sell-cart";
import {
  buyerEmailForSale,
  deriveQuoteState,
  ratePercentText,
  readCashShortTotal,
  readTaxRefusal,
  shouldRetryQuote,
  type CartQuote,
  type QuoteState,
} from "./sell-quote";
import {
  classifyReaderFailure,
  isTerminalSaleStatus,
  keyMayHoldASale,
  PROCESSING_PRESSES_BEFORE_CHECK,
  refundProcedureFor,
  saleStillProcessing,
  serverAnsweredRequest,
  shouldRotateSaleKey,
  type LastSale,
  type SellStage,
} from "./sell-stage";

/** Opt a mutation out of the global error toast (GlobalMutationErrorNotifier). */
const SILENT = { meta: { silent: true } } as const;

type SaleItems = ReturnType<typeof toSaleItems>;
type Tender = "card" | "cash" | "comp";

/**
 * The sale as it stood when the operator left the cart: the exact lines the
 * quote priced, and that quote. Every sale call sends THESE lines, never the
 * live cart, because the catalogue keeps refetching behind the tender screen
 * and a tier that sells out in the meantime drops out of the live cart
 * silently. `quote` is null only for a comp taken while the tax lookup is
 * down (a comp needs no tax, so it needs no quote).
 */
type SaleSnapshot = { items: SaleItems; quote: CartQuote | null };

/**
 * The web box office.
 *
 * Everything about money is server-decided: this component builds a cart,
 * asks `pos.quoteCart` what it costs (card AND cash, the same price, fees and
 * tax online checkout charges), and hands the cart to `pos.startSale` /
 * `pos.recordCashSale`, both of which re-price every line themselves. It never
 * computes a total of its own and never talks to a card reader — the reader is
 * driven server-side through Stripe, which is what lets the box office run
 * from any browser on any device.
 */
export function SellView() {
  const params = useParams();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const { toast } = useNotify();
  const t = useTranslations();
  const utils = trpc.useUtils();

  // ── Which group's workspace is this? ──────────────────────────────────────
  const ownerEntitiesQuery = trpc.events.listEventOwnerEntities.useQuery(
    {},
    { staleTime: 60_000 },
  );

  const currentOwner = useMemo(() => {
    if (!ownerEntitiesQuery.data?.owners) return null;
    const normalizedSlug = slug.toLowerCase().replace(/^@/, "");
    return ownerEntitiesQuery.data.owners.find((owner) => {
      if (owner.kind === "human") {
        const candidates = [
          owner.humanUsername?.toLowerCase() ?? null,
          owner.humanProfileSlug?.toLowerCase() ?? null,
          owner.humanId.toLowerCase(),
        ];
        return candidates.some((c) => c === normalizedSlug);
      }
      const orgSlug = owner.orgSlug ?? owner.orgId;
      return orgSlug.toLowerCase().replace(/^@/, "") === normalizedSlug;
    });
  }, [ownerEntitiesQuery.data, slug]);

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : null;

  /**
   * Refund authority, which is NOT selling authority. Both gate-refund use
   * cases require ORG_EDIT_ROLES and deliberately exclude SCANNER, so a
   * scanner-only operator must not be shown a Refund button that would refuse
   * them — same reasoning the scan page uses for volunteer check-in.
   */
  const canRefundSales =
    currentOwner?.kind === "org" &&
    (["OWNER", "ADMIN", "EDITOR"] as readonly string[]).includes(
      currentOwner.role,
    );

  // ── Seller terms (BLOCKER: nothing in apps/web called this before) ────────
  // The ack lives on the human record, so this is the same read the scanner
  // app uses and an ack from either surface clears both.
  const sessionQuery = trpc.scanner.getSessionContext.useQuery(
    {},
    { staleTime: 60_000 },
  );
  /**
   * FAIL CLOSED. `needsTermsAck` used to be `!!data && version !== current`,
   * which is false when the query ERRORS — data stays undefined, isLoading
   * goes false, and the operator sails past the gate onto a till whose every
   * button then hard-fails with SCANNER_TERMS_REQUIRED and no way to clear it
   * from a browser. That is the exact failure this gate exists to prevent, so
   * "we don't know" has to mean "blocked", not "allowed".
   *
   * Both halves are checked because the server checks both: a record carrying
   * a version but no timestamp passes a version-only test and is then refused
   * by `startPosSale` / `recordCashSale` on every single sale.
   */
  const operatorAck = sessionQuery.data?.operator;
  const hasCurrentTermsAck =
    !!operatorAck?.scannerTermsAckAt &&
    operatorAck.scannerTermsAckVersion === SCANNER_TERMS_VERSION;
  const needsTermsAck = !sessionQuery.isLoading && !hasCurrentTermsAck;

  // ── Event picker ──────────────────────────────────────────────────────────
  const eventsQuery = trpc.events.listMine.useQuery(
    {
      ownerType: "ORGANIZATION" as const,
      ownerId: orgId ?? "",
      status: ["PUBLISHED"],
      limit: 50,
    },
    { staleTime: 60_000, enabled: !!orgId },
  );

  const events = useMemo(
    () => eventsQuery.data?.items ?? [],
    [eventsQuery.data],
  );
  const [eventId, setEventId] = useState<string | null>(null);

  // Land on the soonest event that is plausibly happening, the same way the
  // scan page does — a door operator should not have to pick.
  useEffect(() => {
    if (eventId || events.length === 0) return;
    const now = Date.now();
    const upcoming = events
      .filter(
        (e): e is typeof e & { startsAt: Date } =>
          e.startsAt != null &&
          e.startsAt.getTime() >= now - 6 * 60 * 60 * 1000,
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const next = upcoming[0] ?? events[0];
    if (next) setEventId(next.id);
  }, [events, eventId]);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === eventId) ?? null,
    [events, eventId],
  );

  const eventOptions = useMemo<StyledSelectOption[]>(
    () =>
      events.map((evt) => {
        const title = evt.title ?? "Untitled event";
        return {
          value: evt.id,
          label: evt.startsAt
            ? `${title} — ${new Date(evt.startsAt).toLocaleString()}`
            : title,
        };
      }),
    [events],
  );

  // ── Catalogue ─────────────────────────────────────────────────────────────
  const itemsQuery = trpc.pos.listSellableItems.useQuery(
    { eventId: eventId ?? "" },
    { enabled: !!eventId && !needsTermsAck, staleTime: 15_000 },
  );

  // No `as` here, deliberately. Casting this is how a `sellability.onSale`
  // that should have been `sellability.available` reached a browser: the cast
  // asserted a shape the server never sent, every tier came back `undefined`
  // and therefore unsellable, and the type checker had been told not to look.
  const items = useMemo<SellableItem[]>(
    () => itemsQuery.data?.ticketTypes ?? [],
    [itemsQuery.data],
  );

  // ── Readers ───────────────────────────────────────────────────────────────
  const readersQuery = trpc.pos.listReaders.useQuery(
    { orgId: orgId ?? "", includeStatus: true },
    { enabled: !!orgId && !needsTermsAck, staleTime: 20_000 },
  );

  const readers = useMemo<ReaderOption[]>(
    () =>
      (readersQuery.data?.readers ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        busy: r.busy,
      })),
    [readersQuery.data],
  );

  const [selectedReaderId, setSelectedReaderId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedReaderId || readers.length === 0) return;
    const firstUsable = readers.find((r) => r.status !== "offline" && !r.busy);
    setSelectedReaderId((firstUsable ?? readers[0])!.id);
  }, [readers, selectedReaderId]);

  // ── Sale state ────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<Cart>({});
  const [stage, setStage] = useState<SellStage>({ kind: "ring-up" });
  /**
   * Mirror of `stage` for reads AFTER an await. A callback's `stage` is the
   * value from the render that created it, so a guard placed after an await
   * would re-check a stale snapshot and happily clobber a newer state.
   */
  const stageRef = useRef<SellStage>(stage);
  stageRef.current = stage;
  const [busy, setBusy] = useState(false);
  /**
   * Comp asks once before it mints.
   *
   * Comp sits next to Cash as an equally-sized tile, and a mis-tap is not a
   * typo you fix: it mints tickets at $0, marks them SUCCEEDED and auto-admits
   * them inside the same transaction. Undoing it means Last sale's
   * `refundCashSale` (15 minutes) or the Void on Cash taken tonight's list
   * (`orgRefundCashSale`, until event end + 7 days). Neither takes a SCANNER
   * (the first is ORG_EDIT_ROLES, the second Owner, Admin, Editor or Finance),
   * so a SCANNER-role door operator cannot undo their own mis-tap at all. One
   * tap is right for card and cash; the one a scanner can't take back gets a
   * question.
   */
  const [confirmingComp, setConfirmingComp] = useState(false);
  /**
   * The sale just taken, so a mis-ring has a route back. Survives `resetSale`
   * on purpose — the design puts this on the RING-UP screen, which means it
   * has to outlive the done screen it came from.
   */
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  /**
   * The buyer's email, typed on the tender screen. Optional; sent as typed
   * (trimmed), blank omitted. It rides on whichever tender is pressed,
   * comp included, and the server emails the ticket and receipt.
   */
  const [buyerEmail, setBuyerEmail] = useState("");
  /** The address the in-flight card sale was started with. */
  const cardSaleEmailRef = useRef<string | null>(null);
  /**
   * The quote the operator read out when they pressed Charge, and the lines
   * it priced. The tender tiles show it, a cash sale records its cash total
   * and every sale call sends its lines, so the sale charged is the sale
   * said, even if a background refetch moves the live cart or quote while
   * the buyer is digging for a wallet.
   */
  const [sale, setSale] = useState<SaleSnapshot | null>(null);
  const saleQuote = sale?.quote ?? null;
  /**
   * The tender whose last attempt is unresolved: it got NO answer (a dropped
   * connection), or the server said an attempt under this key is still being
   * processed. The sale may have gone through, so its key is kept, and the
   * email, the cart and the other tenders lock: pressing the same tender
   * replays the stored sale, while anything changed would be a second sale
   * under the same key.
   */
  const [lock, setLock] = useState<{
    tender: Tender;
    reason: "no-answer" | "processing";
  } | null>(null);
  const lockedTender = lock?.tender ?? null;
  /** LOCK_IN_PROGRESS answers in a row; see PROCESSING_PRESSES_BEFORE_CHECK. */
  const processingPressesRef = useRef(0);
  /**
   * The server said this key may already hold a sale
   * (IDEMPOTENCY_KEY_CONFLICT, or LOCK_IN_PROGRESS that didn't clear). The key
   * is NOT rotated, because the next press would then sell again; the
   * operator checks Cash taken tonight and clears the sale to start over.
   */
  const [mayAlreadyBeRecorded, setMayAlreadyBeRecorded] = useState(false);
  /**
   * True while the current key may hold a sale nobody has seen yet. Clearing
   * the sale or switching events would throw that key away, so both ask
   * first (`confirmDiscard`).
   */
  const saleUnresolved = lock !== null || mayAlreadyBeRecorded;
  /** A Clear sale or event switch waiting on "Clear it anyway". */
  const [confirmDiscard, setConfirmDiscard] = useState<
    { kind: "clear" } | { kind: "switch-event"; eventId: string } | null
  >(null);
  /**
   * The server's cash total after it refused a cash sale as short (the
   * event's tax rate moved since the quote). Shown on the Cash tile with a
   * notice; the operator presses Cash again to take it. Never auto-retried.
   */
  const [cashTotalOverride, setCashTotalOverride] = useState<number | null>(
    null,
  );
  /** The "Enter tax rate" dialog (Owner, Admin, Editor only). */
  const [enteringTaxRate, setEnteringTaxRate] = useState(false);

  /**
   * The idempotency key for the sale currently being committed to.
   *
   * Both sell procedures key on `pos:{actorHumanId}:{clientKey}` with a
   * payload-hash collision check, so this must be STABLE across retries of the
   * same sale (a double-tapped button, a response that never arrived) and
   * different for the next one. Held in a ref rather than state because a
   * re-render must never mint a new key mid-sale.
   */
  const clientKeyRef = useRef<string | null>(null);
  const ensureClientKey = () => {
    clientKeyRef.current ??= newSaleClientKey();
    return clientKeyRef.current;
  };

  /**
   * Throw the current key away after a failure the SERVER decided.
   *
   * This is the half of idempotency that is easy to get backwards. Reusing a
   * key is right for a LOST RESPONSE — a dropped connection, a closed laptop —
   * where the sale may well have committed and a replay must return the same
   * one instead of charging twice. It is wrong for a refusal, because
   * `idempotency.fail()` writes `failed:…` under that key with a FIFTEEN
   * MINUTE TTL, and `begin()` is a `SET NX`. So the second attempt with the
   * same key never reaches the use case at all: it returns
   * IDEMPOTENCY_LOCK_IN_PROGRESS ("your order is already being processed"),
   * and keeps doing so for a quarter of an hour.
   *
   * Concretely: a cash sale refused by a momentary TICKET_TYPE_TEMPORARILY_HELD
   * — a race that clears in seconds — would lock that cart out of the till for
   * fifteen minutes, at a door, with the customer still standing there, and
   * the only escape would be to clear the cart and rebuild it.
   *
   * Any RESPONSE from the server — an app code or a bare HTTP status — proves
   * it reached a decision and already poisoned the key, so the key has done
   * its job and must not be reused. Only a request that got no response at all
   * keeps its key, because only there does a replay have a stored result to
   * return. See `serverAnsweredRequest`.
   */
  /**
   * Sort out the key, and the tender lock, after a sale attempt failed.
   * Returns true when the failure is fully handled by the tender screen's
   * own notice (no toast): an attempt that got no answer, or a key that may
   * already hold a sale. Either way "Could not record that sale" would be a
   * claim nobody can make.
   */
  const settleFailedAttempt = (err: unknown, tender: Tender): boolean => {
    if (shouldRotateSaleKey(err)) {
      clientKeyRef.current = newSaleClientKey();
      setLock(null);
      processingPressesRef.current = 0;
      return false;
    }
    if (keyMayHoldASale(err)) {
      setMayAlreadyBeRecorded(true);
      return true;
    }
    if (saleStillProcessing(err)) {
      processingPressesRef.current += 1;
      // Usually the first press still running: wait and press again. Past a
      // few in a row it isn't clearing (a lost refusal holds the key for
      // fifteen minutes), so send the operator to check instead.
      if (processingPressesRef.current >= PROCESSING_PRESSES_BEFORE_CHECK) {
        setMayAlreadyBeRecorded(true);
      }
      setLock({ tender, reason: "processing" });
      return true;
    }
    if (!serverAnsweredRequest(err)) {
      setLock({ tender, reason: "no-answer" });
      return true;
    }
    return false;
  };

  const ticketCount = sale
    ? sale.items.reduce((sum, line) => sum + line.qty, 0)
    : cartTicketCount(cart, items);
  const currency = itemsQuery.data?.currency ?? "usd";
  const eventTitle = selectedEvent?.title ?? "this event";
  const eventLabel = selectedEvent?.startsAt
    ? `${eventTitle} · ${new Date(selectedEvent.startsAt).toLocaleDateString(
        undefined,
        { weekday: "short", day: "numeric", month: "short" },
      )}`
    : eventTitle;

  // ── The quote ─────────────────────────────────────────────────────────────
  // Every cart change asks the server for both totals (debounced, so a run
  // of +/- taps costs one request). Until the answer for THIS cart is in, the
  // total reads "—" and Charge stays off.
  const quoteInput = useMemo(() => {
    const [first, ...rest] = toSaleItems(cart, items);
    if (!eventId || !first) return null;
    return { eventId, items: [first, ...rest] as [typeof first, ...typeof rest] };
  }, [cart, items, eventId]);
  const askedQuoteInput = useDebouncedValue(quoteInput, 250);
  const quoteKeyNow = quoteInput ? JSON.stringify(quoteInput) : null;
  const quoteKeyAsked = askedQuoteInput ? JSON.stringify(askedQuoteInput) : null;

  const quoteQuery = trpc.pos.quoteCart.useQuery(
    askedQuoteInput && !needsTermsAck ? askedQuoteInput : skipToken,
    {
      // Keep the previous answer on screen (as "—" rows) while the next one
      // loads, so the summary doesn't collapse and re-grow on every tap.
      placeholderData: keepPreviousData,
      // Only a request that got no answer is retried; see shouldRetryQuote.
      retry: shouldRetryQuote,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  );

  // A quote is `ready` only once it has settled for this exact cart: a
  // refetch in flight (back from a tax refusal, after CASH_AMOUNT_SHORT, a
  // stale cached answer) is `updating`, so Charge can't freeze the old number.
  const quoteState: QuoteState = deriveQuoteState({
    hasCart: quoteInput !== null,
    asked: quoteKeyNow === quoteKeyAsked,
    data: quoteQuery.data,
    isPlaceholderData: quoteQuery.isPlaceholderData,
    isFetching: quoteQuery.isFetching,
    isError: quoteQuery.isError,
    error: quoteQuery.error,
  });

  const cashTotalCents =
    cashTotalOverride ?? saleQuote?.cash.totalCents ?? null;

  const refreshAfterSale = useCallback(() => {
    if (!eventId) return;
    void utils.pos.listSellableItems.invalidate({ eventId });
    void utils.pos.cashTillReport.invalidate({ eventId });
    void utils.pos.eventCashSales.invalidate({ eventId });
  }, [eventId, utils]);

  const resetSale = useCallback(() => {
    setCart({});
    setStage({ kind: "ring-up" });
    setBuyerEmail("");
    setSale(null);
    setCashTotalOverride(null);
    setLock(null);
    processingPressesRef.current = 0;
    setMayAlreadyBeRecorded(false);
    setConfirmDiscard(null);
    cardSaleEmailRef.current = null;
    clientKeyRef.current = null;
  }, []);

  /**
   * A sale refused because the tax lookup went down after the quote: back to
   * the cart, where a fresh quote shows the refusal and its way out (enter
   * the rate, or ask someone who can). Nothing was charged.
   */
  const backToCartForTax = useCallback(() => {
    setStage({ kind: "ring-up" });
    setSale(null);
    setCashTotalOverride(null);
    void quoteQuery.refetch();
  }, [quoteQuery]);

  // Switching events mid-cart would price the new event's sale from the old
  // event's tiers. Start clean.
  //
  // `lastSale` is cleared HERE and not in `resetSale`, because the two have
  // opposite requirements: it must survive "Next sale" (that is the whole
  // point of putting it on the ring-up screen) and must not survive an event
  // switch, where it would offer to refund another event's sale from this
  // event's till.
  useEffect(() => {
    resetSale();
    setLastSale(null);
  }, [eventId, resetSale]);

  // Every sale mutation is SILENT to the global error toast: this screen
  // handles each failure itself, and some aren't failures at all here (a
  // cancel finding the order already gone, a sale whose key may already hold
  // one, a cash total that moved). Without this the operator got the global
  // "Action failed" toast on top of, or instead of, the till's own answer.
  const startSale = trpc.pos.startSale.useMutation(SILENT);
  const processOnReader = trpc.pos.processOnReader.useMutation(SILENT);
  const cancelReaderAction = trpc.pos.cancelReaderAction.useMutation(SILENT);
  const cancelSale = trpc.pos.cancelSale.useMutation(SILENT);
  const recordCashSale = trpc.pos.recordCashSale.useMutation(SILENT);
  const refundRecentSale = trpc.pos.refundRecentSale.useMutation(SILENT);
  const refundCashSaleMutation = trpc.pos.refundCashSale.useMutation(SILENT);

  /**
   * Poll for the webhook to finalise a dispatched card sale.
   *
   * The browser never sees the tap — `payment_intent.succeeded` does, and it
   * drives the mint. So the only honest thing this screen can do is ask the
   * server what happened, which is exactly what `completeSale` is for.
   */
  /**
   * Poll in `card-open` as well as `card-waiting`.
   *
   * `cancelReaderAction` deliberately leaves the PaymentIntent confirmable, so
   * a card that was already dipped can still succeed AFTER the prompt is
   * cleared. If nothing watched that, the operator would be reading "nothing
   * was charged" off a screen while the customer's tickets were being minted
   * and auto-admitted behind it.
   */
  const watchedOrderId =
    stage.kind === "card-waiting" || stage.kind === "card-open"
      ? stage.orderId
      : undefined;

  const completeQuery = trpc.pos.completeSale.useQuery(
    { orderId: watchedOrderId ?? "" },
    {
      enabled: !!watchedOrderId,
      // Fast while the buyer is being prompted; slow once the prompt is
      // cleared and this is only a late-confirmation safety net.
      refetchInterval: stage.kind === "card-waiting" ? 1500 : 5000,
      // A poll that keeps its previous answer through a blip is a poll that
      // can't flicker the till back to "waiting" after it said "paid".
      refetchOnWindowFocus: false,
    },
  );

  /**
   * A card sale the server says SUCCEEDED: the done screen, and the Last sale
   * row so it can be refunded. One path for the poll and for a cancel that
   * found the order already paid (`closeOpenOrder`).
   */
  const finishCardSale = useCallback(
    (data: {
      orderId: string;
      amountCents: number;
      ticketCount: number;
      isComp: boolean;
    }) => {
      setStage({
        kind: "done",
        amountCents: data.amountCents,
        ticketCount: data.ticketCount,
        isComp: data.isComp,
        // POS card sales auto-admit inside `finalizeFromPaymentIntent`
        // (the `POS_AUTO_ADMIT` branch), so this is a statement of fact
        // rather than an assumption.
        autoAdmitted: true,
        // `completeSale` returns tickets but not seat labels. A RESERVED-
        // section card sale therefore can't tell the operator where to send
        // the group, the way the cash path can — worth adding to that output.
        seatLabels: [],
        tender: "card",
        // A card sale can't be $0 (the quote has no card total for a free
        // cart), so it is never "free with a code".
        discountCents: 0,
        promoCodes: [],
        buyerEmail: cardSaleEmailRef.current,
        // The reader takes exactly the server's amount: no change on a card.
        changeCents: 0,
      });
      setLastSale({
        orderId: data.orderId,
        amountCents: data.amountCents,
        ticketCount: data.ticketCount,
        tender: "card",
        soldAt: Date.now(),
      });
      refreshAfterSale();
    },
    [refreshAfterSale],
  );

  useEffect(() => {
    if (stage.kind !== "card-waiting" && stage.kind !== "card-open") return;
    const data = completeQuery.data;
    if (!data || !isTerminalSaleStatus(data.status)) return;

    if (data.status === "SUCCEEDED") {
      finishCardSale(data);
      return;
    }

    // Anything else terminal (CANCELLED, REFUNDED, DISPUTED) means this sale
    // is not going to complete.
    //
    // In `card-open` that is usually US: the operator just cancelled, or is
    // about to fall back to cash. Announcing it would be telling them about
    // their own action, so the open-sale screen stays put and its own buttons
    // stay authoritative. Only the WAITING screen, where a terminal status is
    // genuinely unexpected, says something and resets.
    if (stage.kind !== "card-waiting") return;

    toast.danger({
      id: "sell-card-not-completed",
      title: "That sale didn't complete",
      message: `The order came back ${data.status.toLowerCase()}. Nothing was charged that we can see — check the reader before retrying.`,
    });
    resetSale();
  }, [completeQuery.data, stage, toast, resetSale, finishCardSale]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const dispatchToReader = useCallback(
    async (
      orderId: string,
      posReaderId: string,
      amountCents: number,
      quotedCents: number | null,
    ) => {
      const reader = readers.find((r) => r.id === posReaderId);
      const readerLabel = reader?.label ?? "the reader";
      setBusy(true);
      try {
        await processOnReader.mutateAsync({ orderId, posReaderId });
        setStage({
          kind: "card-waiting",
          orderId,
          posReaderId,
          readerLabel,
          amountCents,
          quotedCents,
        });
      } catch (err) {
        const recoverable = classifyReaderFailure(
          err,
          readerLabel,
          formatCents(amountCents, currency),
        );
        if (recoverable) {
          setStage({
            kind: "card-open",
            orderId,
            posReaderId,
            readerLabel,
            amountCents,
            quotedCents,
            ...recoverable,
          });
        } else {
          // Not a failure we can honestly offer a retry for. Surface it as an
          // error (and let it reach Sentry) rather than flattening it into a
          // friendly-but-wrong "the reader isn't responding".
          toast.danger({
            id: "sell-dispatch-failed",
            title: "Could not send that to the reader",
            message: formatErrorMessage(err, t),
          });
          setStage({
            kind: "card-open",
            orderId,
            posReaderId,
            readerLabel,
            amountCents,
            quotedCents,
            headline: "That didn't reach the reader",
            detail: `Nothing was charged — the ${formatCents(amountCents, currency)} sale is still open.`,
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [processOnReader, readers, toast, currency, t],
  );

  const handleCard = useCallback(async () => {
    if (!eventId || !selectedReaderId || !sale) return;
    setBusy(true);
    const email = buyerEmailForSale(buyerEmail);
    try {
      const started = await startSale.mutateAsync({
        eventId,
        clientKey: ensureClientKey(),
        items: sale.items,
        ...(email ? { buyerEmail: email } : {}),
      });
      setLock(null);
      processingPressesRef.current = 0;
      cardSaleEmailRef.current = email ?? null;
      // The reader asks for the SERVER's amount. The quoted card total rides
      // along so the waiting screen can say so if the two differ.
      await dispatchToReader(
        started.orderId,
        selectedReaderId,
        started.amountCents,
        sale.quote?.card?.totalCents ?? null,
      );
    } catch (err) {
      if (settleFailedAttempt(err, "card")) return;
      toast.danger({
        id: "sell-start-failed",
        title: "Could not start that sale",
        message: formatErrorMessage(err, t),
      });
      if (readTaxRefusal(err)) backToCartForTax();
    } finally {
      setBusy(false);
    }
  }, [
    backToCartForTax,
    buyerEmail,
    dispatchToReader,
    eventId,
    sale,
    selectedReaderId,
    startSale,
    toast,
    t,
  ]);

  /**
   * Cash AND comp: both are `recordCashSale`, told apart EXPLICITLY. A comp
   * sends `comp: true`; a paid cash sale sends `comp: false` and collects the
   * quote's cash total (the web till has no typed-amount field). Never
   * `amountCollectedCents: 0` as an implied comp: a $0 cart that is $0
   * because of a code is a sale, not a comp.
   *
   * If the sale comes out LOWER than the quote (a hand-entered tax rate gave
   * way to a lower looked-up one) the server records the lower total and
   * returns the difference as `changeCents`; the done screen tells the
   * operator to hand it back.
   *
   * If the cash total moved after the quote (a tax rate updated in between)
   * the server refuses with CASH_AMOUNT_SHORT and the new total. The tile
   * then shows that total with a notice, and the operator takes it with a
   * second press. Not retried automatically: the buyer has to hear it first.
   */
  const handleDoorSale = useCallback(
    async (
      door:
        | { kind: "cash"; amountCollectedCents: number }
        | { kind: "comp" },
    ) => {
      if (!eventId || !sale) return;
      setBusy(true);
      const email = buyerEmailForSale(buyerEmail);
      try {
        const result = await recordCashSale.mutateAsync({
          eventId,
          clientKey: ensureClientKey(),
          items: sale.items,
          ...(door.kind === "comp"
            ? { comp: true, amountCollectedCents: 0 }
            : { comp: false, amountCollectedCents: door.amountCollectedCents }),
          ...(email ? { buyerEmail: email } : {}),
        });
        setLock(null);
        processingPressesRef.current = 0;
        const tender = result.isComp ? "comp" : "cash";
        setStage({
          kind: "done",
          amountCents: result.amountCents,
          ticketCount: result.ticketCount,
          isComp: result.isComp,
          autoAdmitted: result.autoAdmitted,
          seatLabels: result.seatLabels,
          tender,
          discountCents: result.discountCents,
          promoCodes: result.promoCodes,
          buyerEmail: email ?? null,
          changeCents: result.changeCents,
        });
        setLastSale({
          orderId: result.orderId,
          amountCents: result.amountCents,
          ticketCount: result.ticketCount,
          tender,
          soldAt: Date.now(),
        });
        refreshAfterSale();
      } catch (err) {
        if (settleFailedAttempt(err, door.kind)) return;
        const newCashTotal = readCashShortTotal(err);
        if (door.kind === "cash" && newCashTotal !== null) {
          setCashTotalOverride(newCashTotal);
          void quoteQuery.refetch();
          return;
        }
        toast.danger({
          id: "sell-cash-failed",
          title: "Could not record that sale",
          message: formatErrorMessage(err, t),
        });
        if (readTaxRefusal(err)) backToCartForTax();
      } finally {
        setBusy(false);
      }
    },
    [
      backToCartForTax,
      buyerEmail,
      eventId,
      quoteQuery,
      recordCashSale,
      refreshAfterSale,
      sale,
      toast,
      t,
    ],
  );

  const handleCash = useCallback(() => {
    if (cashTotalCents === null) return;
    void handleDoorSale({ kind: "cash", amountCollectedCents: cashTotalCents });
  }, [cashTotalCents, handleDoorSale]);

  /**
   * Falling back to cash from an OPEN card sale.
   *
   * The open order is holding stock and a confirmable PaymentIntent, so it has
   * to be cancelled before a second order is created for the same tickets —
   * otherwise the door quietly double-holds capacity until the reaper catches
   * up. `cancelSale` (not `cancelReaderAction`) is the right call here: it
   * voids the order AND the PaymentIntent.
   */
  /**
   * Cancel an open POS order, and find out what it really was if it wasn't
   * open any more.
   *
   * `cancelPosSale` throws ORDER_NOT_PENDING for ANY order that isn't
   * PENDING, a PAID one included. That matters: the buyer can dip the card
   * just before the operator cancels, and the webhook can finalise the sale
   * inside the poll's gap. Treating ORDER_NOT_PENDING as "closed" then took
   * the same sale again in cash, or wiped a charged sale off the screen with
   * no Refund offered. So on ORDER_NOT_PENDING, and on ORDER_NOT_PROCESSABLE
   * (the payment went through but the webhook hasn't finalised the order),
   * the till asks the server (`completeSale`, uncached) what happened:
   *
   * - `closed`: CANCELLED, or the order is gone. Nothing holds stock.
   * - `paid`: SUCCEEDED. The card sale is shown (unless the poll already
   *   did, or the till has moved on) and the caller takes nothing.
   * - `unknown`: anything else, or the check failed. Already toasted; the
   *   caller stays where it is, and the poll settles a paid-not-finalised
   *   sale. Never reset past: that wipes a charged card off the screen.
   * - `failed`: the cancel itself failed for another reason. Already toasted.
   */
  const closeOpenOrder = useCallback(
    async (
      orderId: string,
      posReaderId: string,
    ): Promise<"closed" | "paid" | "unknown" | "failed"> => {
      // Set when the void was refused because the card payment already
      // went through and the webhook hasn't finalised the order yet.
      let paidNotFinalised = false;
      try {
        await cancelSale.mutateAsync({ orderId, posReaderId });
        return "closed";
      } catch (err) {
        const code = getAppErrorCode(err);
        if (code === "ORDER_NOT_FOUND") return "closed";
        // ORDER_NOT_PROCESSABLE: `voidPendingPosOrder` found the payment
        // terminal and NOT cancelled (usually succeeded, webhook pending).
        // That is a paid sale, never a "failed" cancel to reset past.
        paidNotFinalised = code === "ORDER_NOT_PROCESSABLE";
        if (code !== "ORDER_NOT_PENDING" && !paidNotFinalised) {
          toast.danger({
            id: "sell-cancel-failed",
            title: "Could not close the card sale",
            message: formatErrorMessage(err, t),
          });
          return "failed";
        }
      }
      try {
        // The vanilla client, not `utils.pos.completeSale.fetch`: that
        // returns the poll's cached (or in-flight) answer, which is the
        // PENDING read from BEFORE the cancel. Found by driving it: the till
        // said "pending" for an order the server had already paid.
        const order = await utils.client.pos.completeSale.query({ orderId });
        if (order.status === "CANCELLED") return "closed";
        if (order.status === "SUCCEEDED") {
          // The poll may have finished this sale already, and the operator
          // may have pressed Next sale since: re-showing it then would put
          // the previous buyer's done screen over the next one's cart.
          const now = stageRef.current;
          const stillThisSale =
            (now.kind === "card-open" || now.kind === "card-waiting") &&
            now.orderId === orderId;
          if (stillThisSale) {
            finishCardSale(order);
            toast.warning({
              id: "sell-card-went-through",
              title: "The card went through",
              message: `The reader took ${formatCents(order.amountCents, currency)} before the cancel reached it. Nothing more to take.`,
            });
          }
          return "paid";
        }
        if (paidNotFinalised) {
          // Paid at Stripe, not yet finalised here. Stay on this screen: the
          // poll moves it to done once the webhook lands.
          toast.warning({
            id: "sell-card-unclear",
            title: "The card went through",
            message:
              "The payment is still being confirmed. Stay on this screen: it moves on by itself. Don't take cash.",
          });
          return "unknown";
        }
        toast.danger({
          id: "sell-card-unclear",
          title: "Check the reader before going on",
          message: `That card sale is ${order.status.toLowerCase()}, so it can't be closed from here. Nothing else was taken.`,
        });
        return "unknown";
      } catch (err) {
        toast.danger({
          id: "sell-card-unclear",
          title: "Couldn't check that card sale",
          message: formatErrorMessage(err, t),
        });
        return "unknown";
      }
    },
    [cancelSale, currency, finishCardSale, toast, t, utils],
  );

  /**
   * The cash amount is the quote's CASH total — the number the Cash tile
   * charges — never the open card sale's `amountCents`. A card sale charges
   * what online checkout charges (platform and processing fees on top), and
   * cash carries neither fee (owner ruling 2026-10-08), so recording the card
   * figure as cash would charge the buyer the card's fees in cash.
   */
  const handleCashFallback = useCallback(
    async (orderId: string, posReaderId: string) => {
      setBusy(true);
      const outcome = await closeOpenOrder(orderId, posReaderId);
      setBusy(false);
      // `paid`: the card took it, and the done screen is already up. Taking
      // cash now would charge the buyer twice.
      if (outcome !== "closed") return;

      // Leave `card-open` the moment the order is gone, BEFORE attempting the
      // cash sale. Otherwise a cash failure (a capacity race, say) drops the
      // operator back onto a screen still promising "the $45.00 sale is still
      // open" about an order that no longer exists — and every button on it
      // now targets a cancelled id.
      setStage({ kind: "tender" });

      // A fresh key: this is a DIFFERENT sale from the cancelled card one, so
      // reusing the key would collide on the payload hash.
      clientKeyRef.current = newSaleClientKey();
      if (cashTotalCents === null) return;
      await handleDoorSale({
        kind: "cash",
        amountCollectedCents: cashTotalCents,
      });
    },
    [closeOpenOrder, handleDoorSale, cashTotalCents],
  );

  /**
   * Reverse the sale just taken.
   *
   * Routes on the tender because the two use cases refuse each other's orders
   * (`NOT_A_CASH_ORDER` / `NOT_A_POS_CARD_ORDER`) — comp goes with cash, being
   * a cash sale with nothing collected. The 15-minute window and the
   * ORG_EDIT_ROLES gate are both enforced server-side; the UI only decides
   * when to stop offering.
   */
  const handleRefundLastSale = useCallback(async () => {
    if (!lastSale) return;
    setBusy(true);
    try {
      if (refundProcedureFor(lastSale.tender) === "card") {
        await refundRecentSale.mutateAsync({ orderId: lastSale.orderId });
      } else {
        await refundCashSaleMutation.mutateAsync({ orderId: lastSale.orderId });
      }
      // Clear it first: a refunded sale must not stay refundable, and a second
      // press would come back ORDER_ALREADY_REFUNDED.
      setLastSale(null);
      refreshAfterSale();
      toast.success({
        id: "sell-refunded",
        title:
          lastSale.tender === "comp" ? "Comp taken back" : "Sale refunded",
        message:
          lastSale.tender === "card"
            ? "The card was refunded and the tickets no longer admit."
            : "The tickets no longer admit, and the till total has been updated.",
      });
    } catch (err) {
      toast.danger({
        id: "sell-refund-failed",
        title: "Could not reverse that sale",
        message: formatErrorMessage(err, t),
      });
    } finally {
      setBusy(false);
    }
  }, [
    lastSale,
    refundRecentSale,
    refundCashSaleMutation,
    refreshAfterSale,
    toast,
    t,
  ]);

  const handleCancelCharge = useCallback(async () => {
    if (stage.kind !== "card-waiting" || !orgId) return;
    setBusy(true);
    try {
      // Clears the PROMPT only. The order stays PENDING so the cart can go to
      // another reader or become a cash sale — which is the entire reason
      // dispatch is separate from starting the sale.
      await cancelReaderAction.mutateAsync({
        orgId,
        posReaderId: stage.posReaderId,
      });
      // The guard at the top ran BEFORE this await. If the webhook landed
      // while the cancel was in flight, the poll has already moved us to
      // `done` — overwriting that with "nothing was charged" would be telling
      // the operator the opposite of what happened to a real customer.
      if (stageRef.current.kind !== "card-waiting") return;
      setStage({
        kind: "card-open",
        orderId: stage.orderId,
        posReaderId: stage.posReaderId,
        readerLabel: stage.readerLabel,
        amountCents: stage.amountCents,
        quotedCents: stage.quotedCents,
        headline: "Charge cancelled",
        detail: `The reader is clear and nothing was charged — the ${formatCents(stage.amountCents, currency)} sale is still open.`,
      });
    } catch (err) {
      toast.danger({
        id: "sell-cancel-action-failed",
        title: "Could not clear the reader",
        message: formatErrorMessage(err, t),
      });
    } finally {
      setBusy(false);
    }
  }, [cancelReaderAction, orgId, stage, toast, currency, t]);

  const handleAbandonOpenSale = useCallback(
    async (orderId: string, posReaderId: string) => {
      setBusy(true);
      const outcome = await closeOpenOrder(orderId, posReaderId);
      setBusy(false);
      refreshAfterSale();
      // Paid: the done screen is up, with the sale refundable from Last
      // sale. Unknown: stay, the operator has been told to check the reader.
      if (outcome === "paid" || outcome === "unknown") return;
      // Otherwise reset. If the cancel genuinely failed the order is still
      // PENDING and the reaper will release its stock — but stranding the
      // operator on a screen whose only exit just errored is worse than a
      // held seat, and they have already been told the cancel failed.
      resetSale();
      if (outcome === "failed") {
        toast.danger({
          id: "sell-abandon-partial",
          title: "Sale cleared here, but not at Stripe",
          message:
            "The cart is clear. That order may still be holding its tickets for a few minutes — check the event's orders if the count looks wrong.",
        });
      }
    },
    [closeOpenOrder, refreshAfterSale, resetSale, toast],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (!orgId) {
    return (
      <Text variant="body" tone="muted">
        The box office belongs to a group. Switch to a group workspace to sell
        at a door.
      </Text>
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <YStack alignItems="center" padding="$6">
        <Spinner size="large" />
      </YStack>
    );
  }

  // We could not establish whether this operator has accepted the seller
  // terms. Blocking with a retry, not letting them through: every sale would
  // fail server-side anyway, and a Charge button that always errors is a worse
  // answer than saying we could not check.
  if (sessionQuery.isError) {
    return (
      <YStack gap="$3" maxWidth={480}>
        <Text variant="body" tone="error">
          {formatErrorMessage(sessionQuery.error, t)}
        </Text>
        <Text variant="caption" tone="muted">
          We couldn&rsquo;t check your seller terms, so the till is closed until
          we can.
        </Text>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => void sessionQuery.refetch()}
        >
          Try again
        </Button>
      </YStack>
    );
  }

  if (needsTermsAck) {
    return (
      <ScannerTermsGate
        onAcknowledged={() => void sessionQuery.refetch()}
      />
    );
  }

  const otherReaders =
    stage.kind === "card-open"
      ? readers
          .filter((r) => r.id !== stage.posReaderId && r.status !== "offline")
          .map((r) => ({ id: r.id, label: r.label }))
      : [];

  return (
    <YStack gap="$4" maxWidth={720} width="100%">
      {/* Event picker — hidden once a sale is in flight, so nobody switches
          events out from under an open PaymentIntent. */}
      {stage.kind === "ring-up" ? (
        <YStack gap="$2">
          {eventsQuery.isLoading ? (
            <Spinner size="small" />
          ) : eventsQuery.isError ? (
            // NOT the empty state. A failed lookup rendering as "no published
            // events" tells an operator their event doesn't exist, which sends
            // them to go re-publish an event that was never unpublished.
            // "Couldn't load" and "there are none" are different sentences.
            <YStack gap="$2">
              <Text variant="body" tone="error">
                {formatErrorMessage(eventsQuery.error, t)}
              </Text>
              <Button
                variant="secondary"
                size="$3"
                onPress={() => void eventsQuery.refetch()}
              >
                Retry
              </Button>
            </YStack>
          ) : events.length === 0 ? (
            <Text variant="body" tone="muted">
              No published events for this group. Publish one to sell at a door.
            </Text>
          ) : (
            <StyledSelect
              value={eventId ?? ""}
              // `onChange`, NOT `onValueChange`. StyledSelect spreads unknown
              // props onto its frame, so a mistyped handler name is silently
              // dropped onto the DOM — React logs "Unknown event handler
              // property" and the picker simply does nothing. Likewise
              // `ariaLabel` is the component's own prop: a raw `aria-label`
              // lands on the wrapper div while the native <select> that
              // assistive tech actually focuses stays unnamed.
              onChange={(next: string) => {
                if (next === eventId) return;
                if (saleUnresolved) {
                  setConfirmDiscard({ kind: "switch-event", eventId: next });
                  return;
                }
                setEventId(next);
              }}
              options={eventOptions}
              ariaLabel="Event"
              fullWidth
            />
          )}
        </YStack>
      ) : null}

      {stage.kind === "ring-up" && saleUnresolved ? (
        <SupportNotice testId="sell-unresolved-ring-up">
          This sale may already be recorded. Check Cash taken tonight below,
          or the event&rsquo;s orders for a card sale. If it isn&rsquo;t
          there, clear the sale and ring it up again.
        </SupportNotice>
      ) : null}

      {stage.kind === "ring-up" && eventId ? (
        itemsQuery.isLoading ? (
          <YStack alignItems="center" padding="$6">
            <Spinner size="large" />
          </YStack>
        ) : itemsQuery.error ? (
          <YStack gap="$3">
            <Text variant="body" tone="error">
              {formatErrorMessage(itemsQuery.error, t)}
            </Text>
            <Button
              variant="secondary"
              size="$3"
              onPress={() => void itemsQuery.refetch()}
            >
              Retry
            </Button>
          </YStack>
        ) : items.length === 0 ? (
          <YStack
            gap="$2"
            padding="$4"
            borderWidth={1}
            borderColor="$borderColor"
            backgroundColor="$surfaceMuted"
          >
            <Text variant="body" weight="bold">
              Nothing to sell here
            </Text>
            <Text variant="caption" tone="muted">
              This event has no ticket types a door can sell. Add one in the
              event&rsquo;s tickets settings.
            </Text>
          </YStack>
        ) : (
          <SellCatalogue
            items={items}
            cart={cart}
            quote={quoteState}
            currency={currency}
            eventTitle={eventTitle}
            onStep={(item, delta) =>
              setCart((prev) => stepQuantity(prev, item, delta))
            }
            onSetAmount={(item, cents) =>
              setCart((prev) => setAdjustableAmount(prev, item, cents))
            }
            onClear={() => {
              if (saleUnresolved) {
                setConfirmDiscard({ kind: "clear" });
                return;
              }
              resetSale();
            }}
            onCharge={() => {
              if (quoteState.kind !== "ready" || !askedQuoteInput) return;
              // `ready` means the asked input IS the cart on screen.
              setSale({ items: askedQuoteInput.items, quote: quoteState.quote });
              setCashTotalOverride(null);
              setStage({ kind: "tender" });
            }}
            onRetryQuote={() => void quoteQuery.refetch()}
            onEnterTaxRate={() => setEnteringTaxRate(true)}
            onCompInstead={() => {
              if (!quoteInput) return;
              // Through the tender screen like any comp, so the buyer's
              // email can go on it; Card and Cash stay shut there.
              setSale({ items: quoteInput.items, quote: null });
              setCashTotalOverride(null);
              setStage({ kind: "tender" });
            }}
          />
        )
      ) : null}

      {stage.kind === "tender" && sale ? (
        <TenderChoice
          cardTotalCents={saleQuote?.card?.totalCents ?? null}
          cashTotalCents={cashTotalCents}
          currency={saleQuote?.currency ?? currency}
          ticketCount={ticketCount}
          eventTitle={eventTitle}
          readers={readers}
          selectedReaderId={selectedReaderId}
          onSelectReader={setSelectedReaderId}
          buyerEmail={buyerEmail}
          onBuyerEmailChange={setBuyerEmail}
          cashTotalChanged={cashTotalOverride !== null}
          lockedTender={lockedTender}
          lockReason={lock?.reason ?? null}
          mayAlreadyBeRecorded={mayAlreadyBeRecorded}
          onCheckTill={() => {
            // The cart and the key stay: the ring-up screen opens Cash taken
            // tonight, and Clear sale (after a confirm) starts over.
            refreshAfterSale();
            setSale(null);
            setCashTotalOverride(null);
            setStage({ kind: "ring-up" });
          }}
          onCard={() => void handleCard()}
          onCash={handleCash}
          onComp={() => setConfirmingComp(true)}
          onBack={() => {
            setSale(null);
            setCashTotalOverride(null);
            setStage({ kind: "ring-up" });
          }}
          busy={busy}
        />
      ) : null}

      {stage.kind === "card-waiting" ? (
        <ReaderWaitingView
          readerLabel={stage.readerLabel}
          amountCents={stage.amountCents}
          quotedCents={stage.quotedCents}
          currency={currency}
          onCancel={() => void handleCancelCharge()}
          cancelling={busy}
        />
      ) : null}

      {stage.kind === "card-open" ? (
        <ReaderOpenSaleView
          headline={stage.headline}
          detail={stage.detail}
          cashAmountCents={cashTotalCents ?? 0}
          currency={currency}
          readerLabel={stage.readerLabel}
          otherReaders={otherReaders}
          busy={busy}
          onRetry={() =>
            void dispatchToReader(
              stage.orderId,
              stage.posReaderId,
              stage.amountCents,
              stage.quotedCents,
            )
          }
          onSendTo={(readerId) =>
            void dispatchToReader(
              stage.orderId,
              readerId,
              stage.amountCents,
              stage.quotedCents,
            )
          }
          onTakeCash={() =>
            void handleCashFallback(stage.orderId, stage.posReaderId)
          }
          onAbandon={() =>
            void handleAbandonOpenSale(stage.orderId, stage.posReaderId)
          }
        />
      ) : null}

      {stage.kind === "done" ? (
        <SaleDoneView
          amountCents={stage.amountCents}
          currency={currency}
          ticketCount={stage.ticketCount}
          tender={stage.tender}
          discountCents={stage.discountCents}
          promoCodes={stage.promoCodes}
          buyerEmail={stage.buyerEmail}
          changeCents={stage.changeCents}
          autoAdmitted={stage.autoAdmitted}
          seatLabels={stage.seatLabels}
          onNextSale={() => {
            refreshAfterSale();
            resetSale();
          }}
        />
      ) : null}

      {/*
        On the ring-up screen, per the design — not the done screen. The
        operator usually realises the mistake while the next person is already
        being served, which is exactly when the done screen is gone.
      */}
      {/*
        Hidden while the current sale is unresolved: the bar shows the
        PREVIOUS buyer's sale, and an operator checking whether this one went
        through would read it as this one, or refund the wrong person.
      */}
      {lastSale && stage.kind === "ring-up" && !saleUnresolved ? (
        <LastSaleBar
          sale={lastSale}
          canRefund={canRefundSales}
          busy={busy}
          onRefund={() => void handleRefundLastSale()}
        />
      ) : null}

      {eventId && stage.kind === "ring-up" ? (
        <CashTillPanel
          eventId={eventId}
          orgId={orgId}
          checking={saleUnresolved}
          onCashSaleRefunded={(orderId) => {
            // Refunded from the list: the Last sale bar must not offer it
            // again (a second press would come back already refunded).
            setLastSale((prev) => (prev?.orderId === orderId ? null : prev));
            void utils.pos.listSellableItems.invalidate({ eventId });
          }}
        />
      ) : null}

      <Modal
        open={confirmingComp}
        onClose={() => (busy ? undefined : setConfirmingComp(false))}
      >
        <Modal.Panel width={460}>
          <Modal.Header
            title={`Comp ${ticketCount} ${ticketCount === 1 ? "ticket" : "tickets"}?`}
            subtitle={eventTitle}
            onClose={() => setConfirmingComp(false)}
          />
          <Modal.Body gap="$3">
            <Text variant="body">
              They go on the guest list at no charge, and they&rsquo;re admitted
              straight away — no ticket to scan.
            </Text>
            <Text variant="caption" tone="muted">
              Someone with edit access can undo it from Last sale for 15
              minutes, or void it from Cash taken tonight until seven days
              after the event ends.
            </Text>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="$3"
              disabled={busy}
              onPress={() => setConfirmingComp(false)}
            >
              Back
            </Button>
            <Button
              variant="primary"
              size="$3"
              disabled={busy}
              data-testid="sell-confirm-comp"
              onPress={() => {
                setConfirmingComp(false);
                void handleDoorSale({ kind: "comp" });
              }}
            >
              {busy ? <Spinner size="small" /> : null}
              Comp them
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      <Modal
        open={confirmDiscard !== null}
        onClose={() => setConfirmDiscard(null)}
      >
        <Modal.Panel width={460}>
          <Modal.Header
            title={
              confirmDiscard?.kind === "switch-event"
                ? "Switch events and clear this sale?"
                : "Clear this sale?"
            }
            onClose={() => setConfirmDiscard(null)}
          />
          <Modal.Body gap="$3">
            <Text variant="body">
              The last attempt may already be recorded. Clearing doesn&rsquo;t
              undo it, and ringing these tickets up again would sell them
              twice.
            </Text>
            <Text variant="caption" tone="muted">
              Check Cash taken tonight, or the event&rsquo;s orders for a card
              sale, first.
            </Text>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="$3"
              onPress={() => setConfirmDiscard(null)}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              size="$3"
              data-testid="sell-confirm-discard"
              onPress={() => {
                const pending = confirmDiscard;
                resetSale();
                if (pending?.kind === "switch-event") {
                  setEventId(pending.eventId);
                }
              }}
            >
              Clear it anyway
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {eventId ? (
        <ManualTaxRateDialog
          open={enteringTaxRate}
          eventId={eventId}
          eventLabel={eventLabel}
          onClose={() => {
            setEnteringTaxRate(false);
            // Whatever happened in there (a rate stored, or the server saying
            // the lookup answers again), the quote is worth asking for again.
            void quoteQuery.refetch();
          }}
          onSaved={(rateBps) =>
            toast.success({
              id: "sell-manual-tax-rate-set",
              title: `Tax set to ${ratePercentText(rateBps)}%`,
              message:
                "Every sale of this event charges it until the lookup answers again.",
            })
          }
        />
      ) : null}
    </YStack>
  );
}
