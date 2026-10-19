"use client";

import {
  useState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { nanoid } from "nanoid";
import Link from "next/link";
import { YStack, XStack, Card, Spinner, styled } from "tamagui";
import {
  Repeat,
  Tag,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

// Swiss 2px structural divider
const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});

import {
  Text,
  TextInput,
  Button,
  FormErrorBanner,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";

import { trpc } from "@/trpc";
import { fmtCurrency, fmtDate, fmtDateShort, toMajorUnits } from "@/lib/format";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { originalPriceLine, originalPriceText } from "@/lib/resale/original-price";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { formatErrorMessage } from "@/lib/format-error-message";
import { EmailVerificationRequiredPage } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { useFormErrors } from "@/hooks/useFormErrors";
import { getAppErrorCode } from "@/lib/app-error";
import { settingsSectionHref } from "@/app/account/settings/_lib/settings-routes";
import { useNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";
import { RESALE_LISTING_MAX_ASK_CENTS } from "@th/core/lib/pricing/resale-pricing";
import { derivePayoutGate } from "./payout-gate";
import { ResaleSplitCard } from "./ResaleSplitCard";

// Text links on this page: a 44px tap target, the arrow an aria-hidden icon
// so it never lands in the accessible name. `accentText`, not `accent`: this
// is an interactive label (design system §9).
const TEXT_LINK_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minHeight: 44,
  alignSelf: "flex-start",
  color: "var(--accentText, #A8300F)",
  textDecoration: "none",
} as const;

// The Seller Hub shell and the page wrapper leave this form a 174px column on
// a 320px phone, so every card here insets 12px there and the usual 16px from
// 481px up. One constant for all of them, so the cards keep a shared left
// edge at every width. Phone-first base widened with `$gtXs`: a narrower
// `$xs` rung would be dead code (`$sm` overrides it).
const CARD_INSET = { padding: "$3", $gtXs: { padding: "$4" } } as const;

// The price field is a 36px control; under a finger it takes the 44px touch
// minimum. Keyed on the pointer, not the width, so a touch tablet gets it and
// a narrow desktop window does not. A listing's Cancel button (34px at its
// size) takes the same minimum, the same way.
const TOUCH_MIN_HEIGHT = { minHeight: 44 } as const;

// Room left between the sticky site navbar and a block scrolled up to sit
// under it.
const NAVBAR_SCROLL_GAP = 16;

const statusKeys: Record<string, string> = {
  ACTIVE: "resell.statusActive",
  HELD: "resell.statusHeld",
  SOLD: "resell.statusSold",
  CANCELLED: "resell.statusCancelled",
  EXPIRED: "resell.statusExpired",
};

// What a ticket that cannot be listed says about itself: the same labels the
// order page gives these statuses (`OrderDetail`'s `ticketStatusKeys`). Keyed
// on every status but VALID, so a new ticket status fails the typecheck here
// instead of rendering a card with no reason on it.
const notListableStatusKeys: Record<
  "SCANNED" | "INVALID" | "REFUNDED" | "LISTED",
  string
> = {
  SCANNED: "orderDetail.used",
  INVALID: "orderDetail.invalid",
  REFUNDED: "myTickets.refunded",
  LISTED: "orderDetail.listedForResale",
};

// Tamagui turns `role="button"` into a tab stop, and its `onPress` is a click
// handler only: nothing maps Enter or Space onto it. Spread this beside
// `onPress` so the keyboard can press what it can focus (the same shape as
// `chipActivation` on /search). It arrives through a cast because Tamagui's
// view props are React-Native-first and omit the DOM `onKeyDown`. Space is
// `preventDefault`ed: its default action is to scroll the page. A held key
// presses once: its repeats are swallowed (still without scrolling), so the
// ticket does not flick open and shut for as long as Enter is down.
const keyboardActivation = (activate: () => void): object =>
  ({
    onKeyDown: (event: {
      key: string;
      repeat?: boolean;
      preventDefault: () => void;
    }) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.repeat) return;
      activate();
    },
  }) as object;

type ResellFormProps = {
  orderId: string;
};

