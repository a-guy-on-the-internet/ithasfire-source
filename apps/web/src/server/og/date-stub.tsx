import { DateTime } from "luxon";

import { stubTheme } from "@th/ui/colors";

/**
 * The Date Stub — the Open Graph fallback for an event with no hero image.
 *
 * ── THE SPEC THIS FOLLOWS IS THE ARTIFACT, NOT THE `DateBlock` MOLECULE ──────
 * An earlier cut of this file was built from
 * `packages/ui/src/ui/tamagui/components/events/DateBlock.tsx`: a PAPER ground
 * with the month set in accent type on top, ordered MONTH / DAY / WEEKDAY. The
 * approved design is "Direction C · Date Stub", which is a DIFFERENT
 * composition, and where the two disagree the artifact wins:
 *
 *   - the date column is a FILLED accent field with white type, not a white
 *     column with accent type;
 *   - the labels read DOW / DD / MO, not MO / DD / DOW;
 *   - the perforation is a dashed rule in the PANEL colour sitting ON the
 *     accent field, not a grey rule on white;
 *   - there is no "EVENT" kicker and no brand wordmark, and no caption row
 *     either: the caption belongs to the artifact's HERO specimen and reads
 *     `CATEGORY · VENUE`, and no public category exists here — see
 *     `eventStubCaption` in `@th/types` for why the half-idiom was rejected
 *     and where it will switch on. The body is the artifact's CARD html
 *     exactly: title over place line.
 *
 * The departure is deliberate. `DateBlock` is a paper DATE CALLOUT that sits
 * inside a card the reader is already looking at; this is a whole 1200x630
 * artifact that has to survive being composited onto chrome we do not control
 * (dark Slack, light iMessage, either Twitter). A filled ticket stub carries
 * its own figure/ground and reads as the physical object the idiom is named
 * for; a paper callout scaled to a link preview reads as an empty page.
 *
 * ── WHY THIS IS A HAND-PORT, NOT A REUSE ────────────────────────────────────
 * Neither the molecule nor any other `@th/ui` primitive is reusable here: they
 * are `styled(YStack)` plus `<Text variant tone>`, so every visual decision
 * resolves through the Tamagui theme/token runtime and lands as React Native
 * styles. Satori accepts neither — it renders a plain React element tree with a
 * small literal CSS subset. So the composition is rebuilt below with flex
 * `div`s and literal numbers, reading its COLOURS from the real token file.
 *
 * ── WHY STUB / PAPER POLARITY, ALWAYS ───────────────────────────────────────
 * An OG image has no viewer theme, so the polarity is chosen once, here, and
 * deterministically. It reads `stubTheme` — the app's DEFAULT theme — so the
 * share card and the page a click later are the same object: an ink column on
 * warm paper, not a steel-blue one on white.
 *
 * This previously read the `swiss` palette, on the reasoning that it is what the
 * artifact was drawn in. Overruled 2026-09-12: the in-app rendering is the
 * reference, and someone who sees an unfurl and then opens the event page must
 * not meet two different objects. Note `structure` here is NOT Stub's orange
 * `accent` — it is ink #211C16 — so this stays a paper-and-ink card.
 */

// ── Tokens (read from the real token file; never hardcode hex) ───────────────
const INK = stubTheme.color; // #211C16 — ink
const PANEL = stubTheme.surface; // #FDFAF3 — warm paper
const MUTED = stubTheme.muted; // #5C544A
/**
 * The stub column's fill and its foreground.
 *
 * `structure` / `onStructure` rather than `accent` / `background`: the token
 * file names this exact pairing and documents it as WCAG AA — paper #FDFAF3 on ink
 * #211C16 is 16.2:1 — which is the whole reason a filled column with white type is
 * legal here at all. `accent` as TYPE would not be (see §9 of
 * `docs/design/design-system-v2.md`); as a large FILL with its own declared
 * foreground, it is.
 */
const STUB_FILL = stubTheme.structure; // #211C16 — ink, NOT Stub's orange accent
const ON_STUB = stubTheme.onStructure; // #FDFAF3

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Font family names registered with `ImageResponse`. */
export const OG_SANS = "Montserrat";
export const OG_MONO = "IBM Plex Mono";

/** The artifact's `.stub{width:34%}`, in device pixels. Not negotiable. */
const STUB_WIDTH = Math.round(OG_WIDTH * 0.34); // 408
const BODY_WIDTH = OG_WIDTH - STUB_WIDTH; // 792

