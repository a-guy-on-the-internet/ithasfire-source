"use client";

import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
} from "react";
import { formatOrderCode } from "@th/types/order-identifier";
import { fmtCurrency } from "@/lib/format";
import { readableDateIso } from "@/lib/readable-date";
import { CONFIRMATION_HEADING_ID } from "./confirmation-heading";
import type { ConfirmedPayment } from "./confirmed-payment";
import {
  ArrowRight,
  Ticket,
  Calendar,
  MapPin,
  Share2,
  CalendarPlus,
  QrCode,
  Mail,
  Check,
  Wallet,
  Clock,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, useTranslations, useFormatters } from "@th/ui";
import { getBuyerLineTotalCents } from "@/lib/pricing/buyer-display";
import { STRUCTURAL } from "@/lib/design-tokens";
import {
  FG as fg,
  BORDER_SUBTLE,
  DIVIDER_COLOR,
  SURFACE_OVERLAY,
  fgAlpha,
  FS_BODY,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";
import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "@/lib/calendar/web-calendar";
import { downloadICalFile } from "@/lib/calendar/ical";

// ── CSS keyframe animations (injected once via <style>) ──────────────────────
// `conf-print`: the ticket card feeds out of the printer slot in hard steps
// (thermal-printer register; no easing, no overshoot). It lives on a CLASS,
// not an inline style, so the reduced-motion query and the already-printed
// modifier can switch it off from CSS. `both` fill: the first frame is fully
// inside the slot and the last frame is the resting position, so if JS never
// runs the card still ends up visible.
// `conf-fade-up`: the stagger on the other sections, also on a class for the
// same reason; each section sets its index inline as `--conf-i`.
const KEYFRAMES = `
@keyframes conf-print {
  0%   { transform: translateY(-100%); }
  100% { transform: translateY(0); }
}
.conf-print-card {
  animation: conf-print 720ms 200ms steps(12, end) both;
}
.conf-print-card.conf-print-card--printed {
  animation: none;
}
@keyframes conf-fade-up {
  0%   { transform: translateY(18px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
.conf-fade-up {
  animation: conf-fade-up 0.5s calc(120ms + var(--conf-i, 0) * 80ms)
    cubic-bezier(0.22,1,0.36,1) both;
}
@media (prefers-reduced-motion: reduce) {
  .conf-print-card,
  .conf-fade-up { animation: none; }
}
`;

// Layout effect on the client (runs before paint), plain effect on the server
// (where neither runs; this only avoids the SSR layout-effect warning).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** sessionStorage key marking an order's ticket as already printed in this tab. */
const printedKey = (orderId: string) => `th:order-printed:${orderId}`;

/**
 * Whether this order's ticket has already printed in this tab (play once per
 * order per tab: a reload or back-navigation shows the resting card).
 *
 * Hydration safety: the first render is `false` on server AND client, so the
 * markup always matches and carries the animation class. The CSS animation
 * owns the first frame (card inside the slot) and the last (card at rest), so
 * there is no state where the card is hidden waiting on JS. The storage check
 * runs in a layout effect.
 *
 * Today this component only mounts client-side: the order arrives through the
 * client `orders.getMyOrder` query in useConfirmedOrder.ts, and
 * CheckoutConfirmedStep renders it only once that status is "ready". On a
 * client-side mount the layout effect lands before the browser paints, so a
 * repeat visit flips to the `--printed` modifier before any frame of the feed
 * is shown. If the order is ever SSR'd or prefetched into the first HTML, the
 * server markup would start the feed before hydration, and a reload would
 * show part of the feed before snapping to rest (never stuck hidden).
 *
 * The ref guards the check to once per orderId per mount: StrictMode's
 * effect double-invoke keeps refs, so the second run doesn't read back the
 * mark the first run just wrote and suppress the animation in dev.
 *
 * Storage can throw (privacy modes, quota, disabled). Then the ticket prints:
 * replaying the motion is the acceptable fallback.
 */
const useAlreadyPrinted = (orderId: string, enabled: boolean): boolean => {
  const [printed, setPrinted] = useState(false);
  const decidedFor = useRef<string | null>(null);

  useIsomorphicLayoutEffect(() => {
    // Off (a payment still processing): no ticket printed, so nothing is
    // marked; the real print plays once the order is paid.
    if (!enabled) return;
    if (decidedFor.current === orderId) return;
    decidedFor.current = orderId;
    let seen = false;
    try {
      const key = printedKey(orderId);
      seen = window.sessionStorage.getItem(key) !== null;
      if (!seen) window.sessionStorage.setItem(key, "1");
    } catch {
      seen = false;
    }
    setPrinted(seen);
  }, [orderId, enabled]);

  return printed;
};

export type ConfirmationTicketType = {
  id: string;
  name: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
};

export type ConfirmationOrderItem = {
  kind: string;
  ticketTypeId: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
};

export type ConfirmationOrder = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  /**
   * Processor fee in cents. For PASS_THROUGH this is the grossed-up fee the
   * buyer funded (included in the Total); for ABSORB it's a display-only
   * estimate the seller absorbed (excluded from the Total).
   */
  processorFeeCents: number;
  taxAmountCents: number;
  /**
   * Effective fee mode stamped by `createCheckout`. Gates whether the
   * processor fee is part of the confirmed Total. PASS_THROUGH includes it;
   * ABSORB / null does not.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /**
   * Platform credit applied to the charge, stamped by `createCheckout`.
   * Subtracted from the confirmed Total so it matches the PaymentIntent
   * amount on partial-credit orders (mirrors OrderSummary / the display hook).
   */
  creditAppliedCents?: number | null;
  /**
   * Server-stamped per-line pricing. When present, line items render from
   * `item.amountCents` (base pricing) so lines + Subtotal + fee rows add up —
   * the pre-hold fee-inclusive estimate would contradict the Subtotal row
   * directly beneath it. Mirrors OrderSummary's documented switch.
   */
  items?: ConfirmationOrderItem[];
};

