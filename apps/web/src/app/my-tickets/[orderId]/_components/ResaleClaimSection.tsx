"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { Card, XStack, YStack } from "tamagui";

import { Badge, Button, Text, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import {
  RESALE_CLAIM_WINDOW_DAYS,
  claimKindLabelKey,
  claimWindowState,
  isClaimableResaleTicket,
  isResaleOrder,
  type ClaimWindowState,
  type ClaimableTicketCandidate,
  isRefundPending,
} from "@/lib/resale-claims";

// Free text keeps its line breaks and never pushes a 320px column wider.
const PRE_WRAP = {
  whiteSpace: "pre-wrap" as const,
  overflowWrap: "anywhere" as const,
};

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type BuyerClaim = RouterOutputs["claims"]["list"]["items"][number];

// ─────────────────────────────────────────────────────────────────────────────
// What the order page shows about resale claims
// ─────────────────────────────────────────────────────────────────────────────

export type ResaleClaimView =
  /** Nothing to show: not a resale purchase, or nothing known yet. */
  | { kind: "none" }
  /** The buyer has filed on this order: show each claim's status. */
  | { kind: "claims"; claims: BuyerClaim[]; canFileMore: boolean }
  /** A held resale ticket and the window is open: offer the form. */
  | { kind: "entry" }
  /** A held resale ticket before the event: say a claim will be possible. */
  | { kind: "notYetOpen" };

/**
 * The hook's answer: the section to show, and whether the claim reads have
 * settled. `settled` is a sibling, not a `kind`, so callers that gate on
 * `view.kind !== "none"` keep working; the order page waits on it before
 * offering a full refund (an approved claim's refund must not flash a
 * second refund offer while the claims load). True at once for an order
 * that cannot carry a claim; fails OPEN on a failed read.
 */
export interface ResaleClaimViewResult {
  view: ResaleClaimView;
  settled: boolean;
}

interface OrderFacts {
  status: string;
  source: string;
  eventStartsAt: Date | string | null;
  resaleClaimWindowClosesAt: string | null;
  items: Array<{ kind: string; resaleListingId: string | null }>;
}

/**
 * Decides the claim section for one order. Called unconditionally by
 * OrderDetail (before its early returns) so it can number the sections below.
 *
 * Reads: `entityPages.getMyProfile` (the viewer's humanId, which `claims.list`
 * takes as `claimantId`; the auth session id is NOT the humanId for OAuth and
 * passkey users) and `claims.list({ claimantId, orderId })` for this order.
 * Both run only for a RESALE order: the only kind that can carry a claim.
 */
export function useResaleClaimView(
  orderId: string,
  order: OrderFacts | undefined,
  tickets: ClaimableTicketCandidate[],
): ResaleClaimViewResult {
  // Only a RESALE order can carry a claim (`create-claim` refuses any other
  // source), and an approved claim leaves the source as it was, so ordinary
  // refunded orders never pay for the two reads below.
  const mayCarryClaim = !!order && isResaleOrder(order);

  const profileQuery = trpc.entityPages.getMyProfile.useQuery(
    {},
    {
      enabled: mayCarryClaim,
      staleTime: 5 * 60_000,
    },
  );
  const humanId = profileQuery.data?.humanId;

  const claimsQuery = trpc.claims.list.useQuery(
    { claimantId: humanId ?? "", orderId, limit: 100 },
    { enabled: mayCarryClaim && !!humanId, staleTime: 30_000 },
  );

  // Settled once the claims read answers. A failed read fails OPEN (the
  // server refuses a duplicate claim or a second refund with its own
  // sentence), and so does a profile with no humanId: the claims read
  // would never run.
  const claimsSettled =
    claimsQuery.isSuccess ||
    claimsQuery.isError ||
    profileQuery.isError ||
    (profileQuery.isSuccess && !humanId);
  const settled = !mayCarryClaim || claimsSettled;

  const view = useMemo<ResaleClaimView>(() => {
    if (!order || !mayCarryClaim) return { kind: "none" };

    const claimable = tickets.filter(isClaimableResaleTicket);
    // Already narrowed to this order by the server (`orderId` input).
    const claims = claimsQuery.data?.items ?? [];
    const claimedItemIds = new Set(claims.map((c) => c.orderItemId));
    const unclaimed = claimable.filter(
      (tk) => tk.orderItemId && !claimedItemIds.has(tk.orderItemId),
    );

    const windowState: ClaimWindowState | null = claimWindowState({
      eventStartsAt: order.eventStartsAt,
      resaleClaimWindowClosesAt: order.resaleClaimWindowClosesAt,
      now: Date.now(),
    });

    if (claims.length > 0) {
      return {
        kind: "claims",
        claims,
        canFileMore: unclaimed.length > 0 && windowState === "open",
      };
    }

    // Wait for the claims read before offering the form, so a filed claim
    // never flashes as "File a claim".
    if (!claimsSettled || unclaimed.length === 0) return { kind: "none" };

    if (windowState === "open") return { kind: "entry" };
    if (windowState === "not_open") return { kind: "notYetOpen" };
    // `closed` (or no readable window): offer nothing.
    return { kind: "none" };
  }, [
    order,
    mayCarryClaim,
    tickets,
    claimsQuery.data,
    claimsSettled,
  ]);

  return { view, settled };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<
  string,
  "warning" | "info" | "success" | "danger" | "neutral"
> = {
  open: "warning",
  under_review: "info",
  approved: "success",
  denied: "danger",
  expired: "neutral",
};

const STATUS_LABEL_KEY: Record<string, string> = {
  open: "resaleClaim.statusOpen",
  under_review: "resaleClaim.statusUnderReview",
  approved: "resaleClaim.statusApproved",
  denied: "resaleClaim.statusDenied",
  expired: "resaleClaim.statusExpired",
};

/** What happens next, per status: nobody is left guessing. */
const NEXT_STEP_KEY: Record<string, string> = {
  open: "resaleClaim.nextOpen",
  under_review: "resaleClaim.nextUnderReview",
  approved: "resaleClaim.nextApproved",
  denied: "resaleClaim.nextDenied",
  expired: "resaleClaim.nextExpired",
};

interface ResaleClaimSectionProps {
  orderId: string;
  view: Exclude<ResaleClaimView, { kind: "none" }>;
  /** The page's decorative index numeral, e.g. `<SectionNum>03.</SectionNum>`. */
  numeral: ReactNode;
}

export function ResaleClaimSection({
  orderId,
  view,
  numeral,
}: ResaleClaimSectionProps) {
  const t = useTranslations();

  const title =
    view.kind === "claims"
      ? String(t("resaleClaim.yourClaimTitle"))
      : String(t("resaleClaim.sectionTitle"));

  return (
    <Card
      padding="$4"
      gap="$3"
      borderRadius={0}
      borderTopWidth={2}
      borderTopColor="$borderColor"
      borderBottomWidth={1}
      borderBottomColor="$borderColor"
      data-testid="order-detail-resale-claim"
    >
      <XStack gap="$2" alignItems="center">
        {numeral}
        <Text
          variant="h4"
          tag="h2"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {title}
        </Text>
      </XStack>

      {view.kind === "claims" ? (
        <YStack gap="$4">
          {view.claims.map((claim) => (
            <BuyerClaimStatus key={claim.id} claim={claim} />
          ))}
          {view.canFileMore && (
            <Link href={`/my-tickets/${orderId}/claim`}>
              <Button tag="span" variant="secondary" size="$4">
                {String(t("resaleClaim.sectionCtaAnother"))}
              </Button>
            </Link>
          )}
        </YStack>
      ) : view.kind === "entry" ? (
        <>
          <Text variant="bodySmall" tone="muted">
            {String(t("resaleClaim.sectionBody"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(
              t("resaleClaim.sectionWindow", {
                days: RESALE_CLAIM_WINDOW_DAYS,
              }),
            )}
          </Text>
          <Link href={`/my-tickets/${orderId}/claim`}>
            <Button
              tag="span"
              variant="secondary"
              size="$4"
              data-testid="order-detail-file-claim"
            >
              {String(t("resaleClaim.sectionCta"))}
            </Button>
          </Link>
        </>
      ) : (
        <Text variant="bodySmall" tone="muted">
          {String(
            t("resaleClaim.sectionNotOpen", {
              days: RESALE_CLAIM_WINDOW_DAYS,
            }),
          )}
        </Text>
      )}
    </Card>
  );
}

function BuyerClaimStatus({ claim }: { claim: BuyerClaim }) {
  const t = useTranslations();
  const fmt = useFormatters();

  const kindKey = claimKindLabelKey(claim.kind);
  const statusKey = STATUS_LABEL_KEY[claim.status];
  // Approval is committed before Stripe runs: say "refunded" only once the
  // refund is confirmed, "being refunded" until then.
  const nextKey =
    claim.status === "approved" && !isRefundPending(claim)
      ? "resaleClaim.nextApprovedRefunded"
      : NEXT_STEP_KEY[claim.status];
  const dateOpts = {
    month: "short",
    day: "numeric",
    year: "numeric",
  } as const;

  return (
    <YStack gap="$3" data-testid={`buyer-claim-${claim.id}`}>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Badge tone={STATUS_TONE[claim.status] ?? "neutral"} size="sm">
          {statusKey ? String(t(statusKey)) : claim.status}
        </Badge>
        <Text variant="bodySmall" weight="bold">
          {kindKey ? String(t(kindKey)) : claim.kind}
        </Text>
        <Text variant="caption" tone="muted">
          {String(
            t("resaleClaim.filedOn", {
              date: fmt.dateTime(new Date(claim.createdAt), dateOpts),
            }),
          )}
        </Text>
      </XStack>

      {nextKey && <Text variant="body">{String(t(nextKey))}</Text>}

      {claim.resolutionNote && (
        <YStack gap="$1">
          <Text variant="overline">{String(t("resaleClaim.supportNote"))}</Text>
          <Text variant="body" style={PRE_WRAP}>
            {claim.resolutionNote}
          </Text>
        </YStack>
      )}

      <YStack gap="$1">
        <Text variant="overline">{String(t("resaleClaim.youWrote"))}</Text>
        <Text
          variant="body"
          tone={claim.evidenceText ? undefined : "muted"}
          style={PRE_WRAP}
        >
          {claim.evidenceText ?? String(t("resaleClaim.noDescription"))}
        </Text>
      </YStack>

      <YStack gap="$1">
        <Text variant="overline">
          {String(t("resaleClaim.buyerSellerReply"))}
        </Text>
        {claim.sellerReplyText ? (
          <>
            <Text variant="body" style={PRE_WRAP}>
              {claim.sellerReplyText}
            </Text>
            {claim.sellerRespondedAt && (
              <Text variant="caption" tone="muted">
                {String(
                  t("resaleClaim.sentOn", {
                    date: fmt.dateTime(
                      new Date(claim.sellerRespondedAt),
                      dateOpts,
                    ),
                  }),
                )}
              </Text>
            )}
          </>
        ) : (
          <Text variant="body" tone="muted">
            {String(
              t(
                claim.status === "open" || claim.status === "under_review"
                  ? "resaleClaim.buyerSellerNoReply"
                  : "resaleClaim.buyerSellerNoReplyDecided",
              ),
            )}
          </Text>
        )}
      </YStack>
    </YStack>
  );
}
