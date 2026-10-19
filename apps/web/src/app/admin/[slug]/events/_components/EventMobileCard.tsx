"use client";

import { XStack, YStack } from "tamagui";
import { Text, useFormatters, useTranslations } from "@th/ui";
import { Users } from "lucide-react";

import { fmtDate } from "@/lib/format";
import { EventStatusBadge } from "./EventStatusBadge";

export interface EventMobileCardRow {
  title: string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | "CANCELLED" | "COMPLETED";
  startsAt: Date | null;
  ticketsSold: number;
  placeName: string | null;
  addressText: string | null;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * `@th/ui` Text has no multi-line `numberOfLines` (only single-line
 * `truncate`), so the title clamps to two lines via the CSS line-clamp box.
 * `overflowWrap: anywhere` breaks one unbroken word inside the clamp instead
 * of letting it overflow the card.
 */
const TITLE_CLAMP_STYLE = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  overflowWrap: "anywhere",
} as const;

/**
 * Card rendering for the events admin table on phones (DataTable card mode,
 * <600px). Composition: status badge, then title, then date + attendee count,
 * then venue. Reuses the table's `EventStatusBadge` and date formatter so
 * card and table stay visually in lock-step.
 *
 * The badge sits on its own line ABOVE the title so the title gets the card's
 * full width, and the title wraps to two lines before it ellipsizes. Inline
 * beside the badge, a 320px card cut "Minneapolis…" to "Minneap…".
 */
export function EventMobileCard({ row }: { row: EventMobileCardRow }) {
  const t = useTranslations();
  const fmt = useFormatters();
  const place = row.placeName ?? row.addressText;

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack>
        <EventStatusBadge status={row.status} />
      </XStack>

      <Text
        variant="bodySmall"
        weight={row.title ? "bold" : "medium"}
        tone={row.title ? undefined : "muted"}
        minWidth={0}
        style={{
          ...TITLE_CLAMP_STYLE,
          fontStyle: row.title ? "normal" : "italic",
        }}
      >
        {row.title || String(t("admin.untitledEvent"))}
      </Text>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {fmtDate(fmt, row.startsAt)}
        </Text>
        {row.ticketsSold > 0 ? (
          <>
            <Text variant="caption" tone="muted" aria-hidden>
              ·
            </Text>
            <XStack gap="$1" alignItems="center" flexShrink={0}>
              <Users size={12} style={{ opacity: 0.5 }} />
              <Text variant="caption" tone="muted">
                {row.ticketsSold.toLocaleString()}
              </Text>
            </XStack>
          </>
        ) : null}
      </XStack>

      {place ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {place}
        </Text>
      ) : null}
    </YStack>
  );
}