export type OrderConfirmationProps = {
  orderId: string;
  eventName: string;
  eventSlug: string;
  eventDate: Date;
  /**
   * The event's id. Becomes the .ics `UID` so a buyer who hits "Add to
   * calendar" twice updates one entry instead of collecting duplicates.
   */
  eventId?: string;
  venueName?: string;
  venueAddress?: string;
  eventImageUrl?: string | null;
  order: ConfirmationOrder;
  ticketTypes: ConfirmationTicketType[];
  quantities: Record<string, number>;
  buyerEmail?: string;
  currency: string;
  selectedSeatLabels?: Record<string, string[]>;
  /** Whether the buyer accepted a waiver during checkout. */
  waiverAccepted?: boolean;
  /**
   * Whether the money moved: `paid`, or `processing` (a US bank debit Stripe
   * accepted that can still fail days later; no tickets yet). `processing`
   * keeps the order's figures and changes only what is untrue before the
   * money clears: the heading, "What's next", the primary button, and no
   * ticket print (owner, board option A, 2026-10-14). `unknown` never
   * reaches this screen: CheckoutConfirmedStep shows the "couldn't confirm"
   * copy instead.
   */
  payment: Exclude<ConfirmedPayment, "unknown">;
};

/** One "What's next" line: a quiet icon tile beside the copy. */
const WhatsNextRow = ({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) => (
  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: 0,
        background: fgAlpha(6),
        flexShrink: 0,
        marginTop: 1,
      }}
    >
      <Icon size={14} style={{ color: fgAlpha(55) }} />
    </div>
    <p
      style={{
        margin: 0,
        fontSize: FS_SM,
        lineHeight: 1.5,
        color: fgAlpha(70),
      }}
    >
      {children}
    </p>
  </div>
);