/**
 * The artifact's `border-right:2px dashed var(--panel)`, scaled.
 *
 * 2px is measured on a 320px-wide specimen. Link unfurls are typically
 * DISPLAYED around 500-600px wide, so a 6px rule on this 1200px canvas lands at
 * ~2.5-3 CSS px where a reader actually sees it — the artifact's weight at the
 * artifact's apparent size. A literal 2px here would be a hairline that
 * disappears into JPEG-ish re-encoding on half the surfaces that show it.
 */
const PERFORATION_WIDTH = 6;

/**
 * ── THE TYPE RAMP, SCALED (not copied) ──────────────────────────────────────
 *
 * The artifact's hero specimen is 16:6 (320x120) and reads
 * `dd:66 / dow,mo:12 / t:26 / v:13`. This frame is 1200x630 — roughly 16:8.4,
 * far taller — so the hero numbers are ported by RATIO, not by value, and every
 * ratio the spec establishes is preserved to within a rounding step:
 *
 *   dd : t   66/26 = 2.54   →  244/96 = 2.54   (numeral dominant)
 *   dd : dow 66/12 = 5.50   →  244/43 = 5.67   (labels as small tracked caps)
 *   t  : v   26/13 = 2.00   →  96/40  = 2.40   (venue smallest, DEVIATED)
 *
 * The absolute anchor is the TITLE, and it is set by MEASURE rather than by the
 * frame's height, because measure is the dimension the two frames share. The
 * artifact's body is 189px wide inner at a 26px title — 7.3 ems per line. This
 * body is 696px inner, so 7.25 ems per line is 96px. That is also what fixes
 * the problem the taller frame creates: a first pass at 80px left roughly 300px
 * of the body empty under a two-line title, because `space-between` has far
 * more slack to distribute at 16:8.4 than at the artifact's 16:6. At 96 the
 * body is full, three clamped lines occupy 331px of its 526px inner height, and
 * the place line still cannot be pushed off the canvas.
 *
 * Tracking travels with size, per the design system's mono ladder: the spec's
 * `.18em` / `.16em` become 7.7 / 6.9 at 43px.
 *
 * ── THE ONE RATIO THAT IS DELIBERATELY NOT PRESERVED: `.v` ──────────────────
 * The spec's 2.0 puts the place line at 48px, which is 14.5 ems of measure —
 * the same as the artifact's. That works for the artifact's own specimen
 * ("Carol Ann's · Nashville, TN") and for almost nothing else in this corpus.
 * MEASURED at 48px against the composed `Venue · City, ST` line: "Carol Ann's"
 * fits at 1075px of the 1152px limit, but "The Basement East", "Drkmttr
 * Collective" and "The Blue Room at Third Man Records" all run past the edge
 * and lose the city — on the one artifact whose whole job is what, when and
 * WHERE. At 40px the first two fit whole (1136 and 1118) and only genuinely
 * long names truncate. Information beats a ratio; the hierarchy the ratio
 * encodes (the place line is the smallest thing on the card, clearly
 * subordinate to the title) is preserved, and strengthened.
 *
 * ── WEIGHT 800 IS NOT REGISTERED; HERE IS THE MAPPING ───────────────────────
 * Only Montserrat 900/700/500 and IBM Plex Mono 600 are registered with
 * `ImageResponse` (`OG_FONT_SPECS`), and an unregistered weight does not fail —
 * Satori silently picks a neighbour, which looks wrong rather than broken.
 *
 *   `.dd`  900  → 900 (registered; unchanged)
 *   `.t`   800  → 700, NOT 900. The artifact sets the numeral heavier (900)
 *                 than the title (800); mapping the title up to 900 would
 *                 collapse that distinction and make the card two competing
 *                 blacks. 700 is the only registered cut that keeps the
 *                 numeral the heaviest thing on the artifact.
 *   `.dow` 800  → IBM Plex Mono 600, its only registered cut. These are the
 *   `.mo`  800     design system's label idiom (tracked uppercase micro-labels
 *                 ride the mono), and the artifact's 800 is signalling "heavy
 *                 label", which at 43px tracked caps the mono already is.
 *   `.v`   600  → 500, NOT 700. 600 sits exactly between two registered cuts;
 *                 rounding DOWN keeps the place line quieter than the title,
 *                 which is what `color:var(--muted)` is also saying.
 */
const DAY_SIZE = 244;
const LABEL_SIZE = 43;
const TITLE_SIZE = 96;
const VENUE_SIZE = 40;

