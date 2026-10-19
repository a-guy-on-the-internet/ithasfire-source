"use client";

import { useId } from "react";
import { XStack, YStack, styled } from "tamagui";
import { Badge, Button, NextLinkAnchor, Text, useFormatters, useTranslations } from "@th/ui";
import { FileText } from "lucide-react";

import { trpc } from "@/trpc";
import { DealSummary } from "@/components/deals";
import { fmtCurrency } from "@/lib/format";
import {
  adminAgreementHref,
  standaloneAgreementHref,
} from "@/lib/agreement-routes";
import { describeBookingTerms } from "./booking-terms-strip";

// ─────────────────────────────────────────────────────────────────────────────
// THE TERMS, INSIDE THE CONVERSATION ABOUT THEM.
//
// See `booking-terms-strip.ts` for the bug this closes (a show booked on the
// one night both parties ruled out in writing, because the header was on
// another page). This file is the renderer and the FETCH BOUNDARY; the pure
// module owns every decision it draws.
//
// WHERE IT SITS. Directly above the composer, between the newest message and
// the box you type the next one into. That is deliberate and it is the whole
// point: the thread renders oldest-first, so the bottom of the list is the
// latest word said, and the composer is where the next one gets said. Putting
// the binding header at that junction means "Sep 25 works" is typed with
// "Sep 18" visible one line up. At the TOP of the thread it would be scrolled
// past by the time anyone writes anything, which is the failure it exists to
// prevent.
//
// SUBORDINATE, NOT A SECOND EDITOR. Read-only, always. There is exactly one
// place terms change — `/agreements/{id}` — and the strip's job is to route
// there in one click, not to grow a rival form whose optimistic state could
// disagree with the page that actually writes. The deal's money terms ride
// along in plain words (`DealSummary`, board B07: "what's sent … the deal, in
// plain words"), read-only like the rest; "The deal" itself edits them on
// the agreement page.
//
// LAZY BY MOUNT, NOT BY `enabled`. There is no `enabled` flag here and there
// must not be one: `BookingThread` mounts this component ONLY when the booking
// row carries an `agreementId`, so a request with no agreement never creates
// the hook at all. That is stronger than a disabled query (no cache entry, no
// key, nothing to accidentally re-enable) and it is what makes "renders
// nothing at all, no empty frame" true by construction rather than by branch.
//
// FAILURE IS QUIET BUT NOT SILENT. `meta.silent` keeps a failed read out of
// the global toast rail — a reference strip must never interrupt a
// conversation — but the operator still gets one muted line and a retry, so
// "the terms are missing" never reads as "there are no terms".
//
// NESTED-INTERACTIVE HAZARD. The route-out is a TEXT link, not a `Button`
// inside an anchor: a `styled(Button)` with `tag="span"` still emits
// `role="button" tabindex="0"`, which would nest an interactive element in a
// link and put two tab stops on one rectangle (the trap `OpenAgreementButton`
// documents). The 44px touch target rides the wrapper instead.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kicker + status badge, sharing the header row with the route-out link.
 *
 * `flexBasis: 160` is the whole responsive behaviour of this strip's header,
 * and it is a preference, not a floor. Wrapping is decided against the
 * flex-BASIS, before any shrinking: while the row can seat 160px of title plus
 * the link, they share a line and the link sits right; once it cannot, the link
 * wraps to its own line and the title keeps the full width. `flexBasis: 0`
 * (measured at 320px inside the venue inbox, where the strip gets ~110px)
 * produced the opposite and much worse outcome — the link never wrapped and
 * squeezed "TERMS ON FILE" into a three-line stub beside it. `minWidth: 0`
 * still lets the title shrink under 160 when the container itself is narrower,
 * so nothing overflows.
 *
 * Never `flex: 1`: Tamagui inherits RN's `flexShrink: 0`, so the shorthand
 * would let a long title push the row past its container instead of wrapping.
 */
const HeaderText = styled(XStack, {
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
  flexBasis: 160,
  flexGrow: 1,
  flexShrink: 1,
  minWidth: 0,
});

/** Wrapper carries the 44px touch target; the label stays caption-sized. */
const LinkTarget = styled(XStack, {
  alignItems: "center",
  minHeight: 44,
});

