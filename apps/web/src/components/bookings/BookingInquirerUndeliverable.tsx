"use client";

import { XStack, YStack } from "tamagui";
import { Text, useFormatters, useTranslations } from "@th/ui";
import { MailWarning, MailX } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// "We emailed your reply and it did not arrive" — the venue-facing surface for
// `BookingRequest.inquirerEmailUndeliverable{At,Status}`
// (booking-inquirer-outreach, 2026-09-05).
//
// WHY IT EXISTS. When a venue replies in a thread on an ANONYMOUS embed
// inquiry, the reply leaves the platform as an email to the submitted
// `contactEmail`. If that mail hard-bounces or draws a spam complaint, the
// venue's thread looks exactly like a thread nobody has answered yet: they
// believe they replied, the inquirer never saw a word, and neither side has
// any way to find out. The backend stamps the row; this is the only place a
// human ever learns about it.
//
// THE TWO CAUSES ARE NOT ONE "delivery failed". They imply different next
// moves and the copy keeps them apart:
//   - BOUNCED    — the address is wrong or the mailbox is gone. Nothing will
//                  ever reach it; the fix is a different address.
//   - COMPLAINED — it DID arrive and was marked as junk, so we stop mailing
//                  it. The venue's own mail client is a different sender and
//                  may still land.
//
// The `mailto:` affordance (embed spec 2026-07-13 FR-006) stays exactly where
// it was and is NOT buried by this: once our sending stops working it is the
// venue's remaining option, so the detail notice sits immediately above it and
// points at it.
// ─────────────────────────────────────────────────────────────────────────────

/** The hard-failure signals the Resend webhook stamps. */
export type InquirerEmailFailure = "BOUNCED" | "COMPLAINED";

export interface BookingInquirerUndeliverableProps {
  status: InquirerEmailFailure;
  /** When the provider reported it. */
  at: Date;
  /** The submitted contact name — whose inbox we could not reach. */
  contactName: string;
  testIdBase: string;
}

/** Per-cause copy keys, so no branch can pick up half the other's wording. */
const COPY = {
  BOUNCED: {
    badge: "admin.bkWsVenUndelivBouncedBadge",
    badgeAria: "admin.bkWsVenUndelivBouncedAria",
    title: "admin.bkWsVenUndelivBouncedTitle",
    body: "admin.bkWsVenUndelivBouncedBody",
    next: "admin.bkWsVenUndelivBouncedNext",
  },
  COMPLAINED: {
    badge: "admin.bkWsVenUndelivSpamBadge",
    badgeAria: "admin.bkWsVenUndelivSpamAria",
    title: "admin.bkWsVenUndelivSpamTitle",
    body: "admin.bkWsVenUndelivSpamBody",
    next: "admin.bkWsVenUndelivSpamNext",
  },
} as const;

/**
 * Per-cause colour, in ONE place so the chip, the notice border and the icon
 * can never drift onto different hues for the same fact.
 *
 * These are the `*Soft` tokens ON PURPOSE. `$danger` / `$warning` are the FILL
 * values; `colors.ts` documents `dangerSoft` / `warningSoft` as the "status
 * TEXT variants — the bright fills above fail WCAG AA as small text". On Stub
 * the pairs coincide (#B91C1C / #92400E, 5.7:1 / 6.3:1 on cream) so this is a
 * no-op on the shipped theme — but on swiss `$warning` is #FACC15, roughly
 * 1.4:1 as text on white. Reaching for the fill here would be invisible today
 * and unreadable the moment this renders on another theme.
 *
 * Note `<Text tone="warning">` maps to the FILL token (`Text.tsx` toneMap), so
 * these are passed as `color=` rather than through `tone`. Both keys are in the
 * injector's Status list, so `var(--dangerSoft)` / `var(--warningSoft)` resolve
 * on `<body>`; the fallbacks are the STUB values, because the fallback is what
 * SSR/first paint renders.
 */
const HUE = {
  BOUNCED: {
    token: "$dangerSoft",
    css: "var(--dangerSoft, #B91C1C)",
    Icon: MailX,
  },
  COMPLAINED: {
    token: "$warningSoft",
    css: "var(--warningSoft, #92400E)",
    Icon: MailWarning,
  },
} as const;