export const OrderConfirmation = ({
  orderId,
  eventName,
  eventSlug,
  eventDate,
  eventId,
  venueName,
  venueAddress,
  eventImageUrl,
  order,
  ticketTypes,
  quantities,
  buyerEmail,
  currency,
  selectedSeatLabels,
  waiverAccepted,
  payment,
}: OrderConfirmationProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const [copied, setCopied] = useState(false);
  const isProcessing = payment === "processing";
  // A processing order has no ticket yet: the card rests (no print) and the
  // tab is not marked printed, so the real print still plays once it's paid.
  const alreadyPrinted = useAlreadyPrinted(orderId, !isProcessing);
  const cardRests = alreadyPrinted || isProcessing;

  const formatPrice = useMemo(
    () => (cents: number) => fmtCurrency(fmt, cents, currency),
    [fmt, currency],
  );

  // For PASS_THROUGH the buyer funded the processor fee, so it's part of the
  // confirmed Total. For ABSORB the seller absorbed it — including it here
  // would overstate what the buyer was charged.
  const isPassThrough = order.feeMode === "PASS_THROUGH";
  const creditAppliedCents = order.creditAppliedCents ?? 0;
  const totalCents = Math.max(
    0,
    order.amountGrossCents +
      order.buyerFeesCents +
      (isPassThrough ? order.processorFeeCents : 0) +
      order.taxAmountCents -
      creditAppliedCents,
  );

  const selectedTickets = ticketTypes
    .map((tt) => ({ ...tt, qty: quantities[tt.id] ?? 0 }))
    .filter((tt) => tt.qty > 0);

  // Once the real order is in hand, line amounts come from its server-stamped
  // items (base pricing: they sum to `amountGrossCents`, the Subtotal row).
  // The fee-inclusive estimate would contradict the Subtotal/fee breakdown
  // rendered directly below. Mirrors OrderSummary / MobileCTABar.
  const orderLineCentsByTicketType = new Map<string, number>();
  if (order.items) {
    for (const item of order.items) {
      if (item.kind !== "ticket" || !item.ticketTypeId) continue;
      orderLineCentsByTicketType.set(
        item.ticketTypeId,
        (orderLineCentsByTicketType.get(item.ticketTypeId) ?? 0) +
          item.amountCents,
      );
    }
  }
  const lineCentsFor = (tt: { id: string; priceCents: number; qty: number }) =>
    order.items
      ? (orderLineCentsByTicketType.get(tt.id) ?? tt.priceCents * tt.qty)
      : getBuyerLineTotalCents(tt, tt.qty);
  // The order's gross is AFTER its discount (promo / member benefit) while its
  // ticket lines are at face, so with a promo the lines summed ABOVE the
  // Subtotal and nothing said why. The discount is what the lines exceed the
  // gross by: shown as its own row and added back onto the Subtotal — the
  // post-checkout pattern OrderSummary uses — so the rows sum to the Total.
  let ticketLinesCents = 0;
  for (const cents of orderLineCentsByTicketType.values()) {
    ticketLinesCents += cents;
  }
  const discountCents = order.items
    ? Math.max(0, ticketLinesCents - order.amountGrossCents)
    : 0;

  const totalQty = selectedTickets.reduce((sum, tt) => sum + tt.qty, 0);

  // An unreadable event date is an absent one, as on the event page: Intl
  // format and `toISOString` both throw a RangeError on an Invalid Date, which
  // would take the confirmation down after the buyer has paid. It shows
  // "Date TBA" (`common.dateNotSet`) and drops the Add to calendar menu.
  const eventIso = readableDateIso(eventDate);

  const dateLabel = useMemo(() => {
    if (!eventIso) return String(t("common.dateNotSet"));
    const weekday = fmt.dateTime(eventDate, { weekday: "long" });
    const monthDay = fmt.dateTime(eventDate, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const time = fmt.dateTime(eventDate, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${weekday}, ${monthDay} \u00B7 ${time}`;
  }, [eventIso, eventDate, fmt, t]);

  // ── Add to Calendar: shared event data ──────────────────────
  const calendarEvent = useMemo(() => {
    if (!eventIso) return null;
    const location = [venueName, venueAddress].filter(Boolean).join(", ");
    return {
      id: eventId,
      title: eventName,
      startsAt: eventIso,
      location: location || undefined,
    };
  }, [eventId, eventIso, eventName, venueName, venueAddress]);

  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when clicking outside
  useEffect(() => {
    if (!calendarOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        calendarRef.current &&
        !calendarRef.current.contains(e.target as Node)
      ) {
        setCalendarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [calendarOpen]);

  // ── Share ──────────────────────────────────────────────────────
  const eventUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/events/${eventSlug}`
      : `/events/${eventSlug}`;

  const handleShare = useCallback(async () => {
    const shareData = { title: eventName, url: eventUrl };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // User cancelled or not supported — fall through to clipboard
      }
    }
    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(eventUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  }, [eventName, eventUrl]);

  // ── Stagger delay helper ──────────────────────────────────────
  // Pairs with `className="conf-fade-up"`: the animation lives on the class
  // (so reduced motion can switch it off); this only sets the item's index,
  // giving a delay of 120ms + i × 80ms. React writes `--` keys unitless.
  const fadeUp = (i: number): React.CSSProperties =>
    ({ "--conf-i": i }) as React.CSSProperties;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 28,
        maxWidth: 640,
        margin: "0 auto",
        padding: "40px 20px 80px",
      }}
    >
      {/* Inject keyframes */}
      <style>{KEYFRAMES}</style>

      {/* ── Title ── */}
      <div
        className="conf-fade-up"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          textAlign: "center",
          ...fadeUp(0),
        }}
      >
        <div>
          <h1
            // Focus lands here when a dialog closed by the confirmation has
            // no opener left to return to (see useHoldWarningDialog).
            id={CONFIRMATION_HEADING_ID}
            tabIndex={-1}
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 700,
              color: fg,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {String(
              t(isProcessing ? "confirmation.processingTitle" : "confirmation.title"),
            )}
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: FS_BODY,
              color: fgAlpha(70),
              lineHeight: 1.5,
            }}
          >
            {String(
              t(
                isProcessing
                  ? "confirmation.processingSubtitle"
                  : "confirmation.subtitle",
              ),
            )}
          </p>
        </div>
      </div>

      {/* ── Order code badge ──
          The buyer's FIRST sight of their order code, so it has to be the same
          string admin search resolves: `formatOrderCode` (the 8-hex TAIL,
          uppercased), never `slice(0, 8)`. The head of the UUID is also 8 hex
          chars, so it satisfies the search parser's shape, produces an
          `id endsWith <head>` clause, and matches NOTHING — a buyer quoting it
          to support gets an empty result with no signal anything is wrong.
          The `confirmation.orderId` label supplies "Order", so the code is bare
          (no `#`) — see the `#` rule in ResaleCheckout / admin-order-row. */}
      <div
        className="conf-fade-up"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 0,
          background: fgAlpha(5),
          border: BORDER_SUBTLE,
          padding: "8px 16px",
          fontSize: FS_SM,
          fontWeight: 500,
          color: fgAlpha(70),
          ...fadeUp(1),
        }}
      >
        <span>{String(t("confirmation.orderId"))}</span>
        <span
          style={{
            fontWeight: 700,
            color: fg,
            letterSpacing: "0.02em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatOrderCode(orderId)}
        </span>
      </div>

      {/* ── Printer: the slot, and the main card feeding out of it ──
          One wrapper so the column's 28px gap doesn't open between slot and
          paper. The feed clips only the card's travel: the card sits inside
          the feed's padding box, so nothing is cut sideways. The card has no
          top border; it comes out from under the slot. */}
      <div style={{ width: "100%" }}>
        <div
          aria-hidden
          style={{
            height: 10,
            background: STRUCTURAL,
            borderRadius: 0,
          }}
        />
        {/* The paper is 10px narrower than the slot on each side, so the
            slot reads as the printer's mouth, not a thick top border. The
            inset is padding on the feed (border-box), so the card stays
            inside the feed's box and only its vertical travel is clipped. */}
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0 10px",
            overflow: "hidden",
          }}
        >
          {/* ── Main confirmation card ── */}
          <div
            // A new order in place remounts the card so its print replays.
            key={orderId}
            className={
              cardRests
                ? "conf-print-card conf-print-card--printed"
                : "conf-print-card"
            }
            style={{
              width: "100%",
              overflow: "hidden",
              borderRadius: 0,
              borderLeft: BORDER_SUBTLE,
              borderRight: BORDER_SUBTLE,
              borderBottom: BORDER_SUBTLE,
              background: SURFACE_OVERLAY,
            }}
          >
            {/* Event hero image */}
            {eventImageUrl && (
              <div
                style={{
                  width: "100%",
                  height: 160,
                  backgroundImage: `url(${eventImageUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  borderBottom: `1px solid ${DIVIDER_COLOR}`,
                }}
              />
            )}

            {/* Event details section */}
            <div style={{ padding: "24px 24px 20px" }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: fg }}>
                {eventName}
              </h2>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: FS_SM,
                    color: fgAlpha(75),
                  }}
                >
                  <Calendar
                    size={15}
                    style={{ flexShrink: 0, color: fgAlpha(50) }}
                  />
                  <span>{dateLabel}</span>
                </div>
                {venueName && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: FS_SM,
                      color: fgAlpha(75),
                    }}
                  >
                    <MapPin
                      size={15}
                      style={{ flexShrink: 0, color: fgAlpha(50) }}
                    />
                    <span>
                      {venueName}
                      {venueAddress ? ` \u00B7 ${venueAddress}` : ""}
                    </span>
                  </div>
                )}
              </div>

              {/* Quick actions: Calendar + Share */}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                {calendarEvent && (
                  <div ref={calendarRef} style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setCalendarOpen((prev) => !prev)}
                      aria-expanded={calendarOpen}
                      aria-haspopup="menu"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "7px 14px",
                        borderRadius: 0,
                        border: BORDER_SUBTLE,
                        background: fgAlpha(4),
                        fontSize: FS_SM,
                        fontWeight: 500,
                        color: fgAlpha(80),
                        cursor: "pointer",
                        transition: "background 0.15s",
                        fontFamily: "inherit",
                      }}
                    >
                      <CalendarPlus size={14} />
                      {String(t("confirmation.addToCalendar"))}
                    </button>
                    {calendarOpen && (
                      <div
                        role="menu"
                        style={{
                          position: "absolute",
                          bottom: "calc(100% + 6px)",
                          left: 0,
                          zIndex: 25,
                          minWidth: 200,
                          padding: "6px 0",
                          background: fg,
                          borderRadius: 0,
                          border: `1px solid ${fgAlpha(20)}`,
                          overflow: "hidden",
                        }}
                      >
                        <a
                          role="menuitem"
                          href={buildGoogleCalendarUrl(calendarEvent)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setCalendarOpen(false)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            padding: "10px 14px",
                            background: "none",
                            border: "none",
                            color: "var(--background, #F6F0E4)",
                            fontSize: FS_SM,
                            fontFamily: "inherit",
                            cursor: "pointer",
                            textDecoration: "none",
                            transition: "background 0.15s ease",
                          }}
                        >
                          <CalendarPlus size={16} />
                          {String(t("confirmation.addToGoogleCalendar"))}
                        </a>
                        <a
                          role="menuitem"
                          href={buildOutlookCalendarUrl(calendarEvent)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setCalendarOpen(false)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            padding: "10px 14px",
                            background: "none",
                            border: "none",
                            color: "var(--background, #F6F0E4)",
                            fontSize: FS_SM,
                            fontFamily: "inherit",
                            cursor: "pointer",
                            textDecoration: "none",
                            transition: "background 0.15s ease",
                          }}
                        >
                          <CalendarPlus size={16} />
                          {String(t("confirmation.addToOutlookCalendar"))}
                        </a>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            downloadICalFile(calendarEvent);
                            setCalendarOpen(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            padding: "10px 14px",
                            background: "none",
                            border: "none",
                            color: "var(--background, #F6F0E4)",
                            fontSize: FS_SM,
                            fontFamily: "inherit",
                            cursor: "pointer",
                            textAlign: "left",
                            transition: "background 0.15s ease",
                          }}
                        >
                          <CalendarPlus size={16} />
                          {String(t("confirmation.downloadIcs"))}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button
                  onClick={handleShare}
                  type="button"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 14px",
                    borderRadius: 0,
                    border: BORDER_SUBTLE,
                    background: fgAlpha(4),
                    fontSize: FS_SM,
                    fontWeight: 500,
                    color: copied ? "var(--success, #166534)" : fgAlpha(80),
                    cursor: "pointer",
                    transition: "color 0.2s, background 0.15s",
                  }}
                >
                  {copied ? <Check size={14} /> : <Share2 size={14} />}
                  {copied
                    ? String(t("confirmation.copied"))
                    : String(t("confirmation.shareEvent"))}
                </button>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: DIVIDER_COLOR }} />

            {/* Ticket summary */}
            <div style={{ padding: "20px 24px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 16,
                  fontSize: FS_SM,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: fgAlpha(60),
                }}
              >
                <Ticket size={14} />
                <span>
                  {String(t("confirmation.ticketCount", { count: totalQty }))}
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {selectedTickets.map((tt) => {
                  const seats = selectedSeatLabels?.[tt.id];
                  return (
                    <div key={tt.id}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          justifyContent: "space-between",
                          gap: 12,
                          fontSize: FS_BODY,
                        }}
                      >
                        <span style={{ color: fgAlpha(90) }}>
                          <span style={{ fontWeight: 500, color: fg }}>
                            {tt.qty}&times;
                          </span>{" "}
                          {tt.name}
                        </span>
                        <span
                          style={{
                            flexShrink: 0,
                            fontVariantNumeric: "tabular-nums",
                            color: fgAlpha(90),
                          }}
                        >
                          {formatPrice(lineCentsFor(tt))}
                        </span>
                      </div>
                      {/* Seat labels */}
                      {seats && seats.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 6,
                            marginTop: 8,
                            paddingLeft: 2,
                          }}
                        >
                          {seats.map((seat) => (
                            <span
                              key={seat}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                padding: "3px 10px",
                                borderRadius: 0,
                                background: fgAlpha(5),
                                border: BORDER_SUBTLE,
                                fontSize: FS_CAP,
                                fontWeight: 500,
                                color: fgAlpha(70),
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {seat}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: DIVIDER_COLOR }} />

            {/* Price breakdown */}
            <div
              style={{
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: FS_SM,
                  color: fgAlpha(70),
                }}
              >
                <span>{String(t("checkout.subtotal"))}</span>
                <span
                  data-testid="order-confirmation-subtotal-value"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {/* Pre-discount, as the lines above it (see discountCents). */}
                  {formatPrice(order.amountGrossCents + discountCents)}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: FS_SM,
                  color: fg,
                }}
              >
                <span>{String(t("checkout.platformFee"))}</span>
                {/* What the BUYER paid — the figure the Total adds. In ABSORB the
                    organiser paid it (`buyerFeesCents` is 0): shown dimmed as
                    "Included", as OrderSummary does, so the rows still sum.
                    (It printed `feesPlatformCents`, the organiser's cost.) */}
                {isPassThrough ? (
                  <span
                    data-testid="order-confirmation-platform-fee-value"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatPrice(order.buyerFeesCents)}
                  </span>
                ) : (
                  <span
                    data-testid="order-confirmation-platform-fee-included"
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span style={{ opacity: 0.55 }}>
                      {formatPrice(order.feesPlatformCents)}
                    </span>
                    <span style={{ fontSize: FS_CAP, opacity: 0.55, fontStyle: "italic" }}>
                      {String(t("checkout.included"))}
                    </span>
                  </span>
                )}
              </div>
              {/* Processing fee is part of the Total only for PASS_THROUGH (the
                  buyer funded it). For ABSORB the seller absorbed it, so it's not
                  shown as part of the buyer's breakdown — matches OrderSummary and
                  keeps the row sum equal to the Total. */}
              {isPassThrough && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>{String(t("checkout.processingFee"))}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatPrice(order.processorFeeCents)}
                  </span>
                </div>
              )}
              {/* Always shown — "$0.00" for a zero-tax event, never hidden
                  (owner ruling 2026-10-01). */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: FS_SM,
                  color: fg,
                }}
              >
                <span>{String(t("checkout.taxes"))}</span>
                <span
                  data-testid="order-confirmation-tax-value"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatPrice(order.taxAmountCents)}
                </span>
              </div>
              {discountCents > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>{String(t("checkout.discount"))}</span>
                  <span
                    data-testid="order-confirmation-discount-value"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    −{formatPrice(discountCents)}
                  </span>
                </div>
              )}
              {creditAppliedCents > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>{String(t("checkout.creditApplied"))}</span>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--success, #166534)",
                    }}
                  >
                    −{formatPrice(creditAppliedCents)}
                  </span>
                </div>
              )}
              <div
                style={{
                  borderTop: `1px solid ${DIVIDER_COLOR}`,
                  paddingTop: 12,
                  marginTop: 4,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <span style={{ fontSize: 16, fontWeight: 700, color: fg }}>
                  {String(t("checkout.total"))}
                </span>
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: fg,
                  }}
                >
                  {formatPrice(totalCents)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── What happens next ── */}
      <div
        className="conf-fade-up"
        style={{
          width: "100%",
          borderRadius: 0,
          border: BORDER_SUBTLE,
          background: fgAlpha(2),
          padding: "20px 20px",
          ...fadeUp(3),
        }}
      >
        <p
          style={{
            margin: "0 0 14px",
            fontSize: FS_SM,
            fontWeight: 700,
            color: fg,
          }}
        >
          {String(t("confirmation.whatsNext"))}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {isProcessing ? (
            <>
              {/* No tickets yet: they're emailed once the debit clears. */}
              <WhatsNextRow icon={Mail}>
                {String(
                  buyerEmail
                    ? t("confirmation.processingEmail", { email: buyerEmail })
                    : t("confirmation.processingEmailNoAddress"),
                )}
              </WhatsNextRow>
              <WhatsNextRow icon={Clock}>
                {String(t("confirmation.processingFailNotice"))}
              </WhatsNextRow>
              {waiverAccepted && (
                <WhatsNextRow icon={Check}>
                  {String(t("confirmation.waiverAccepted"))}
                </WhatsNextRow>
              )}
            </>
          ) : (
            <>
              {/* Email notice */}
              {buyerEmail && (
                <WhatsNextRow icon={Mail}>
                  {String(
                    t("confirmation.whatsNextEmail", { email: buyerEmail }),
                  )}
                </WhatsNextRow>
              )}
              {/* Waiver acceptance record */}
              {waiverAccepted && (
                <WhatsNextRow icon={Check}>
                  {String(t("confirmation.waiverAccepted"))}
                </WhatsNextRow>
              )}
              {/* QR / My Tickets */}
              <WhatsNextRow icon={QrCode}>
                {String(t("confirmation.whatsNextTickets"))}
              </WhatsNextRow>
              {/* Entry */}
              <WhatsNextRow icon={Ticket}>
                {String(t("confirmation.whatsNextEntry"))}
              </WhatsNextRow>
              {/* Wallet passes */}
              <WhatsNextRow icon={Wallet}>
                {String(t("confirmation.walletPassesAvailable"))}
              </WhatsNextRow>
            </>
          )}
        </div>
      </div>

      {/* ── Action buttons ── */}
      <div
        className="conf-fade-up"
        style={{
          display: "flex",
          gap: 12,
          width: "100%",
          flexWrap: "wrap",
          ...fadeUp(4),
        }}
      >
        <Button
          variant="primary"
          size="$5"
          flex={1}
          borderRadius="$0"
          tag="a"
          href={`/my-tickets/${orderId}`}
          data-testid="checkout-view-order-btn"
        >
          {/* Processing: no tickets yet, so the order, not "tickets". */}
          {String(
            t(isProcessing ? "confirmation.viewOrder" : "confirmation.viewTickets"),
          )}
          <ArrowRight size={16} aria-hidden />
        </Button>
        <Button
          variant="secondary"
          size="$5"
          flex={1}
          borderRadius="$0"
          tag="a"
          href={`/events/${eventSlug}`}
        >
          {String(t("confirmation.backToEvent"))}
        </Button>
      </div>
    </div>
  );
};