/** `.dow{letter-spacing:.18em}` / `.mo{letter-spacing:.16em}`, at 43px. */
const DOW_TRACKING = 7.7;
const MO_TRACKING = 6.9;
/** `.t{letter-spacing:-.015em}` at 96px. */
const TITLE_TRACKING = -1.4;

/**
 * The artifact's `.body{padding:10px 11px}` is 8.3% of its height and 5.2% of
 * its body width; on this frame that is 52 / 41. The horizontal figure is
 * rounded up to 48 because a link preview is routinely cropped a few percent by
 * the surface showing it, and the vertical is kept literal.
 */
const BODY_PAD_Y = 52;
const BODY_PAD_X = 48;

export type DateStubParts = {
  month: string;
  day: string;
  weekday: string;
};

/**
 * Month / day / weekday in the VENUE's local zone.
 *
 * Mirrors `formatVenueLocalDate` in `packages/types/src/seo/buildEventJsonLd.ts`:
 * an absent or invalid zone falls back to UTC rather than to the machine's
 * local zone, so the artifact a server renders does not depend on where that
 * server happens to be. `fromJSDate` (never `fromObject`/`fromISO`) because the
 * latter two resolve ambiguous DST fall-back times against `Settings.now()`.
 *
 * Returns null for missing or unparseable dates — the caller drops the numeral
 * rather than rendering "Invalid DateTime".
 */
export const formatStubDateParts = (
  startsAt: Date | string | null | undefined,
  timezone?: string | null,
): DateStubParts | null => {
  if (startsAt === null || startsAt === undefined) return null;
  const date = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(date.getTime())) return null;

  let zoned = DateTime.fromJSDate(date, { zone: timezone ?? "utc" });
  if (!zoned.isValid) {
    // Bogus IANA string — fall back to UTC, same as the JSON-LD builder.
    zoned = DateTime.fromJSDate(date, { zone: "utc" });
  }
  if (!zoned.isValid) return null;

  return {
    month: zoned.toFormat("LLL").toUpperCase(),
    day: zoned.toFormat("d"),
    weekday: zoned.toFormat("ccc").toUpperCase(),
  };
};

export type DateStubProps = {
  title: string;
  startsAt: Date | string | null | undefined;
  timezone?: string | null;
  /**
   * The artifact's `.v` line — `Venue · City, ST`, degrading to `City, ST` (the
   * normal case: `location.name` is disclosure-gated server-side) and then to
   * nothing. Built by `eventStubVenueLine` in `@th/types`; same drift argument.
   */
  venueLine?: string | null;
};

/**
 * Builds the Satori element tree.
 *
 * Satori's CSS subset is narrow and its failures are silent, so the rules it
 * enforces are applied literally throughout:
 *   - every element with more than one child carries an explicit
 *     `display: "flex"`;
 *   - `flexDirection` is set explicitly everywhere (Satori defaults to `row`,
 *     unlike React Native's `column`);
 *   - no CSS variables, no grid;
 *   - truncation uses `display: "block"` + `overflow: "hidden"` +
 *     `textOverflow: "ellipsis"` on single-line text, and `lineClamp` on the
 *     multi-line title.
 */
