"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight } from "lucide-react";

import { Button, Text, useTranslations } from "@th/ui";

import { ACCENT_FILL, FOREGROUND, ON_ACCENT_FILL } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// "S6 Convert" — the page's ONE large accent-filled band (v2 grammar).
// Full-bleed orange fill with ink borders, an oversized host pitch on the
// left and the three audiences it is for on the right. Marketing chrome:
// always rendered, signed-in or out.
//
// Contrast notes (do not "fix" these):
// - The band fill is `ACCENT_FILL` (#B93312), NOT `ACCENT` (#E2481D), and its labels are white
//   (`ON_ACCENT_FILL`) — 5.92:1, AA pass. This is the sanctioned rung; #E2481D is the one brand
//   value with NO AA small-text foreground in either polarity (white 4.06:1, ink 4.38:1), so a
//   band this full of 12–15px text cannot sit on it. Never move the fill to `ACCENT` and never
//   flip these labels back to ink (ink on #B93312 is 2.85:1).
//   [History: this band used to be ink-on-#FF5721 (5.61:1), which was AA — but #FF5721 is the
//   pre-v2 Ember orange and was painted here regardless of theme, so the band drifted off-brand
//   the moment Stub shipped. The rung is how you keep BOTH the brand and AA.]
// - The CTA is an ink fill + `$onStructure` label (16.22:1 on Stub), with a WHITE border so it
//   clears 1.4.11 against the band (an ink edge on #B93312 is 2.85:1). Hover/press deepen to
//   $structurePress. NOT $accent — that fill cannot carry a label at all. NOTE: the old note here
//   said hover goes "steel-blue $structure" — true only on swiss/ember; on the shipped Stub theme
//   `structure` IS ink, i.e. identical to the rest fill, which made the hover a no-op.
// ─────────────────────────────────────────────────────────────────────────────

const BODY_FONT = "var(--th-font-body, 'Montserrat', sans-serif)";

/** Below this width the 7fr/5fr split collapses to a single column. */
const TWO_COLUMN_BREAKPOINT = 900;

/**
 * `useIsMobile` breaks at 600px — too late for a two-column band whose left
 * headline clamps up to 56px. Same matchMedia pattern, wider threshold.
 * SSR/first paint renders two-column and corrects on mount (no hydration
 * mismatch; narrow viewports get one squeezed frame, same as useIsMobile).
 */
function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(
      `(max-width: ${TWO_COLUMN_BREAKPOINT - 1}px)`,
    );
    const onChange = () => setIsNarrow(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isNarrow;
}

// ── Copy ─────────────────────────────────────────────────────────────────────
// TODO(i18n): key candidates — home.convertKicker, home.convertHeadline,
// home.convertSupport, home.convertAudienceWeeklyTitle/Detail,
// home.convertAudiencePerformersTitle/Detail, home.convertAudienceVenuesTitle/
// Detail. Hardcoded English for now — missing keys render as the key string
// itself, so t("nonexistent") is not a fallback.
//
// Fees are always on top of the ticket price: the ABSORB fee mode was removed
// (docs/decisions/absorb-removed.md). The organiser is credited the full
// ticket price (owner ruling 2026-10-11); the buyer pays the fees on top, so
// this copy must never claim the poster price is the checkout price.

const AUDIENCES = [
  {
    id: "performers",
    title: "Performers",
    detail:
      "Know the room before you say yes. A place’s page shows who has played there and, once enough performers have reviewed it, what they reported, anonymously.",
  },
  {
    id: "venues",
    title: "Places",
    detail:
      "A free calendar for your own website, whether or not you sell tickets with us. Your track record is built from the shows you host, and nobody can buy one.",
  },
  {
    id: "weekly",
    title: "Weekly nights",
    detail: "List it free. It shows in search and on the map.",
  },
] as const;

// ── Styles ───────────────────────────────────────────────────────────────────

const stepTitleStyle: CSSProperties = {
  fontFamily: BODY_FONT,
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  lineHeight: 1.3,
  color: ON_ACCENT_FILL,
  margin: 0,
};

const stepDetailStyle: CSSProperties = {
  fontFamily: BODY_FONT,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.4,
  color: ON_ACCENT_FILL,
  margin: 0,
};

// ── Component ────────────────────────────────────────────────────────────────

export type HostConvertBandProps = {
  /** Page-global ordinal for the numbered kicker (zero-padded when set). */
  sectionNumber?: number;
  /** Routes to event creation (sign-in overlay first when signed out). */
  onCreateEvent: () => void;
};

