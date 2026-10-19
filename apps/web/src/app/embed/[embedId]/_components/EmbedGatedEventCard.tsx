"use client";

import { formatEventTimeRange } from "@th/locale";
import { useLocale, useTranslations } from "@th/ui";
import { ClipboardList, ExternalLink, Lock } from "lucide-react";

import { BORDER, TEXT, TEXT_MUTED, primaryButtonStyle } from "./embed-theme";
import type { EmbedGateType } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// A gated event in the widget (owner ruling 2026-10-12, "Card + button to
// apply"). The widget can never unlock a password or an application, and the
// server sends it a cut-down preview (title, date, hero, slug) with no tiers,
// so this card shows what it has and ONE way forward: the event on Ithas Fire,
// in a new tab. Nothing here is priced, and nothing fetches fee rates, seats
// or a waiver. All three are refused for a gated event: fee rates and the
// waiver by `ensureFullEventReadAccessByEventId` (FORBIDDEN,
// event_password_required / event_application_required), seats (and
// checkout) with EVENT_GATED.
//
// The gate row reuses the site card's labels and icons (`EventCard`'s
// `eventCard.gateApplication` / `eventCard.gatePassword`, Lock /
// ClipboardList), so the list card and this detail name the gate alike.
// ─────────────────────────────────────────────────────────────────────────────

/** The tracked uppercase mono label idiom, `sm` rung of `monoScale`. */
const gateLabelStyle = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--fs-mono-sm, 11px)",
  letterSpacing: "var(--tr-mono-sm, 2px)",
  fontWeight: 600,
  textTransform: "uppercase",
  color: TEXT_MUTED,
} as const;

export type EmbedGatedEvent = {
  id: string;
  slug: string | null;
  title: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  timezone: string | null;
  heroImageUrl: string | null;
  gateType: Exclude<EmbedGateType, "NONE">;
};

export function EmbedGatedEventCard({
  event,
  buildEventUrl,
  showAction = true,
}: {
  event: EmbedGatedEvent;
  buildEventUrl: (slugOrId: string) => string;
  /** False once sales have closed: the caller shows the closed notice instead. */
  showAction?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const isPassword = event.gateType === "PASSWORD";
  const GateIcon = isPassword ? Lock : ClipboardList;
  const gateLabel = String(
    t(isPassword ? "eventCard.gatePassword" : "eventCard.gateApplication"),
  );
  const ctaLabel = String(
    t(isPassword ? "embed.gatedPasswordCta" : "embed.gatedApplyCta"),
  );
  const body = String(
    t(isPassword ? "embed.gatedPasswordBody" : "embed.gatedApplicationBody"),
  );
  // On the event's own clock, as the site's event page prints it.
  const when = formatEventTimeRange(event.startsAt, event.endsAt, {
    locale,
    timeZone: event.timezone ?? undefined,
  });

  return (
    <div
      data-testid="embed-gated-event"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "16px 16px 20px",
        // A wide iframe would otherwise draw a 16:9 hero the full width and
        // push the one action below the fold. Phone widths are unaffected.
        maxWidth: 640,
        boxSizing: "border-box",
      }}
    >
      {event.heroImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a moderated hero on any host; next/image's loader allowlist does not cover it
        <img
          src={event.heroImageUrl}
          alt=""
          style={{
            display: "block",
            width: "100%",
            aspectRatio: "16 / 9",
            objectFit: "cover",
          }}
        />
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          border: `2px solid ${BORDER}`,
          padding: 16,
        }}
      >
        <span
          data-testid="embed-gated-event-badge"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <GateIcon size={14} color={TEXT_MUTED} aria-hidden />
          <span style={gateLabelStyle}>{gateLabel}</span>
        </span>

        <time
          dateTime={new Date(event.startsAt).toISOString()}
          style={{
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.4,
            color: TEXT,
          }}
        >
          {when}
        </time>

        {showAction && (
          <>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.5,
                color: TEXT_MUTED,
              }}
            >
              {body}
            </p>
            <a
              data-testid="embed-gated-event-cta"
              href={buildEventUrl(event.slug ?? event.id)}
              // A new tab, never the iframe itself (as the calendar's and the
              // list's link-out do with `window.open`). A real link so it
              // keeps the browser's own open-in / copy-link affordances.
              target="_blank"
              rel="noopener noreferrer"
              aria-label={String(t("embed.gatedCtaAria", { label: ctaLabel }))}
              style={{
                ...primaryButtonStyle,
                textDecoration: "none",
                textAlign: "center",
              }}
            >
              {ctaLabel}
              <ExternalLink size={16} aria-hidden style={{ flexShrink: 0 }} />
            </a>
            {/* The link's own label already says it opens a new tab; read once. */}
            <p
              aria-hidden
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.4,
                color: TEXT_MUTED,
              }}
            >
              {String(t("embed.gatedOpensInNewTab"))}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