export const buildDateStubElement = ({
  title,
  startsAt,
  timezone,
  venueLine,
}: DateStubProps) => {
  const parts = formatStubDateParts(startsAt, timezone);
  const safeTitle = (title ?? "").trim();
  const safeVenueLine = (venueLine ?? "").trim();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        width: OG_WIDTH,
        height: OG_HEIGHT,
        backgroundColor: PANEL,
        fontFamily: OG_SANS,
      }}
    >
      {/* ── The torn-off date column: a FILLED accent field ──────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: STUB_WIDTH,
          height: OG_HEIGHT,
          backgroundColor: STUB_FILL,
          color: ON_STUB,
          // The perforation: white dashes ON the accent field. The gaps show
          // the column's own fill, which is what makes it read as a tear rather
          // than as a border between two panels.
          borderRightWidth: PERFORATION_WIDTH,
          borderRightStyle: "dashed",
          borderRightColor: PANEL,
        }}
      >
        {parts ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {/* `.dow` — first, per the artifact. */}
            <div
              style={{
                display: "flex",
                fontFamily: OG_MONO,
                fontSize: LABEL_SIZE,
                fontWeight: 600,
                letterSpacing: DOW_TRACKING,
                lineHeight: 1.3,
                color: ON_STUB,
                // `.dow{opacity:.85}` — still 5.7:1 composited on the fill, and
                // large tracked caps at that. It is what keeps the weekday
                // subordinate to the numeral without a second colour.
                opacity: 0.85,
                // Tracking adds a trailing gap on the last glyph, which shifts
                // centred text left; nudge the optical centre back.
                paddingLeft: DOW_TRACKING,
              }}
            >
              {parts.weekday}
            </div>
            {/* `.dd` — sans 900, line-height .9, tabular figures. */}
            <div
              style={{
                display: "flex",
                fontFamily: OG_SANS,
                fontSize: DAY_SIZE,
                fontWeight: 900,
                // The spec sets no tracking on the numeral; a touch of optical
                // tightening (-0.02em) is applied because two digits at 204px
                // read loose at Montserrat 900's default fit.
                letterSpacing: -5,
                lineHeight: 0.9,
                fontVariantNumeric: "tabular-nums",
                color: ON_STUB,
                marginTop: 10,
                // Letter-spacing applies AFTER the last glyph too, so a
                // centred run sits left of true centre by exactly that much.
                // Measured on "20": 40px of column to the left, 53px to the
                // right. Same compensation the labels carry.
                paddingLeft: 5,
              }}
            >
              {parts.day}
            </div>
            {/* `.mo` — last, per the artifact. */}
            <div
              style={{
                display: "flex",
                fontFamily: OG_MONO,
                fontSize: LABEL_SIZE,
                fontWeight: 600,
                letterSpacing: MO_TRACKING,
                lineHeight: 1.3,
                color: ON_STUB,
                marginTop: 16,
                paddingLeft: MO_TRACKING,
              }}
            >
              {parts.month}
            </div>
          </div>
        ) : (
          // No usable date: the column still frames, it just says so.
          <div
            style={{
              display: "flex",
              fontFamily: OG_MONO,
              fontSize: LABEL_SIZE,
              fontWeight: 600,
              letterSpacing: DOW_TRACKING,
              color: ON_STUB,
              paddingLeft: DOW_TRACKING,
            }}
          >
            TBA
          </div>
        )}
      </div>

      {/* ── The body ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: BODY_WIDTH,
          height: OG_HEIGHT,
          paddingTop: BODY_PAD_Y,
          paddingBottom: BODY_PAD_Y,
          paddingLeft: BODY_PAD_X,
          paddingRight: BODY_PAD_X,
        }}
      >
        {/*
         * ── WHY THE TITLE IS CENTRED AND NOT TOP-ANCHORED ─────────────────
         * The artifact's `.body` is `justify-content: space-between` over
         * `.t` and `.v`, and on a 16:6 card that says nothing, because the
         * title fills the body and there is no free space to distribute. On
         * this 16:8.4 frame there is a great deal: with a one-line title,
         * pure `space-between` pins 110px of type to the very top of a 526px
         * box and strands it — detached from the numeral beside it and from
         * the place line below it. MEASURED at three top paddings; padding
         * cannot fix it, because padding moves both ends together.
         *
         * So the title block takes the free space (`flexGrow: 1`) and centres
         * ITSELF inside it, while the place line stays pinned to the foot —
         * which is what `space-between` was drawing in the artifact anyway.
         * The title then sits against the vertical centre of the date column,
         * whose own group is centred, so the two halves of the card read as
         * counterparts at every title length instead of only at three lines.
         */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
          }}
        >
          {/*
           * Multi-line clamp. Satori honours `lineClamp` (its own prop name for
           * `-webkit-line-clamp`) only with `display: "block"`, which is why
           * this one node deliberately breaks the "everything is flex" habit —
           * it has a single text child, so the multi-child rule does not apply.
           */}
          <div
            style={{
              display: "block",
              overflow: "hidden",
              lineClamp: 3,
              fontFamily: OG_SANS,
              fontSize: TITLE_SIZE,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: TITLE_TRACKING,
              color: INK,
            }}
          >
            {safeTitle || "Untitled event"}
          </div>
        </div>

        {safeVenueLine ? (
          <div
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: OG_SANS,
              fontSize: VENUE_SIZE,
              fontWeight: 500,
              lineHeight: 1.3,
              color: MUTED,
            }}
          >
            {safeVenueLine}
          </div>
        ) : // No disclosed place at all. Nothing is drawn and nothing stands
        // in for it — the title block simply takes the whole body and centres
        // in it, which is the same rule, not a second layout.
        null}
      </div>
    </div>
  );
};