export function HostConvertBand({
  sectionNumber,
  onCreateEvent,
}: HostConvertBandProps) {
  const t = useTranslations();
  const isNarrow = useIsNarrow();

  return (
    <section
      aria-labelledby="host-convert-heading"
      style={{
        backgroundColor: ACCENT_FILL,
        border: `2px solid ${FOREGROUND}`,
        borderRadius: 0,
        padding: isNarrow ? "32px 24px" : "48px 40px",
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow ? "1fr" : "7fr 5fr",
          gap: 32,
          alignItems: "start",
        }}
      >
        {/* ── Left: pitch + CTA ─────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Numbered kicker — tabular index + label, white on the #B93312 rung.
              The fill and its foregrounds are migrated AS A UNIT: both now track the theme
              (`ACCENT_FILL` / `ON_ACCENT_FILL`), so they cannot drift apart. The previous note
              here said the opposite — that the fill was raw palette hex, so the foregrounds had
              to be raw too. That was true of the pre-v2 #FF5721 band; it is not true now, and a
              half-migrated pair (themed fill + fixed foreground) is exactly the drift it warned
              against. If you re-theme one of these, re-theme all of them. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            {sectionNumber != null && (
              <Text
                variant="kicker"
                weight="bold"
                color={ON_ACCENT_FILL}
                fontSize={14}
                minWidth={28}
                // The label beside it wraps to two lines at 320px; without
                // these the row shrinks the numeral and "04." breaks before
                // its full stop.
                flexShrink={0}
                whiteSpace="nowrap"
                aria-hidden
              >
                {`${String(sectionNumber).padStart(2, "0")}.`}
              </Text>
            )}
            <Text
              variant="kicker"
              weight="bold"
              color={ON_ACCENT_FILL}
              fontSize={12}
              letterSpacing={2}
            >
              FOR THE PEOPLE WHO MAKE THE NIGHT
            </Text>
          </div>

          <h2
            id="host-convert-heading"
            style={{
              fontFamily: BODY_FONT,
              fontWeight: 900,
              textTransform: "uppercase",
              lineHeight: 1.0,
              letterSpacing: -1,
              fontSize: "clamp(28px, 5vw, 56px)",
              color: ON_ACCENT_FILL,
              margin: 0,
            }}
          >
            Honesty and transparency is the floor.
          </h2>

          <p
            style={{
              fontFamily: BODY_FONT,
              fontSize: 15,
              fontWeight: 500,
              lineHeight: 1.5,
              color: ON_ACCENT_FILL,
              margin: 0,
              maxWidth: 460,
            }}
          >
            Fees go on top of your ticket price, and the buyer sees each one
            before they pay. You&rsquo;re credited the full ticket price.
            Setting up is free.
          </p>

          <div>
            {/* Ink-filled CTA: $onStructure label on ink (~16:1). Hover/press
                deepen to the $structure/$structurePress fills ($onStructure
                stays AA) — never $accent, which cannot carry a label at all.
                $onStructure is exactly "the foreground for a structural fill",
                so it tracks all three.
                The BORDER is `ON_ACCENT_FILL` (white), not the ink fill: an ink
                edge against this #B93312 band is only 2.85:1, under WCAG
                1.4.11's 3:1 for identifying a control. White gives the button a
                5.92:1 edge and reads as a deliberate Swiss outline. (On the old
                #E2481D band the ink edge was 4.17:1, so this only became load-
                bearing when the band moved to the rung.)
                The icon carries an explicit color (deviating from the usual
                "no color= on button icons" rule): the label is pinned via the
                color prop, but the primary variant's own hoverStyle.color
                (ink) survives partial pseudo-style merges and would flip a
                currentColor icon to ink on steel blue — and the frame's
                pseudo-style types reject a color key. */}
            <Button
              size="$4"
              onPress={onCreateEvent}
              backgroundColor={FOREGROUND}
              borderColor={ON_ACCENT_FILL}
              color="$onStructure"
              hoverStyle={{
                // `$structurePress`, NOT `$structure`: on Stub `structure` IS the ink this button
                // already rests on, so hovering did literally nothing. `structurePress` (#000000)
                // deepens, and `$onStructure` stays AA on it.
                backgroundColor: "$structurePress",
                borderColor: ON_ACCENT_FILL,
              }}
              pressStyle={{
                backgroundColor: "$structurePress",
                borderColor: ON_ACCENT_FILL,
                scale: 0.98,
              }}
            >
              {String(t("home.createAnEvent"))}
              <ArrowRight
                size={16}
                color="var(--onStructure, #FDFAF3)"
                aria-hidden
              />
            </Button>
          </div>
        </div>

        {/* ── Right: three audiences ────────────────────────────────────── */}
        <ul
          // listStyle:none strips list semantics in Safari/VoiceOver —
          // restore them explicitly. A <ul>, not an <ol>: these name three
          // audiences, not a sequence, so there is no numbering to announce.
          role="list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {AUDIENCES.map((audience) => (
            <li
              key={audience.id}
              style={{
                display: "flex",
                gap: 12,
                // White, like the labels beside it — these rules sit ON the band, so ink would be
                // 2.85:1 against #B93312 (it was 5.61:1 on the old #FF5721). Decorative separators
                // are exempt from 1.4.11, but a half-strength ink rule next to a white CTA edge
                // just reads broken.
                borderTop: `2px solid ${ON_ACCENT_FILL}`,
                padding: "14px 0",
              }}
            >
              <div
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <p style={stepTitleStyle}>{audience.title}</p>
                <p style={stepDetailStyle}>{audience.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

HostConvertBand.displayName = "HostConvertBand";
