"use client";

import { useRouter } from "@bprogress/next/app";
import { Card, XStack, YStack } from "tamagui";

import {
  Badge,
  Button,
  TicketWalletCard,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { fmtCurrency } from "@/lib/format";

import { SkeletonPulse } from "./primitives";

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

const statusKeys: Record<string, string> = {
  SUCCEEDED: "myTickets.confirmed",
  PENDING: "myTickets.pending",
  PROCESSING: "myTickets.paymentProcessing",
  PART_REFUNDED: "myTickets.partialRefund",
  REFUNDED: "myTickets.refunded",
  DISPUTED: "myTickets.disputed",
  CANCELLED: "myTickets.cancelled",
};

const statusTone: Record<
  string,
  "success" | "warning" | "danger" | "neutral" | "info"
> = {
  SUCCEEDED: "success",
  PENDING: "warning",
  // A bank debit still clearing: not paid yet, and it can still fail.
  PROCESSING: "warning",
  PART_REFUNDED: "info",
  REFUNDED: "neutral",
  DISPUTED: "danger",
  CANCELLED: "neutral",
};

export type OrderItem = {
  id: string;
  eventId: string;
  eventSlug: string | null;
  eventName: string;
  eventStartsAt: Date | null;
  eventVenue: string | null;
  amountGrossCents: number;
  /**
   * What the buyer paid, split server-side (`computeBuyerChargeBreakdown`).
   * The card shows `totalCents`: gross alone left out the fees and tax a
   * pass-through buyer paid. NULL on a transferred-in ticket (the viewer did
   * not buy the order), and then the card shows no amount.
   */
  charges: { totalCents: number } | null;
  currency: string;
  status: string;
  occurredAt: Date;
  ticketCount: number;
  tiers: string[];
};

const StatusBadge = ({ status }: { status: string }) => {
  const t = useTranslations();
  const key = statusKeys[status];
  const label = key ? String(t(key)) : status;
  const tone = statusTone[status] ?? ("neutral" as const);
  return (
    <Badge tone={tone} size="sm">
      {label}
    </Badge>
  );
};

export const OrderCardSkeleton = () => (
  <Card
    padding="$4"
    borderRadius={0}
    borderTopWidth={2}
    borderTopColor="$borderColor"
    borderBottomWidth={1}
    borderBottomColor="$borderColor"
  >
    <YStack gap="$3">
      <XStack justifyContent="space-between" alignItems="center">
        <SkeletonPulse height={20} width="60%" />
        <SkeletonPulse height={22} width={72} borderRadius={0} />
      </XStack>
      <XStack gap="$4" flexWrap="wrap">
        <SkeletonPulse height={16} width={120} />
        <SkeletonPulse height={16} width={100} />
        <SkeletonPulse height={16} width={80} />
      </XStack>
      <XStack justifyContent="flex-end">
        <SkeletonPulse height={36} width={120} borderRadius={0} />
      </XStack>
    </YStack>
  </Card>
);

/**
 * A row in the wallet.
 *
 * This is the design system's `TicketWalletCard`: a torn-off `DateBlock`, the
 * event title, one mono meta line, and a single affordance in the third
 * column. The DateBlock is the point — it is the same date object the ticket
 * stub and the browse card carry, so the wallet reads as a stack of tickets
 * rather than a list of links.
 *
 * Three things changed from the card this replaced:
 *
 * - **The title is the link, not the card.** The old card wrapped everything in
 *   a `<Link>` and then nested `<Button>`s inside it, which is invalid markup
 *   and forced every action to `stopPropagation`. The row keeps its full hit
 *   area through a stretched-link overlay instead.
 * - **Past orders are no longer dimmed.** `opacity: 0.7` reads as broken rather
 *   than as spent; the title mutes instead, and the row keeps full contrast.
 * - **The QR glyph is the affordance for a live ticket** — the wallet's only
 *   job is getting to the code fast. Anything not scannable shows its status
 *   badge in that slot instead, never both.
 */
export const OrderCard = ({
  order,
  isPast = false,
}: {
  order: OrderItem;
  isPast?: boolean;
}) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();

  const startsAt = order.eventStartsAt ? new Date(order.eventStartsAt) : null;

  // The DateBlock's three parts, formatted through the app's own formatters so
  // a locale change moves them with everything else.
  const month = startsAt ? fmt.dateTime(startsAt, { month: "short" }) : "—";
  const day = startsAt ? fmt.dateTime(startsAt, { day: "2-digit" }) : "··";
  const weekday = startsAt
    ? fmt.dateTime(startsAt, { weekday: "short" })
    : undefined;

  const timeStr = startsAt
    ? fmt.dateTime(startsAt, { hour: "numeric", minute: "2-digit" })
    : String(t("myTickets.tbd"));

  // A live, scannable ticket gets the QR glyph. Everything else — refunded,
  // cancelled, disputed, or simply over — shows its status instead, because a
  // QR beside a "Refunded" badge invites someone to present a dead ticket.
  const scannable = order.status === "SUCCEEDED" && !isPast;

  // The tier, on the design system's meta line between the time and the count.
  //
  // One order can span tiers, and the slot is one segment of a single mono
  // line, so a mixed order names the first and counts the rest ("GA +1")
  // rather than listing them — the meta separator is already a middot, so
  // "GA · VIP" would read as two separate fields. Undated/typeless orders
  // contribute nothing and the middot closes up.
  const tierLabel =
    order.tiers.length === 0
      ? undefined
      : order.tiers.length === 1
        ? order.tiers[0]
        : `${order.tiers[0]} +${order.tiers.length - 1}`;

  return (
    <TicketWalletCard
      month={month}
      day={day}
      weekday={weekday}
      eventTitle={order.eventName}
      href={`/my-tickets/${order.id}`}
      spent={isPast}
      qrLabel={String(t("myTickets.viewTickets"))}
      badge={scannable ? undefined : <StatusBadge status={order.status} />}
      // Design-system order — venue · time · tier · count — with the order
      // total appended. The DS meta line stops at the count; we carry the
      // amount too because this row is an order, not a single ticket, and the
      // wallet is where people come back to check what they paid.
      meta={[
        order.eventVenue,
        timeStr,
        tierLabel,
        String(t("myTickets.nTickets", { count: order.ticketCount })),
        order.charges
          ? fmtCurrency(fmt, order.charges.totalCents, order.currency)
          : undefined,
      ]}
      actions={
        <>
          {/* Past shows get a quiet "Rate this show" entry point. The
              review-event page handles eligibility (scanned-ticket only,
              30-day window, one-per-event), so we surface it for all past
              orders rather than firing a per-card eligibility query — the
              order list has no per-ticket scanned status to gate on. */}
          {isPast ? (
            <Button
              variant="ghost"
              size="$2"
              color="$accentText"
              onPress={() => router.push(`/review-event/${order.eventId}`)}
              data-testid={`order-card-${order.id}-rate-show`}
            >
              {String(t("myTickets.rateShow"))}
            </Button>
          ) : null}
          {order.eventSlug ? (
            <Button
              variant="secondary"
              size="$2"
              onPress={() => router.push(`/events/${order.eventSlug}`)}
              data-testid={`order-card-${order.id}-view-event`}
            >
              {String(t("myTickets.viewEvent"))}
            </Button>
          ) : null}
        </>
      }
      testId={`order-card-${order.id}`}
    />
  );
};

OrderCard.displayName = "OrderCard";