export function BookingTermsStrip({
  agreementId,
  /**
   * Counterparty name, appended to the link's accessible name. The visible
   * label is the same two words on every thread, so a screen reader's links
   * list would otherwise read as N indistinguishable entries — the same reason
   * `OpenAgreementButton` takes one.
   */
  nameSuffix,
  /**
   * Admin slug of the shell the strip is mounted in, when there is one. The
   * venue inbox passes its route slug so "change terms" opens the agreement
   * INSIDE the shell; the act's account-settings thread passes nothing and
   * keeps the standalone `/agreements/{id}` page.
   */
  adminSlug = null,
  testIdBase,
}: {
  agreementId: string;
  nameSuffix?: string | null;
  adminSlug?: string | null;
  testIdBase: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const headingId = useId();

  const query = trpc.bookingAgreements.get.useQuery(
    { agreementId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );

  const testId = `${testIdBase}-terms`;

  if (query.error) {
    return (
      <XStack
        gap="$3"
        alignItems="center"
        flexWrap="wrap"
        minWidth={0}
        data-testid={`${testId}-error`}
      >
        <Text variant="caption" tone="muted" testId={`${testId}-error-text`}>
          {String(t("booking.termsUnavailable"))}
        </Text>
        <Button
          variant="ghost"
          size="$1"
          onPress={() => void query.refetch()}
          disabled={query.isFetching}
          testID={`${testId}-retry`}
        >
          {String(t("booking.threadRetry"))}
        </Button>
      </XStack>
    );
  }

  // No frame while the read is in flight: a skeleton the width of the composer
  // would announce a second panel that may turn out to be one muted line.
  if (!query.data) return null;

  const { agreement, guaranteeFromDeal, mayEdit } = query.data;
  // A guarantee The deal sets is The deal's (the fixed part of the act's
  // clauses), not the act's opening ask, even when the two numbers match.
  const pitchProvenance =
    guaranteeFromDeal && query.data.pitchProvenance
      ? { ...query.data.pitchProvenance, guaranteeCents: false }
      : query.data.pitchProvenance;

  const view = describeBookingTerms({
    status: agreement.status,
    proposedDate: agreement.proposedDate,
    proposedEndDate: agreement.proposedEndDate,
    // Already The deal's figure once a deal exists: every deal save writes it.
    guaranteeCents: agreement.guaranteeCents,
    pitchProvenance,
    mayEdit,
    t: (key, values) => String(t(key, values)),
    formatDateTime: (value) =>
      fmt.dateTime(value, { dateStyle: "medium", timeStyle: "short" }),
    // USD, matching the agreement editor's header card: the agreement carries
    // no currency of its own, and the payout terms' settlement currency is not
    // projected by this read.
    formatMoney: (cents) => fmtCurrency(fmt, cents, "USD"),
  });

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
      minWidth={0}
      role="group"
      aria-labelledby={headingId}
      data-testid={testId}
      data-ended={view.ended ? "true" : "false"}
    >
      <XStack gap="$2" alignItems="center" flexWrap="wrap" minWidth={0}>
        <HeaderText>
          <FileText
            size={13}
            strokeWidth={2}
            aria-hidden
            style={{ opacity: 0.65, flexShrink: 0 }}
          />
          <Text
            id={headingId}
            variant="caption"
            weight="bold"
            tone={view.ended ? "muted" : "default"}
            textTransform="uppercase"
            letterSpacing={0.6}
          >
            {view.heading}
          </Text>
          <Badge tone={view.statusTone} size="sm" data-testid={`${testId}-status`}>
            {view.statusLabel}
          </Badge>
        </HeaderText>
        <NextLinkAnchor
          href={
            adminSlug
              ? adminAgreementHref(adminSlug, agreementId)
              : standaloneAgreementHref(agreementId)
          }
          aria-label={
            nameSuffix ? `${view.linkLabel} — ${nameSuffix}` : view.linkLabel
          }
          data-testid={`${testId}-link`}
        >
          <LinkTarget>
            <Text
              variant="caption"
              weight="bold"
              color="$accentText"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {view.linkLabel}
            </Text>
          </LinkTarget>
        </NextLinkAnchor>
      </XStack>

      {/* GRID, not flex: three labelled values whose labels must line up
          across the row. `auto-fit` collapses to two columns and then one as
          the panel narrows — at 320px the venue inbox leaves ~170px of content
          here, where three columns would be unreadable slivers. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
          gap: 12,
          minWidth: 0,
        }}
      >
        {view.fields.map((field) => (
          <YStack
            key={field.key}
            gap="$1"
            minWidth={0}
            data-testid={`${testId}-${field.key}`}
          >
            <Text
              variant="caption"
              tone="muted"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {field.label}
            </Text>
            <Text
              variant="bodySmall"
              weight="bold"
              tone={view.ended || !field.present ? "muted" : "default"}
              // Dates and money sit in adjacent columns and are read against
              // one another — tabular figures keep them from dancing.
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {field.value}
            </Text>
            {field.fromPitch && !view.ended ? (
              // Neutral chip, not a warning: the value is not WRONG, it is
              // simply nobody's decision yet. The sentence below says what
              // that means; colouring it danger would read as validation.
              <XStack
                alignSelf="flex-start"
                alignItems="center"
                paddingHorizontal={5}
                paddingVertical={1}
                borderWidth={1}
                borderColor="$borderColorSoft"
                backgroundColor="$surface"
                data-testid={`${testId}-${field.key}-pitch`}
              >
                <Text
                  variant="caption"
                  tone="muted"
                  textTransform="uppercase"
                  letterSpacing={0.6}
                >
                  {String(t("admin.baPitchFromRequest"))}
                </Text>
              </XStack>
            ) : null}
          </YStack>
        ))}
      </div>

      <YStack gap="$1" minWidth={0} data-testid={`${testId}-deal`}>
        <DealSummary
          target={{ kind: "BOOKING_AGREEMENT", agreementId }}
          testIdBase={testId}
          label={
            <Text
              variant="caption"
              tone="muted"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {String(t("deals.summary.label"))}
            </Text>
          }
        />
      </YStack>

      {view.anyFromPitch ? (
        // THE POINT OF `pitchProvenance` ON THIS SURFACE. In the editor the
        // chip alone is enough — you are already looking at the control. Here
        // the reader is mid-conversation, so the strip says out loud what a
        // marked value means: nobody picked it, it is still the act's opening
        // ask, and it will be what the event gets built from.
        <Text
          variant="caption"
          tone="muted"
          data-testid={`${testId}-pitch-note`}
        >
          {String(t("booking.termsPitchNote"))}
        </Text>
      ) : null}

      {view.ended ? (
        <Text variant="caption" tone="muted" data-testid={`${testId}-ended-note`}>
          {String(t("booking.termsEndedNote"))}
        </Text>
      ) : null}
    </YStack>
  );
}
