"use client";

/**
 * The one place a ticket pack's DRAFT/LIVE state is drawn. Mirrors the
 * volunteer-packs PackStatusPill exactly (text + colour + form, so status
 * survives monochrome and colour-blind readers); see that file's rationale.
 */

import { Badge, useTranslations } from "@th/ui";

export type TicketPackStatus = "DRAFT" | "LIVE";

export function TicketPackStatusPill({
  status,
  size = "sm",
  testId,
}: {
  status: TicketPackStatus;
  size?: "xs" | "sm" | "md";
  testId?: string;
}) {
  const t = useTranslations();
  const isLive = status === "LIVE";
  return (
    <Badge
      tone={isLive ? "success" : "warning"}
      variant={isLive ? "solid" : "outline"}
      size={size}
      dot
      {...(testId ? { "data-testid": testId } : {})}
    >
      {String(
        t(
          isLive
            ? "admin.ticketPackStatusLive"
            : "admin.ticketPackStatusDraft",
        ),
      )}
    </Badge>
  );
}