export function ResellForm({ orderId }: ResellFormProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const utils = trpc.useUtils();

  // ── Data queries ────────────────────────────────────────────────────────
  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000 },
  );

  const order = orderQuery.data;

  // `createListing` takes a TICKET id, and an order item id is a different
  // row (Ticket.orderItemId is unique, so at most one ticket per item). The
  // order page joins the two the same way. The map keeps the ticket's status:
  // only a VALID ticket can be listed, and any other one says which it is.
  const ticketsQuery = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    { enabled: !!order, staleTime: 30_000 },
  );
  const ticketByOrderItemId = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<typeof ticketsQuery.data>["tickets"][number]
    >();
    for (const ticket of ticketsQuery.data?.tickets ?? []) {
      if (ticket.orderItemId) map.set(ticket.orderItemId, ticket);
    }
    return map;
  }, [ticketsQuery.data]);

  // `resaleListingId` means two things. On a RESALE order every item carries
  // it for life: it is the listing the ticket was BOUGHT through, and that
  // ticket can be resold again, so there "on sale now" is the ticket's status
  // (LISTED), known once the tickets read lands; until then the item stays in
  // and the page shows the spinner or the failure card. On any other order it
  // is a listing the buyer opened, and the item is left out straight away.
  // Either way the listing itself is under "Active listings" above.
  // A refunded RESALE order offers nothing: its item stays `active` (the
  // refund is whole-order), and `createListing` refuses a ticket whose resale
  // purchase was refunded (`purchase_refunded`).
  const isResaleOrder = order?.source === "RESALE";
  const resalePurchaseRefunded = isResaleOrder && order?.status === "REFUNDED";
  const resellableItems =
    order?.items.filter(
      (i) =>
        i.kind === "ticket" &&
        i.status === "active" &&
        !i.refundedAt &&
        !i.transferredAt &&
        !resalePurchaseRefunded &&
        !(isResaleOrder
          ? ticketByOrderItemId.get(i.id)?.status === "LISTED"
          : i.resaleListingId),
    ) ?? [];

  // ── Form state per ticket ──────────────────────────────────────────────
  // An ORDER ITEM id; the ticket id is resolved from it at submit time.
  const [selectedOrderItemId, setSelectedOrderItemId] = useState<
    string | null
  >(null);
  const [askPriceDollars, setAskPriceDollars] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch existing listings by the seller
  const myListingsQuery = trpc.resale.listMyListings.useQuery(
    { status: ["ACTIVE", "HELD"], limit: 100 },
    { staleTime: 15_000 },
  );

  // The seller's own Connect status (no orgId → the actor's HUMAN payee), so
  // a seller who can't be paid sees the setup link before filling the form.
  // Advisory only: `createListing` makes the authoritative check and refuses
  // with SELLER_PAYOUT_NOT_SETUP, which also raises the same callout below.
  // The read goes to live Stripe, so skip it when there is nothing to resell.
  // "Something to resell" is a ticket that can be listed right now, which is
  // a VALID one: an order whose only ticket is used, or has no ticket row,
  // must not send its owner into payout setup for a sale they cannot make.
  // False until the tickets read lands, so the Stripe read waits for it.
  const hasResellable = resellableItems.some(
    (i) => ticketByOrderItemId.get(i.id)?.status === "VALID",
  );
  const connectStatusQuery = trpc.stripeConnect.getStatus.useQuery(
    {},
    {
      enabled: hasResellable,
      staleTime: 60_000,
      retry: false,
      meta: { silent: true },
    },
  );
  // A refusal shows the card until a status read made AFTER it says payouts
  // are on (the seller fixed it in another tab and a focus refetch landed);
  // then the card gives way to a one-line "list it again" (no silent vanish,
  // and no automatic re-submit of a listing the seller didn't press for).
  const [payoutRefusedAt, setPayoutRefusedAt] = useState<number | null>(null);
  const payoutGate = derivePayoutGate({
    hasResellable,
    status: connectStatusQuery.data,
    statusUpdatedAt: connectStatusQuery.dataUpdatedAt,
    refusedAt: payoutRefusedAt,
  });
  const payoutCardId = useId();
  const payoutCardTitleId = `${payoutCardId}-title`;
  // The price field takes its accessible name from the visible "PRICE ($)"
  // caption above it. One id is enough: only one ticket's form is open.
  const priceLabelId = `${payoutCardId}-price-label`;

  // A refusal raises the card at the top of the page, which on a phone is
  // off-screen above the form. Bring it into view and move focus to it, so
  // it is both seen and announced (its heading is the group's name).
  useEffect(() => {
    if (payoutRefusedAt === null) return;
    const card = document.getElementById(payoutCardId);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.focus({ preventScroll: true });
  }, [payoutRefusedAt, payoutCardId]);

  const bannerMessage = formError;
  const clearBanner = useCallback(() => {
    clearAll();
  }, [clearAll]);

  const myListings = myListingsQuery.data;

  // A new listing appears under "Your active listings", ABOVE the form the
  // seller just pressed. The browser holds the form where it was, so the new
  // listing (and its Cancel button) lands up under the sticky navbar, where
  // a tap hits the navbar instead. Once the refreshed listings carry the new
  // one, bring the block into view below the navbar and move focus to it, so
  // the listing is seen and announced. Newest first: the new listing sits
  // right under the block's heading.
  const listingsBlockId = `${payoutCardId}-listings`;
  const listingsHeadingId = `${payoutCardId}-listings-heading`;
  const [justListedId, setJustListedId] = useState<string | null>(null);
  // The navbar's height while it is SHOWN. The store reads 0 while it is slid
  // away on a phone, but scrolling up brings it back, so the last height it
  // had on screen is the one the block must clear.
  const navbarVisibleHeight = useNavbarVisibleHeight();
  const navbarShownHeight = useRef(0);
  useEffect(() => {
    if (navbarVisibleHeight > 0) navbarShownHeight.current = navbarVisibleHeight;
  }, [navbarVisibleHeight]);
  useEffect(() => {
    if (justListedId === null) return;
    if (!myListings?.items.some((listing) => listing.id === justListedId)) {
      return;
    }
    setJustListedId(null);
    // The listed form closes, so focus falls to the body. Anywhere else, the
    // seller has moved on (tabbed or tapped into another control before the
    // listings came back): leave the page and their focus where they are.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const block = document.getElementById(listingsBlockId);
    if (!block) return;
    block.style.scrollMarginTop = `${navbarShownHeight.current + NAVBAR_SCROLL_GAP}px`;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    block.scrollIntoView({
      block: "start",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    block.focus({ preventScroll: true });
  }, [justListedId, myListings, listingsBlockId]);

  // ── The split the server prices (organiser-resale-share NFR-002) ────────
  // The seller sees the share, what they receive and what the buyer pays from
  // `resale.estimateListing`, which prices with the functions a listing is
  // charged with. Nothing is added up here. The ask is debounced so typing
  // does not send a read per keystroke; the card shows only an answer that
  // belongs to the ask in the field.
  const selectedTicket = selectedOrderItemId
    ? ticketByOrderItemId.get(selectedOrderItemId)
    : undefined;
  const debouncedAsk = useDebouncedValue(askPriceDollars, 350);
  const parsedDebouncedAsk = parseMoneyInputToCents(debouncedAsk);
  const splitAskCents =
    parsedDebouncedAsk.ok &&
    parsedDebouncedAsk.cents > 0 &&
    parsedDebouncedAsk.cents <= RESALE_LISTING_MAX_ASK_CENTS
      ? parsedDebouncedAsk.cents
      : null;
  const splitQuery = trpc.resale.estimateListing.useQuery(
    {
      ticketId: selectedTicket?.id ?? "",
      askPriceCents: splitAskCents ?? 1,
    },
    {
      enabled:
        selectedTicket?.status === "VALID" &&
        splitAskCents !== null &&
        debouncedAsk === askPriceDollars,
      staleTime: 30_000,
      retry: false,
      meta: { silent: true },
    },
  );
  // Only an answer for the ask in the field NOW: during the debounce the
  // previous answer is stale, and List would submit the new ask under it.
  const split =
    debouncedAsk === askPriceDollars &&
    splitQuery.data &&
    splitQuery.data.askPriceCents === splitAskCents
      ? splitQuery.data
      : null;
  const splitOverCap = split !== null && !split.withinCap;
  const currentAsk = parseMoneyInputToCents(askPriceDollars);
  // A readable ask whose answer has not landed: List waits for it, so what
  // the seller lists is what the card showed.
  const splitPending =
    currentAsk.ok &&
    currentAsk.cents > 0 &&
    currentAsk.cents <= RESALE_LISTING_MAX_ASK_CENTS &&
    split === null &&
    !splitQuery.isError;

  // ── Create listing mutation ─────────────────────────────────────────────
  // Listing and cancelling both move the TICKET's status (VALID ⇄ LISTED) as
  // well as the item's `resaleListingId`, so the tickets read goes stale with
  // the order read. Nothing else refetches it (no refetch on window focus):
  // without this, a ticket whose listing was just cancelled comes back still
  // reading as listed until the page is reloaded.
  const createListingMutation = trpc.resale.createListing.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      utils.resale.listMyListings.invalidate();
      utils.orders.getMyOrder.invalidate({ orderId });
      utils.orders.listMyOrderTickets.invalidate({ orderId });
    },
  });

  const cancelListingMutation = trpc.resale.cancelListing.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      utils.resale.listMyListings.invalidate();
      utils.orders.getMyOrder.invalidate({ orderId });
      utils.orders.listMyOrderTickets.invalidate({ orderId });
    },
  });

  const handleCreateListing = useCallback(async () => {
    // One listing per press. The button is disabled while a create is in
    // flight, but Enter in the price field reaches this too, and a second
    // create would carry a fresh `clientKey`.
    if (isSubmitting) return;
    if (!selectedOrderItemId || !askPriceDollars.trim()) return;
    const ticket = ticketByOrderItemId.get(selectedOrderItemId);
    if (!ticket || ticket.status !== "VALID") return;
    if (splitOverCap || splitPending) return;
    const ticketId = ticket.id;
    clearBanner();
    // A new attempt answers any earlier refusal (and its ready-now line).
    setPayoutRefusedAt(null);

    // Free-text field, so `parseFloat` would read an es-locale "15,50" as 15
    // and list the ticket 50c under what the seller asked for. The shared
    // reader takes both decimal separators and refuses whatever it can't read.
    const parsedAsk = parseMoneyInputToCents(askPriceDollars);
    if (!parsedAsk.ok || parsedAsk.cents <= 0) {
      toast.danger({
        id: "resale-price-invalid",
        title: String(t("resell.invalidPriceTitle")),
        message: String(
          !parsedAsk.ok && parsedAsk.reason === "ambiguous"
            ? t("resell.ambiguousPriceMessage")
            : t("resell.invalidPriceMessage"),
        ),
      });
      return;
    }
    const askPriceCents = parsedAsk.cents;

    setIsSubmitting(true);
    try {
      const created = await createListingMutation.mutateAsync({
        ticketId,
        askPriceCents,
        clientKey: nanoid(12),
      });
      setJustListedId(created?.listingId ?? null);

      toast.success({
        id: "resale-listing-created",
        title: "Listing created",
        message: "Your ticket is now listed for resale.",
      });

      setSelectedOrderItemId(null);
      setAskPriceDollars("");
    } catch (error) {
      // Not a form error the seller can fix by editing the price: show the
      // payout-setup callout (with its link) instead of the generic banner.
      const code = getAppErrorCode(error);
      if (code === "SELLER_PAYOUT_NOT_SETUP") {
        setPayoutRefusedAt(Date.now());
        void utils.stripeConnect.getStatus.invalidate();
      } else {
        setError(error);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    selectedOrderItemId,
    ticketByOrderItemId,
    askPriceDollars,
    splitOverCap,
    splitPending,
    createListingMutation,
    toast,
    t,
    clearBanner,
    setError,
    utils,
  ]);

  const handleCancelListing = useCallback(
    async (listingId: string) => {
      try {
        await cancelListingMutation.mutateAsync({ listingId });
        toast.success({
          id: "resale-listing-cancelled",
          title: "Listing cancelled",
          message: "Your ticket has been delisted.",
        });
      } catch (error) {
        toast.danger({
          id: "resale-cancel-failed",
          title: "Could not cancel listing",
          message: formatErrorMessage(error, t),
        });
      }
    },
    [cancelListingMutation, t, toast],
  );

  // ── Loading state ───────────────────────────────────────────────────────
  if (orderQuery.isLoading) {
    return (
      <YStack gap="$6" paddingVertical="$4" alignItems="center">
        <Spinner size="large" />
      </YStack>
    );
  }

  if (
    isEmailVerificationRequired(orderQuery.error) ||
    isEmailVerificationRequired(ticketsQuery.error)
  ) {
    return (
      <EmailVerificationRequiredPage
        context="order"
        backHref="/my-tickets"
        backLabel={String(t("orderDetail.backToMyTickets"))}
        testId="resell-verify-email"
      />
    );
  }

  if (!order) {
    return (
      <YStack gap="$6" paddingVertical="$4">
        <Text variant="body" tone="muted">
          Order not found.
        </Text>
      </YStack>
    );
  }

  const currency = order.currency ?? "usd";

  // An item with no ticket row has no status to show, so it is not listed at
  // all; if that leaves nothing, the "no tickets available" card covers it.
  const itemsWithTicket = resellableItems.filter((i) =>
    ticketByOrderItemId.has(i.id),
  );
  // What stands in the ticket list's place. A failed tickets read and one
  // still in flight each say so: neither may look like "you have no tickets"
  // or like a list of tickets that cannot be pressed.
  const ticketListState =
    resellableItems.length === 0
      ? "empty"
      : ticketsQuery.error
        ? "failed"
        : !ticketsQuery.data
          ? "loading"
          : itemsWithTicket.length === 0
            ? "empty"
            : "ready";

  return (
    <YStack
      gap="$6"
      paddingVertical="$4"
      maxWidth={640}
      width="100%"
      marginHorizontal="auto"
    >
      {/* Back link */}
      <Link href={`/my-tickets/${orderId}`} style={TEXT_LINK_STYLE}>
        <ArrowLeft size={16} aria-hidden />
        <Text
          variant="body"
          color="$accentText"
          textTransform="uppercase"
          letterSpacing={1}
          weight="bold"
        >
          {String(t("resell.backToOrder"))}
        </Text>
      </Link>

      {/* Header */}
      <YStack
        gap="$2"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        paddingBottom="$4"
      >
        <XStack gap="$3" alignItems="center">
          <Repeat size={24} color="var(--accent)" aria-hidden />
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("resell.ticketResale"))}
          </Text>
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("resell.snapshotIntro"))}
        </Text>
      </YStack>

      <FormErrorBanner message={bannerMessage} onDismiss={clearBanner} />

      {payoutGate.showSetupCard && (
        <Card
          id={payoutCardId}
          tabIndex={-1}
          role="group"
          aria-labelledby={payoutCardTitleId}
          {...CARD_INSET}
          gap="$2"
          borderRadius={0}
          data-testid="resell-payout-setup"
        >
          <XStack gap="$2" alignItems="center">
            <AlertTriangle
              size={18}
              color="var(--warning, #92400E)"
              aria-hidden
            />
            <Text variant="body" weight="bold" id={payoutCardTitleId}>
              {String(t("resell.payoutSetupTitle"))}
            </Text>
          </XStack>
          <Text variant="bodySmall" tone="muted">
            {String(t("resell.payoutSetupMessage"))}
          </Text>
          <Link href={settingsSectionHref("billing")} style={TEXT_LINK_STYLE}>
            <Text
              variant="body"
              color="$accentText"
              textTransform="uppercase"
              letterSpacing={1}
              weight="bold"
            >
              {String(t("resell.payoutSetupLink"))}
            </Text>
            <ArrowRight size={16} aria-hidden />
          </Link>
        </Card>
      )}

      {/* Always mounted, so the ready-now line is announced when it appears.
          Out of flow while empty: an empty in-flow child would still take a
          gap in this column. */}
      <YStack
        role="status"
        position={payoutGate.showReadyNow ? "relative" : "absolute"}
      >
        {payoutGate.showReadyNow && (
          <XStack gap="$2" alignItems="center" data-testid="resell-payout-ready">
            <CheckCircle2
              size={16}
              color="var(--success, #166534)"
              style={{ flexShrink: 0 }}
              aria-hidden
            />
            <Text variant="bodySmall" flexShrink={1} minWidth={0}>
              {String(t("resell.payoutReadyNow"))}
            </Text>
          </XStack>
        )}
      </YStack>

      {/* Active listings */}
      {myListings && myListings.items.length > 0 && (
        <YStack
          id={listingsBlockId}
          tabIndex={-1}
          role="region"
          aria-labelledby={listingsHeadingId}
          gap="$3"
        >
          <Text
            id={listingsHeadingId}
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("resell.activeListings"))}
          </Text>
          {myListings.items.map((listing) => {
            const originalLine = originalPriceLine(listing);
            return (
            <Card key={listing.id} {...CARD_INSET} gap="$3" borderRadius={0}>
              <XStack justifyContent="space-between" alignItems="center">
                <YStack gap="$1">
                  <Text variant="body" weight="bold">
                    {fmtCurrency(fmt, listing.askPriceCents, listing.currency)}
                  </Text>
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t(statusKeys[listing.status] ?? "resell.statusActive"),
                    )}
                  </Text>
                </YStack>
                {listing.status === "ACTIVE" && (
                  <Button
                    variant="secondary"
                    size="$2"
                    $pointerCoarse={TOUCH_MIN_HEIGHT}
                    onPress={() => handleCancelListing(listing.id)}
                    disabled={cancelListingMutation.isPending}
                  >
                    Cancel
                  </Button>
                )}
              </XStack>

              <YStack
                gap="$2"
                borderTopWidth={1}
                borderTopColor="$borderColor"
                paddingTop="$3"
              >
                <XStack justifyContent="space-between" gap="$3">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("resell.askingPriceLabel"))}
                  </Text>
                  <Text variant="bodySmall" weight="bold">
                    {fmtCurrency(fmt, listing.askPriceCents, listing.currency)}
                  </Text>
                </XStack>

                {listing.eventShareCents != null && listing.sharePayer && (
                  <XStack justifyContent="space-between" gap="$3">
                    <Text variant="bodySmall" tone="muted">
                      {String(t("resell.shareLineLabel"))}
                    </Text>
                    <Text variant="bodySmall">
                      {fmtCurrency(
                        fmt,
                        listing.eventShareCents,
                        listing.currency,
                      )}
                    </Text>
                  </XStack>
                )}

                {listing.sellerReceivesCents != null && (
                  <XStack justifyContent="space-between" gap="$3">
                    <Text variant="bodySmall" weight="bold">
                      {String(t("resell.youReceive"))}
                    </Text>
                    <Text variant="bodySmall" weight="bold">
                      {fmtCurrency(
                        fmt,
                        listing.sellerReceivesCents,
                        listing.currency,
                      )}
                    </Text>
                  </XStack>
                )}

                {originalLine !== null ? (
                  <Text variant="bodySmall" tone="muted">
                    {originalPriceText(originalLine, t, (cents) =>
                      fmtCurrency(fmt, cents, listing.currency),
                    )}
                  </Text>
                ) : listing.eventShareCents == null &&
                  listing.faceValueCents !== null ? (
                  <XStack justifyContent="space-between" gap="$3">
                    <Text variant="bodySmall" tone="muted">
                      {String(t("resell.faceValueLabel"))}
                    </Text>
                    <Text variant="bodySmall">
                      {fmtCurrency(
                        fmt,
                        listing.faceValueCents,
                        listing.currency,
                      )}
                    </Text>
                  </XStack>
                ) : null}

                <XStack justifyContent="space-between" gap="$3">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("resell.processingPassThroughBeforeTaxLabel"))}
                  </Text>
                  <Text variant="bodySmall">
                    {fmtCurrency(
                      fmt,
                      listing.processingPassThroughCents,
                      listing.currency,
                    )}
                  </Text>
                </XStack>

                {listing.saleCutoffAt && (
                  <XStack justifyContent="space-between" gap="$3">
                    <Text variant="bodySmall" tone="muted">
                      {String(t("resell.saleCutoffLabel"))}
                    </Text>
                    <Text variant="bodySmall">
                      {fmtDate(fmt, listing.saleCutoffAt)}
                    </Text>
                  </XStack>
                )}

                {listing.payoutReleaseAt && (
                  <XStack justifyContent="space-between" gap="$3">
                    <Text variant="bodySmall" tone="muted">
                      {String(t("resell.payoutReleaseTargetLabel"))}
                    </Text>
                    <Text variant="bodySmall">
                      {fmtDateShort(fmt, listing.payoutReleaseAt)}
                    </Text>
                  </XStack>
                )}
              </YStack>

              {listing.payoutReleaseAt && (
                <Text variant="caption" tone="muted">
                  {String(t("resell.releaseTargetDisclaimer"))}
                </Text>
              )}
            </Card>
            );
          })}
        </YStack>
      )}

      <Separator />

      {/* Resellable tickets */}
      {ticketListState === "empty" && (
        <Card
          padding="$4"
          $gtXs={{ padding: "$6" }}
          gap="$3"
          alignItems="center"
          borderRadius={0}
        >
          <AlertTriangle size={24} color="var(--warning)" aria-hidden />
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("resell.noTicketsAvailable"))}
          </Text>
        </Card>
      )}

      {/* Queries raise no toast of their own and do not retry, so a failed
          tickets read has to say so here, with a way to try again. */}
      {ticketListState === "failed" && (
        <Card
          role="alert"
          {...CARD_INSET}
          gap="$3"
          borderRadius={0}
          data-testid="resell-tickets-load-failed"
        >
          <XStack gap="$2" alignItems="center">
            <AlertTriangle
              size={18}
              color="var(--warning, #92400E)"
              aria-hidden
            />
            <Text variant="body" weight="bold">
              {String(t("resaleClaim.loadFailedTitle"))}
            </Text>
          </XStack>
          <Text variant="bodySmall" tone="muted">
            {formatErrorMessage(ticketsQuery.error, t)}
          </Text>
          <XStack>
            <Button
              variant="secondary"
              size="$2"
              minHeight={44}
              onPress={() => {
                void ticketsQuery.refetch();
              }}
              disabled={ticketsQuery.isFetching}
            >
              {String(t("orderDetail.retry"))}
            </Button>
          </XStack>
        </Card>
      )}

      {ticketListState === "loading" && (
        <YStack
          padding="$6"
          alignItems="center"
          data-testid="resell-tickets-loading"
        >
          <Spinner size="large" />
        </YStack>
      )}

      {ticketListState === "ready" && (
        <YStack gap="$4">
          <Card {...CARD_INSET} gap="$2" borderRadius={0}>
            <Text
              variant="bodySmall"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("resell.economicsTitle"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("resell.economicsLosses"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("resell.economicsProcessing"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("resell.economicsRelease"))}
            </Text>
          </Card>

          {/* Not over a list where nothing can be selected (every ticket
              shown is used, invalid, refunded or already listed). */}
          {hasResellable && (
            <Text
              variant="h4"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("resell.selectTicketToResell"))}
            </Text>
          )}

          {itemsWithTicket.map((item) => {
            const ticket = ticketByOrderItemId.get(item.id);
            if (!ticket) return null;
            // Null for the one status that can be listed; otherwise the
            // label that says why this ticket cannot.
            const notListableKey =
              ticket.status === "VALID"
                ? null
                : notListableStatusKeys[ticket.status];
            const selectable = notListableKey === null;
            const isSelected = selectable && selectedOrderItemId === item.id;
            const toggleSelected = () => {
              setSelectedOrderItemId(isSelected ? null : item.id);
              // Start at what the seller paid: the split below then shows
              // what listing at cost leaves them, and they move from there.
              if (!askPriceDollars && item.unitPriceCents > 0) {
                setAskPriceDollars(
                  toMajorUnits(item.unitPriceCents, currency).toFixed(2),
                );
              }
            };

            return (
              <Card
                key={item.id}
                padding={0}
                borderRadius={0}
                borderWidth={isSelected ? 3 : 2}
                borderColor={isSelected ? "$accent" : "$borderColor"}
              >
                {/* Only the header selects the ticket. The price field below
                    is a sibling, so a click into it never bubbles to this
                    handler and collapses the form. The header carries the
                    card's padding, so the press target runs edge to edge.
                    A ticket that cannot be listed is not a button at all (no
                    tab stop, no press): it shows its status instead.
                    The row wraps: when the label and the estimate do not fit
                    side by side, the estimate drops under the label instead
                    of squeezing it to nothing. On a phone that is the usual
                    case, so there the estimate's lines share the label's
                    left edge; from 481px up they are right-aligned against
                    the card's right edge, wrapped or not. */}
                <XStack
                  justifyContent="space-between"
                  alignItems="center"
                  flexWrap="wrap"
                  columnGap="$3"
                  rowGap="$1"
                  {...CARD_INSET}
                  minHeight={44}
                  data-testid={`resell-ticket-${item.id}`}
                  role={selectable ? "button" : undefined}
                  aria-pressed={selectable ? isSelected : undefined}
                  cursor={selectable ? "pointer" : undefined}
                  onPress={selectable ? toggleSelected : undefined}
                  {...(selectable ? keyboardActivation(toggleSelected) : {})}
                >
                  <YStack gap="$1" flexShrink={1} minWidth={0}>
                    <Text variant="body" weight="bold">
                      {String(t("resell.ticketLabel"))}
                    </Text>
                    <Text variant="bodySmall" tone="muted">
                      {String(
                        t("resell.youPaid", {
                          amount: fmtCurrency(
                            fmt,
                            item.unitPriceCents,
                            currency,
                          ),
                        }),
                      )}
                    </Text>
                  </YStack>
                  {notListableKey !== null ? (
                    <Text variant="bodySmall" weight="bold">
                      {String(t(notListableKey))}
                    </Text>
                  ) : null}
                </XStack>

                {/* Inline listing form for selected ticket */}
                {isSelected && (
                  <YStack
                    gap="$3"
                    paddingHorizontal="$3"
                    paddingBottom="$3"
                    paddingTop="$1"
                    $gtXs={{ paddingHorizontal: "$4", paddingBottom: "$4" }}
                  >
                    <Separator />
                    <YStack gap="$2">
                      <Text variant="bodySmall" weight="bold">
                        <Tag size={13} aria-hidden /> {String(t("resell.setAskPrice"))}
                      </Text>
                      <YStack gap="$1">
                        <Text
                          id={priceLabelId}
                          variant="caption"
                          tone="muted"
                          style={{ textTransform: "uppercase" }}
                        >
                          {String(t("resell.priceInputLabel"))}
                        </Text>
                        <TextInput
                          aria-labelledby={priceLabelId}
                          name="askPrice"
                          value={askPriceDollars}
                          onChangeText={setAskPriceDollars}
                          placeholder="0.00"
                          inputMode="decimal"
                          fullWidth
                          $pointerCoarse={TOUCH_MIN_HEIGHT}
                          testId="resale-ask-price"
                          onSubmitEditing={handleCreateListing}
                          returnKeyType="done"
                        />
                      </YStack>
                    </YStack>

                    <ResaleSplitCard
                      split={split}
                      pending={splitPending}
                      errorMessage={
                        splitQuery.isError
                          ? formatErrorMessage(splitQuery.error, t)
                          : null
                      }
                      paidCents={item.unitPriceCents}
                      onUseAsk={(cents) =>
                        setAskPriceDollars(
                          toMajorUnits(cents, currency).toFixed(2),
                        )
                      }
                    />

                    {/* Full width under the split, as the board draws it. The
                        label may wrap: a longer translation is wider than a
                        phone's column on one line. */}
                    <Button
                      variant="primary"
                      size="$3"
                      width="100%"
                      minWidth={0}
                      height="auto"
                      minHeight={44}
                      paddingVertical="$2"
                      textProps={{
                        whiteSpace: "normal",
                        textAlign: "center",
                        lineHeight: 16,
                      }}
                      onPress={handleCreateListing}
                      disabled={
                        !askPriceDollars.trim() ||
                        isSubmitting ||
                        splitOverCap ||
                        splitPending
                      }
                      aria-describedby={
                        splitOverCap ? "resell-split-overcap" : undefined
                      }
                    >
                      {isSubmitting
                        ? String(t("resell.listingInProgress"))
                        : split
                          ? String(
                              t("resell.listForAmount", {
                                amount: fmtCurrency(
                                  fmt,
                                  split.askPriceCents,
                                  currency,
                                ),
                              }),
                            )
                          : String(t("resell.listForSale"))}
                    </Button>
                  </YStack>
                )}
              </Card>
            );
          })}
        </YStack>
      )}

    </YStack>
  );
}
