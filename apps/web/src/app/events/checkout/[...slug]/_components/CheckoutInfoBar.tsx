"use client";

import { Timer } from "lucide-react";
import { useTranslations } from "@th/ui";
import {
  FG as fg,
  FG_MUTED as fgMuted,
  fgAlpha,
  FS_BODY,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";
import {
  DANGER_FILL,
  ON_DANGER_FILL,
  STRUCTURAL,
} from "@/lib/design-tokens";

export type CheckoutInfoBarProps = {
  eventName: string;
  dateLabel: string;
  venueName?: string;
  backHref: string;
  countdown?: string | null;
  isExpired?: boolean;
  /**
   * A payment is being submitted or confirmed: the back link must not take
   * the buyer off the page mid-payment. It stays in place (no layout shift)
   * but has no destination and says it is unavailable.
   */
  backLocked?: boolean;
};

export const CheckoutInfoBar = ({
  eventName,
  dateLabel,
  venueName,
  backHref,
  countdown,
  isExpired,
  backLocked = false,
}: CheckoutInfoBarProps) => {
  const t = useTranslations();

  return (
    <div
      style={{
        overflow: "hidden",
        borderRadius: 0,
        // Swiss structural lines: top and bottom rules, not boxed in
        borderTop: `2px solid var(--borderColorSoft, rgba(33,28,22,0.3))`,
        borderBottom: `1px solid var(--borderColorSoft, rgba(33,28,22,0.3))`,
        background: fgAlpha(1.5),
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <div
        className="checkout-info-bar-row"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          padding: "14px 20px",
        }}
      >
        {/* Left: back + event info. The class lets checkout.css force this
            block to a full row at narrow widths so the countdown chip wraps
            below instead of crushing the title to a sliver. */}
        <div
          className="checkout-info-bar-left"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            minWidth: 0,
            flex: "1 1 0%",
          }}
        >
          <a
            data-testid="checkout-back-to-event"
            // No href while locked: nothing to follow, nothing to focus, and
            // assistive tech hears it as unavailable.
            href={backLocked ? undefined : backHref}
            role={backLocked ? "link" : undefined}
            aria-disabled={backLocked || undefined}
            style={{
              display: "inline-flex",
              flexShrink: 0,
              alignItems: "center",
              gap: 6,
              fontSize: FS_SM,
              fontWeight: 700,
              letterSpacing: 1.2,
              textTransform: "uppercase" as const,
              color: STRUCTURAL,
              textDecoration: "none",
              transition: "color 0.15s",
              ...(backLocked
                ? { opacity: 0.45, cursor: "not-allowed" as const }
                : {}),
            }}
          >
            <span>← {String(t("common.backToEvent"))}</span>
          </a>

          <div
            className="checkout-info-bar-divider"
            style={{
              height: 20,
              width: 1,
              background: fgAlpha(15),
            }}
          />

          {/* Event identity — name, date, venue. On the event page the photo
              is the pitch; here the pitch is already made, so this is a line of
              text rather than a hero: it says what is being bought without
              spending the most valuable strip on the screen. The 120px image
              band in the sidebar and the 40px thumbnail that used to sit here
              are both gone, and so is the street address — the buyer chose this
              event on the page that carries it. */}
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: FS_BODY,
                fontWeight: 700,
                color: fg,
              }}
            >
              {eventName}
            </p>
            <p
              style={{
                margin: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: FS_CAP,
                // Meta line → `--color-ink-muted`, the system's route for every
                // caption and meta row. An ink alpha lands in the faint band,
                // which is reserved for disabled and decorative marks.
                color: fgMuted,
              }}
            >
              {dateLabel}
              {venueName && <> &middot; {venueName}</>}
            </p>
          </div>
        </div>

        {/* Right: countdown */}
        {countdown && (
          <div
            style={{
              display: "inline-flex",
              flexShrink: 0,
              alignItems: "center",
              gap: 6,
              borderRadius: 0,
              padding: "4px 12px",
              fontSize: FS_CAP,
              fontWeight: 500,
              ...(isExpired
                ? {
                    // The danger FILL and its foreground, migrated as a unit
                    // (white on #B91C1C, 6.4:1). It was a bare `rgba(69,10,10,.4)`
                    // — a dark maroon at 40% over cream — carrying `--dangerSoft`,
                    // a LIGHT tint, with no fallback at all: on first paint the
                    // browser dropped the declaration and the label inherited ink.
                    background: DANGER_FILL,
                    color: ON_DANGER_FILL,
                  }
                : {
                    background: fgAlpha(6),
                    color: fgMuted,
                  }),
            }}
          >
            <Timer size={12} />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {isExpired ? String(t("common.expired")) : countdown}
            </span>
            {!isExpired && (
              <span style={{ color: fgMuted }}>
                {String(t("common.remaining"))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
