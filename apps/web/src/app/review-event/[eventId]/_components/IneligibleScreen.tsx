"use client";

import Link from "next/link";
import { CalendarClock, CheckCircle2, Clock, Ticket, XCircle } from "lucide-react";
import { Button, Text } from "@th/ui";
import { YStack } from "tamagui";
import { ACCENT } from "@/lib/design-tokens";

import type { AttendeeReviewIneligibilityReason } from "../_lib/reasons";

// ─────────────────────────────────────────────────────────────────────────────
// IneligibleScreen — calm, single-screen explanation per eligibility reason
// (attendee-reviews FR-008: honest, no dead-ends, no dark patterns). Copy is
// i18n'd; each reason gets a plain title + reassuring body.
// ─────────────────────────────────────────────────────────────────────────────

type T = (key: string, values?: Record<string, string | number>) => unknown;

const ICONS: Record<
  AttendeeReviewIneligibilityReason,
  typeof Clock
> = {
  event_not_found: XCircle,
  event_cancelled: XCircle,
  event_not_ended: CalendarClock,
  window_closed: Clock,
  no_scanned_ticket: Ticket,
  already_reviewed: CheckCircle2,
};

// Reasons we have bespoke copy for. If core adds a new reason, the union grows
// and `ICONS` above becomes a compile error forcing a dev here — but a dev who
// adds the icon and forgets the copy would otherwise ship a raw i18n key. This
// set degrades any un-copied reason to the calm generic error copy instead.
const COPIED_REASONS = new Set<string>(Object.keys(ICONS));

interface IneligibleScreenProps {
  reason: AttendeeReviewIneligibilityReason | null;
  t: T;
}

export function IneligibleScreen({ reason, t }: IneligibleScreenProps) {
  const Icon = (reason && ICONS[reason]) ?? XCircle;
  const isPositive = reason === "already_reviewed";
  const hasCopy = reason != null && COPIED_REASONS.has(reason);
  const title = hasCopy
    ? String(t(`attendeeReview.ineligible.${reason}.title`))
    : String(t("attendeeReview.error.title"));
  const body = hasCopy
    ? String(t(`attendeeReview.ineligible.${reason}.body`))
    : String(t("attendeeReview.error.body"));

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding={40}
      gap={20}
      minHeight={320}
      role="status"
      aria-live="polite"
      data-testid={`attendee-ineligible-${reason ?? "unknown"}`}
    >
      {/* Muted case draws from the theme CSS vars (Tamagui exposes each token
          as `--<name>`), and the Lucide icon inherits stroke via currentColor,
          so it stays legible in light AND dark — the old hardcoded white alpha
          was invisible on a light background. */}
      <div
        style={{
          width: 56,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `3px solid ${isPositive ? ACCENT : "var(--borderColor)"}`,
          color: isPositive ? ACCENT : "var(--colorMuted)",
        }}
        aria-hidden="true"
      >
        <Icon size={28} />
      </div>

      <Text variant="h3" weight="bold" color="$color" margin={0} textAlign="center">
        {title}
      </Text>
      <Text
        variant="body"
        color="$colorMuted"
        margin={0}
        textAlign="center"
        maxWidth={380}
      >
        {body}
      </Text>

      <Link href="/my-tickets" passHref legacyBehavior>
        <Button variant="secondary" size="$3" asChild>
          <a style={{ textDecoration: "none" }}>
            {String(t("attendeeReview.ineligible.backToTickets"))}
          </a>
        </Button>
      </Link>
    </YStack>
  );
}