/**
 * The LIST-ROW signal, stacked in the same slot as the unread chip and the
 * hold line: a different KIND of fact from the stage, and the one a venue
 * would otherwise have to open every inquiry to discover.
 *
 * NOT the shared `Badge`. Its status tones (`danger` / `warning`) resolve to
 * FIXED hexes off the light-role palette — `getBadgeVariantTokens` never
 * reads the theme — so on Stub's cream canvas the soft variant renders
 * #EF4444 and #B8860B labels at roughly 3.3:1 and 3.4:1: both below AA, and
 * verified by rendering it. This mirrors the hold-countdown chip in
 * `BookingHoldSummary` instead — same row, same slot, same visual family —
 * whose `$warning` border + label ARE theme tokens and do clear AA.
 *
 * ACCESSIBILITY: `role="img"` + `aria-label` makes the icon+label one atomic
 * announcement, and the label is a sentence — "Reply bounced" alone does not
 * say whose. The meaning is never carried by colour: the word "bounced" /
 * "spam" is in the visible label AND in the accessible name.
 */
export function BookingInquirerUndeliverableBadge({
  status,
  contactName,
  testIdBase,
}: Omit<BookingInquirerUndeliverableProps, "at">) {
  const t = useTranslations();
  const copy = COPY[status];
  const hue = HUE[status];
  const Icon = hue.Icon;
  return (
    <XStack
      gap={4}
      alignItems="center"
      alignSelf="flex-start"
      paddingHorizontal={6}
      paddingVertical={2}
      minHeight={20}
      flexShrink={0}
      borderWidth={1}
      borderColor={hue.token}
      role="img"
      aria-label={String(t(copy.badgeAria, { name: contactName }))}
      data-testid={`${testIdBase}-undeliverable`}
    >
      <Icon size={11} strokeWidth={2} aria-hidden color={hue.css} />
      <Text variant="overline" weight="bold" color={hue.token}>
        {String(t(copy.badge))}
      </Text>
    </XStack>
  );
}

/**
 * The EXPANDED-DETAIL explanation. Sits directly above the contact-email
 * block so the reading order is "this did not arrive" → "here is the address
 * to try yourself", which is the whole workflow.
 *
 * Strict Swiss: square, a 2px decisive border in the intent hue, no shadow, no
 * tinted fill of its own beyond the panel's surface. Two-line structure —
 * WHAT happened, then WHAT TO DO — because a status with no next step just
 * moves the dead end.
 */
export function BookingInquirerUndeliverableNotice({
  status,
  at,
  contactEmail,
  contactName,
  testIdBase,
}: BookingInquirerUndeliverableProps & { contactEmail: string }) {
  const t = useTranslations();
  const fmt = useFormatters();
  const copy = COPY[status];
  const hue = HUE[status];
  const Icon = hue.Icon;
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={2}
      borderColor={hue.token}
      backgroundColor="$surface"
      minWidth={0}
      data-testid={`${testIdBase}-undeliverable-notice`}
    >
      {/* TOP-aligned, not centred: at 320px the spam title wraps to two lines
          and a vertically-centred icon floats between them, reading as an
          orphan. Same `marginTop` nudge the links list above uses to sit an
          icon on a wrapping label's first line. */}
      <XStack gap="$2" alignItems="flex-start" minWidth={0}>
        <Icon
          size={14}
          aria-hidden
          color={hue.css}
          style={{ flexShrink: 0, marginTop: 1 }}
        />
        <Text
          variant="overline"
          color={hue.token}
          minWidth={0}
        >
          {String(t(copy.title))}
        </Text>
      </XStack>
      <Text variant="bodySmall" style={{ overflowWrap: "anywhere" }}>
        {String(t(copy.body, { name: contactName, email: contactEmail }))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {String(t(copy.next))}
      </Text>
      <Text variant="caption" tone="muted">
        {String(
          t("admin.bkWsVenUndelivWhen", {
            date: fmt.dateTime(at, { dateStyle: "medium" }),
          }),
        )}
      </Text>
    </YStack>
  );
}
