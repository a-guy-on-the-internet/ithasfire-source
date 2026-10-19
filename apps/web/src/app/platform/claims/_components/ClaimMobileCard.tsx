"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtDateShort, truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared status/kind maps — used by both the claims table columns and the
// mobile card so badge tones and labels stay identical in table and card modes.
// ─────────────────────────────────────────────────────────────────────────────

export const CLAIM_STATUS_TONE: Record<
  string,
  "warning" | "info" | "success" | "danger" | "neutral"
> = {
  open: "warning",
  under_review: "info",
  approved: "success",
  denied: "danger",
  expired: "neutral",
};

export const CLAIM_STATUS_LABEL_KEY: Record<string, string> = {
  open: "admin.pclStatusOpen",
  under_review: "admin.pclStatusUnderReview",
  approved: "admin.pclStatusApproved",
  denied: "admin.pclStatusDenied",
  expired: "admin.pclStatusExpired",
};

export const CLAIM_KIND_LABEL_KEY: Record<string, string> = {
  ticket_invalid: "admin.pclKindTicketInvalid",
  entry_denied: "admin.pclKindEntryDenied",
  wrong_seat: "admin.pclKindWrongSeat",
  other: "admin.pclKindOther",
};

export function ClaimStatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  const tone = CLAIM_STATUS_TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} size="sm">
      {String(t(CLAIM_STATUS_LABEL_KEY[status] ?? status))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimMobileCardRow {
  id: string;
  kind: string;
  status: string;
  deadline: Date | string;
  createdAt: Date | string;
}

// The kind label wraps to a second line rather than truncating ("Entry den…"
// hid which kind of claim this was). `break-word`, not `anywhere`: `anywhere`
// lowers the title's min-content width, so the flex row squeezed it and split
// "denegado" mid-word at 320px. Hyphens catch a word that truly can't fit.
const WRAP_STYLE = {
  overflowWrap: "break-word",
  hyphens: "auto",
} as const;

/**
 * Card rendering for claims rows on phones (platform desk and the seller's
 * claims page). Composition: claim kind + status badge, then the claim id in
 * mono (matching the table's mono id column), then the claim-window close +
 * created dates. Tones and labels mirror the table columns exactly (same
 * maps, same badge component).
 *
 * `deadline` is when the buyer's FILING window closed, never a reply or
 * decision cut-off (claims don't expire: owner rulings Q8/Q9), so it is
 * labelled as such, and the seller's page leaves it out entirely
 * (`showWindowClosed={false}`). `footer` carries a page-specific line.
 */
export function ClaimMobileCard({
  row,
  showWindowClosed = true,
  footer,
}: {
  row: ClaimMobileCardRow;
  showWindowClosed?: boolean;
  footer?: ReactNode;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="flex-start" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          flex={1}
          minWidth={0}
          style={WRAP_STYLE}
        >
          {String(t(CLAIM_KIND_LABEL_KEY[row.kind] ?? row.kind))}
        </Text>
        <XStack flexShrink={0}>
          <ClaimStatusBadge status={row.status} />
        </XStack>
      </XStack>

      <Text variant="code" fontSize={11} tone="muted">
        {truncateId(row.id)}
      </Text>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        {showWindowClosed && (
          <>
            <Text variant="caption" tone="muted">
              {String(t("resaleClaim.windowClosedColumn"))}{" "}
              {fmtDateShort(fmt, new Date(row.deadline))}
            </Text>
            <Text variant="caption" tone="muted" aria-hidden>
              ·
            </Text>
          </>
        )}
        <Text variant="caption" tone="muted">
          {String(t("admin.pclCreated"))}{" "}
          {fmtDateShort(fmt, new Date(row.createdAt))}
        </Text>
      </XStack>
      {footer}
    </YStack>
  );
}
