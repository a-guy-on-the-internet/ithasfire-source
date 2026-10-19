"use client";

import { memo } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled } from "tamagui";

import { Text } from "../typography/Text";

/**
 * DateStub — the default event artwork, in-app.
 *
 * The IN-APP half of "Direction C · Date Stub". Its raster twin is
 * `apps/web/src/server/og/date-stub.tsx`, the `next/og` (Satori) element tree
 * behind `/og/event/<slug>`, and that file is the visual source of truth: the
 * two are the SAME artifact rendered by two engines, so where this one departs
 * it says why.
 *
 * ── WHY A SECOND IMPLEMENTATION EXISTS AT ALL ───────────────────────────────
 * The PNG is a RASTER for Slack / iMessage / email — surfaces that cannot
 * theme, so it is pinned to one polarity for ever (see that file's "WHY LIGHT /
 * PAPER POLARITY, ALWAYS"). In-app the opposite is true: the viewer has a
 * theme, there is no network request to make, and the artwork should be vector
 * type that resamples at any density. So the composition is rebuilt here in
 * Tamagui primitives reading SEMANTIC tokens, and it flips with the theme.
 *
 * ── THE COMPOSITION (artifact CSS, verbatim) ────────────────────────────────
 *   .ds     display:flex; align-items:stretch; background: --panel
 *   .stub   width:34%; background: --accent; color:#fff; centred column;
 *           border-right: 2px dashed --panel
 *   .dow    8px / .18em / 800 / opacity .85
 *   .dd     30px / 900 / line-height .9 / tabular-nums
 *   .mo     9px / .16em / 800
 *   .body   flex:1; padding:10px 11px; space-between
 *   .t      12px / 800 / 1.15 / -.015em
 *   .v      9px / 600 / --muted
 * Order inside the column is DOW, DD, MO (`THU / 10 / SEP`). Body is title over
 * place line. No wordmark, no caption — the caption is a hero-only idiom whose
 * first half is a CATEGORY that does not exist in this payload; the PNG drops
 * it for exactly that reason (`eventStubCaption` in `@th/types`) and so does
 * this.
 *
 * ── COLOUR: `structure` / `onStructure`, NOT `accent` ───────────────────────
 * The artifact's `--accent` is #35589A, which in this codebase is the
 * `structure` token, not `accent` (#E2481D on Stub / #FF5721 on Ember). Reading
 * it as `accent` would be a mistranslation with two consequences the token file
 * is emphatic about:
 *
 *   1. `accent` is a LARGE-SURFACE / GRAPHIC value with NO legal small-text
 *      foreground in either polarity on Stub (white 4.06:1, ink 4.38:1). The
 *      stub column is a large fill carrying small tracked labels, so it needs a
 *      pairing that clears AA — and `accent`'s does not exist.
 *   2. The design system budgets accent at <=5% of any viewport. A 34% column
 *      on every card of a six-up discovery grid is an order of magnitude over.
 *
 * `structure` / `onStructure` is the pairing the token file names for exactly
 * this job — a filled field with its own declared foreground — and it clears
 * AA in all three themes (MEASURED, and guarded by
 * `__tests__/DateStub.contrast.test.ts`):
 *
 *   stub  (default)  ink   #211C16 / paper #FDFAF3  = 16.22:1
 *   swiss (light)    steel #35589A / white #FFFFFF  =  6.97:1
 *   ember (dark)     steel #35589A / white #FFFFFF  =  6.97:1
 *
 * The weekday's `opacity` survives that too: at the `Text` atom's `muted`
 * emphasis rung (0.80) it composites to 10.76 / 5.16 / 5.16.
 *
 * ── TYPOGRAPHY: two fonts, and where weight 800 lands ───────────────────────
 * Per `DateBlock` (the molecule that documents this idiom) and design-system
 * v2: the tracked-uppercase micro-labels ride IBM Plex Mono; the day numeral
 * does NOT — at display weight it is display type, and Montserrat carries
 * display in this system.
 *
 * The artifact's `font-weight:800` is not a rung this product loads. Montserrat
 * is variable 100-900 so 800 exists on web, but `Text`'s weight ladder is
 * 400/500/600/700/900 and IBM Plex Mono ships only 400/500/600/700. The mapping
 * (same as the PNG's, for the same reasons):
 *
 *   `.dd`  900 -> Montserrat 900 (`weight="black"`).
 *   `.t`   800 -> Montserrat 700 (`weight="bold"`), NOT 900. The artifact sets
 *                 the numeral heavier than the title; mapping the title to 900
 *                 would collapse that and give the card two competing blacks.
 *   `.dow` 800 -> IBM Plex Mono 600 (`variant="overline"`'s own default, and
 *   `.mo`  800    the design system's label idiom). 700 exists, but at tracked
 *                 micro-caps 600 already reads as "heavy label", and 600 is
 *                 what every other label in the product uses.
 *   `.v`   600 -> Montserrat 500 (`weight="medium"`), rounding DOWN so the
 *                 place line stays quieter than the title — which is what
 *                 `--muted` is also saying.
 *
 * Size and tracking travel together. On the CARD tiers the labels sit on real
 * rungs of the mono ladder (`monoScale`) — `2xs` (9.5/2.5) at `sm`, `xs`
 * (10/2.5) at `md`, `sm` (11/2.5) at `lg` — and deliberately do NOT scale with
 * the frame; a micro-label grown to 20px stops being the idiom, and the NUMERAL
 * carries the scale instead.
 *
 * The two HERO tiers are the one documented departure. The ladder's five rungs
 * span 9.5-13px because it is a ladder for UI labels read at arm's length, and
 * it has no rung for type that is ARTWORK — which is the whole of what the hero
 * stub is. Beside a 220px numeral a 13px label is not a micro-label, it is a
 * speck. So those two tiers carry the tracking the artifact itself specifies,
 * as the em ratio it specifies it in (`.dow{letter-spacing:.18em}`): 17/3.1 and
 * 13/2.34. The pairing rule is honoured — size and tracking still travel
 * together — it is the ladder's ceiling that does not reach here. The PNG made
 * the same move for the same reason (43px mono on a 1200px canvas).
 *
 * ── ACCESSIBILITY: it depends on what the SURFACE already says ──────────────
 * The question is not "is this a graphic" but "is this the only place these
 * words exist", and the two surfaces answer it differently. Getting it wrong in
 * either direction is a real defect, and this repo has already shipped the
 * first one:
 *
 *   DECORATIVE (`decorative`, the default) — the surface prints the date, the
 *   title and the place as real text beside the stub. The TICKET card does (its
 *   body has the title and a meta list) and so does the event page (the <h1>
 *   and the meta rows sit a few hundred pixels below the hero). Announcing the
 *   stub there reads the whole card twice: the accessible-name collision that
 *   already shipped once here. The whole subtree is hidden, on web and native.
 *
 *   CARRYING (`decorative={false}`) — the stub IS the card. The POSTER card
 *   renders no body content at all (`isFeature ? null : content`); title and
 *   meta live only ON the art, so a hidden stub would leave the card with
 *   nothing but its own `accessibilityLabel`. The body text therefore stays in
 *   the accessibility tree and the caller feeds it the same strings the
 *   treatment it replaced was announcing.
 *
 * The date COLUMN is hidden either way. It is a graphic rendering of a date —
 * "THU", "10", "SEP" as three separate fragments is worse than useless spoken
 * aloud — and the readable form belongs in the place line. That is not a new
 * rule: the poster's corner `PosterStamp` is already `aria-hidden` for exactly
 * this reason, so a poster card announces its time through `posterMeta` and
 * never its day. Keeping that unchanged is the point.
 *
 * On the event page the stub also REPLACES a node that announced "No hero
 * image", which is noise: the absence of artwork is not information.
 */

const isWeb = Platform.OS === "web";

/** Hides the whole subtree from assistive tech on web AND native. */
const DECORATIVE_PROPS = isWeb
  ? ({ "aria-hidden": true } as const)
  : ({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    } as const);

export type DateStubSize = "sm" | "md" | "lg" | "heroCompact" | "xl";

/**
 * The type ramp, per frame tier.
 *
 * Explicit numbers rather than space/size tokens: the fractional space tokens
 * have a known resolution bug in this config, and the artifact's ramp is a set
 * of measured ratios, not a scale step.
 */
const RAMP = {
  // Dense / narrow frames.
  sm: {
    day: 30,
    dayLine: 27,
    dayTrack: -1,
    label: 9.5,
    labelTrack: 2.5,
    labelLine: 12,
    title: 13,
    titleLine: 15,
    titleTrack: -0.2,
    venue: 10,
    venueLine: 13,
    note: 9,
    noteTrack: 2,
    padX: 10,
    padY: 10,
    perforation: 2,
    tearInset: 0,
  },
  // The TICKET card's art window — 3:2 landscape, ~272-400px wide. The
  // artifact's own card specimen is 320px wide, so this is close to its
  // literal ramp.
  md: {
    day: 38,
    dayLine: 34,
    dayTrack: -1.2,
    label: 10,
    labelTrack: 2.5,
    labelLine: 13,
    title: 15,
    titleLine: 17,
    titleTrack: -0.22,
    venue: 11,
    venueLine: 14,
    note: 9.5,
    noteTrack: 2,
    padX: 13,
    padY: 12,
    perforation: 2,
    // The dense list thumbnail runs this tier in `column` layout at 64-96px
    // wide. No tear: an inset rule there would eat a sixth of the frame to
    // draw a detail nobody can resolve at that size.
    tearInset: 0,
  },
  // The POSTER card's art window — 2:3 portrait (4:5 at `$sm`). Much taller
  // than `md` but no wider, and the column is a percentage of the WIDTH: at the
  // narrowest grid track (272px) it is 92px, so the numeral is sized to fit two
  // digits there ("30" at Montserrat 900/60px measures ~72px) rather than to
  // fill the height.
  lg: {
    day: 62,
    dayLine: 56,
    dayTrack: -1.8,
    label: 11,
    labelTrack: 2.5,
    labelLine: 15,
    title: 19,
    titleLine: 23,
    titleTrack: -0.29,
    venue: 11.5,
    venueLine: 15,
    note: 9.5,
    noteTrack: 2,
    padX: 16,
    padY: 16,
    perforation: 2,
    tearInset: 0,
  },
  // ── The event page hero, BELOW `$sm` ──────────────────────────────────────
  // Same composition as `xl`, sized for the frame a phone actually gets: at a
  // 320px viewport the hero is 284 x 196 (its 200px `minHeight` governs, not
  // the 16:9), so the date group has 196px of height to live in. MEASURED at
  // 128: the group stacks 151px and leaves 22px of field above and below, and
  // two digits render ~161px inside 284.
  heroCompact: {
    day: 128,
    dayLine: 115,
    dayTrack: -4,
    label: 13,
    labelTrack: 2.34,
    labelLine: 17,
    // The body rows are unreachable in `column` layout; kept so the tier
    // satisfies the same shape as its siblings.
    title: 26,
    titleLine: 30,
    titleTrack: -0.4,
    venue: 13,
    venueLine: 17,
    note: 10,
    noteTrack: 2.5,
    padX: 20,
    padY: 18,
    perforation: 2,
    tearInset: 14,
  },
  // ── The event page hero ───────────────────────────────────────────────────
  //
  // A COLUMN-LAYOUT tier: on the detail page the stub is the torn stub itself,
  // full-bleed, because the page states the title and the place as real text
  // within a few hundred pixels and the artwork's job there is identity, not
  // information. (Ruled 2026-09-12 after MEASURING the duplication at 320px:
  // the screen read "Comedy Night at Larry's" / "COMEDY NIGHT AT LARRY'S" /
  // "Nashville, TN" / "NASHVILLE, TN" — four lines, two facts.) On a CARD the
  // title stays: the poster variant renders no body, so the stub's title is the
  // card's only title.
  //
  // The numeral is therefore the whole composition and is scaled to own it the
  // way the PNG's 244 owns its 408px column. MEASURED against the frame at
  // 641px — one pixel past `$sm`, the tightest this tier ever sees — where the
  // hero is ~609 x 343: the group stacks 238px inside 343 and two digits render
  // ~277px inside 609.
  xl: {
    day: 220,
    dayLine: 198,
    dayTrack: -7,
    label: 17,
    labelTrack: 3.1,
    labelLine: 23,
    title: 38,
    titleLine: 44,
    titleTrack: -0.57,
    venue: 15,
    venueLine: 20,
    note: 11,
    noteTrack: 2.5,
    padX: 32,
    padY: 28,
    perforation: 2,
    tearInset: 22,
  },
} as const satisfies Record<DateStubSize, Record<string, number>>;

/**
 * The ramp a tier steps down to below the `$sm` breakpoint (maxWidth 640).
 *
 * Only `xl` has one, and the asymmetry is the whole point: `xl` is the ONE tier
 * whose frame is sized by the viewport (the event page hero is
 * `min(768, viewport)` wide), so below 640 its frame is no longer a wide frame.
 * The card tiers are not — a browse card's art window is 272-400px wide at
 * EVERY viewport, because the grid is `repeat(auto-fill, minmax(272px, 1fr))`.
 * Stepping those down at `$sm` would shrink type for no reason.
 *
 * MEASURED, not guessed. The numeral is a fixed px size, so a wide-frame
 * numeral in a narrow frame does not merely look big — at a 320px viewport,
 * back when the hero was still a 34% split, its column was 98px and the
 * wide-frame numeral rendered ~161px of glyph inside it. The browser drew two
 * digits bleeding across the whole column and clipping into an illegible
 * black-and-white smear. `$sm` is what stops that.
 *
 * `$sm` ONLY, never `$sm` plus `$xs`: this config declares `xs` before `sm`
 * (`media` in `tamagui/index.ts`), so `sm` wins at every width `xs` also covers
 * and an `$xs` rung is dead style.
 */
const NARROW_RAMP: Partial<Record<DateStubSize, DateStubSize>> = {
  xl: "heroCompact",
};

/**
 * Three-line clamp on the title, one-line ellipsis on the place line.
 *
 * Mirrors `TWO_LINE_TITLE_CLAMP` in `EventCard` (the established pattern in
 * this package): `overflow-wrap:anywhere` breaks an over-long single token,
 * `word-break:normal` keeps ordinary words whole. Native has no line clamp, so
 * it falls back to the single-line `truncate` the `Text` atom already provides.
 */
const TITLE_CLAMP: Record<string, unknown> | undefined = isWeb
  ? {
      display: "-webkit-box",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: 3,
      overflow: "hidden",
      overflowWrap: "anywhere",
      wordBreak: "normal",
    }
  : undefined;

const StubFrame = styled(XStack, {
  name: "DateStub",
  width: "100%",
  height: "100%",
  alignItems: "stretch",
  // `.ds{background:var(--panel)}` — the artifact's panel is this theme's
  // `surface`, the same paper the card body is printed on.
  backgroundColor: "$surface",
  borderRadius: 0,
  overflow: "hidden",
});

/**
 * The torn-off date column: a FILLED field, not a paper callout.
 *
 * This is the departure from `DateBlock` the PNG documents at length. A paper
 * callout works inside a card the reader is already looking at; standing in for
 * the artwork itself, it reads as an empty page. The filled field carries its
 * own figure/ground.
 */
const StubColumn = styled(YStack, {
  name: "DateStubColumn",
  // `.stub{width:34%}` — a percentage, so the column holds its proportion at
  // every aspect ratio the art slot comes in (3:2 card, 16:9 hero, 2:3 poster).
  width: "34%",
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$structure",
  // `.stub{border-right:2px dashed var(--panel)}` — the perforation. PANEL
  // dashes ON the fill, so the gaps show the column's own colour and it reads
  // as a tear rather than as a border between two panels.
  //
  // `borderStyle` (not `borderRightStyle`): React Native only models the style
  // for the whole box, so the dash pattern has to be set globally and the OTHER
  // three sides held at zero width.
  //
  // `borderWidth: 0` is load-bearing and was MEASURED, not assumed. Without it
  // the three sides with no explicit width fall to CSS's initial
  // `border-width: medium` — 3px — the moment a style is declared, and they
  // paint in `currentColor`. On Stub that is ink dashes on an ink column and
  // invisible; on Ember it is WHITE dashes framing three sides of the steel
  // column, which is what the browser actually rendered before this line.
  borderWidth: 0,
  borderStyle: "dashed",
  borderRightColor: "$surface",
});

const StubBody = styled(YStack, {
  name: "DateStubBody",
  flex: 1,
  minWidth: 0,
  justifyContent: "center",
  // Gap, never margins, between siblings.
  gap: 4,
});

/**
 * The tear line, for `column` layout.
 *
 * In `split` layout the perforation is the date column's own right border,
 * because there is a body panel on the other side of it for the dashes to
 * separate from. Full-bleed there is nothing to separate — so the rule is
 * INSET, drawn as a zero-width absolute rule a little in from the right edge,
 * leaving a sliver of field beyond it. That sliver is what makes the frame read
 * as "the rest of the ticket was torn off here" rather than as a dashed border
 * around a coloured box. A rule flush against the edge reads as the latter, and
 * on Stub it would also sit 2px inside an ink frame of the same colour.
 */
const StubTear = styled(Stack, {
  name: "DateStubTear",
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 0,
  pointerEvents: "none",
  // Same zeroing as `StubColumn` — a declared `borderStyle` promotes every
  // undeclared side to CSS's initial `medium` (3px). See that block.
  borderWidth: 0,
  borderStyle: "dashed",
  borderRightColor: "$surface",
});

export type DateStubParts = {
  /** Short weekday, uppercase — "THU". */
  weekday: string;
  /** Day of month, unpadded — "10". */
  day: string;
  /** Short month, uppercase — "SEP". */
  month: string;
};

/**
 * Weekday / day / month in a given IANA zone.
 *
 * Mirrors `formatStubDateParts` in `apps/web/src/server/og/date-stub.tsx` so
 * the raster and the vector never disagree about which day an event is on:
 *
 *   - an absent or unusable zone falls back to **UTC**, not to the renderer's
 *     local zone, so the answer does not depend on where the machine drawing it
 *     happens to be;
 *   - the instant is the input (a `Date`), never a wall-clock object — luxon's
 *     `fromObject`/`fromISO` resolve an ambiguous DST fall-back time against
 *     `Settings.now()`, which makes them clock-dependent. `Intl` formatting an
 *     absolute instant has no such ambiguity, which is the same property
 *     `DateTime.fromJSDate` was chosen for there;
 *   - the locale is PINNED to `en-US`. The labels are a three-letter graphic
 *     idiom, not prose, and a system-locale default would silently change the
 *     artwork by machine.
 *
 * TOTAL: returns `null` for a missing or unparseable date and never throws —
 * the column then reads TBA rather than "Invalid Date". An unusable IANA string
 * makes `Intl.DateTimeFormat` throw a `RangeError`, which is caught and
 * degraded to UTC (the same arm luxon's `!isValid` takes in the PNG).
 *
 * Deliberately NOT importing luxon: `@th/ui` does not depend on it, and adding
 * a dependency for three `Intl` calls is not worth a lockfile change.
 */
export const formatStubDateParts = (
  startsAt: Date | string | number | null | undefined,
  timezone?: string | null,
): DateStubParts | null => {
  if (startsAt === null || startsAt === undefined || startsAt === "") {
    return null;
  }
  const date = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(date.getTime())) return null;

  const read = (zone: string): DateStubParts => {
    const opts = { timeZone: zone } as const;
    return {
      weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", ...opts })
        .format(date)
        .toUpperCase(),
      day: new Intl.DateTimeFormat("en-US", { day: "numeric", ...opts }).format(
        date,
      ),
      month: new Intl.DateTimeFormat("en-US", { month: "short", ...opts })
        .format(date)
        .toUpperCase(),
    };
  };

  try {
    return read(timezone?.trim() || "UTC");
  } catch {
    // Bogus IANA string. Fall back to UTC, same as the PNG.
    try {
      return read("UTC");
    } catch {
      return null;
    }
  }
};

export interface DateStubProps {
  /**
   * The event title — the artifact's `.t`. Empty renders nothing rather than a
   * placeholder: the body then belongs entirely to the place line, which is the
   * same layout rule, not a second one.
   */
  title?: string | null;
  /**
   * DOW / DD / MO, ALREADY DERIVED.
   *
   * Parts in rather than a date in, for the same reason `DateBlock` takes them:
   * a surface that also prints a formatted date beside the stub must derive
   * both from ONE call, or it eventually stamps SEP 2 above a line reading
   * SEP 3. Use {@link formatStubDateParts} when the surface owns the instant
   * and the venue's zone; reuse the surface's existing derivation when it
   * already has one.
   *
   * `null` is a supported state, not an error — the column still frames, it
   * just says TBA.
   */
  date: DateStubParts | null;
  /**
   * The artifact's `.v` — `Venue · City, ST`, degrading to `City, ST` and then
   * to nothing. Built by `eventStubVenueLine` in `@th/types` on the surfaces
   * that have the parts; anywhere else, whatever place label that surface
   * already shows.
   */
  venueLine?: string | null;
  /**
   * A short status line under the place line — "SOLD OUT", "PASSWORD · $15.00",
   * "RECURRING". Set in the mono label idiom.
   *
   * An IN-APP addition with no counterpart in the PNG, and it exists for one
   * concrete reason: on the poster card the stub takes over the whole art
   * window, and the treatment it replaces was carrying this line. Losing it
   * would mean a sold-out or gated event stopped saying so.
   */
  note?: string | null;
  /**
   * Whether the surface already prints this information as real text.
   *
   * `true` (default) hides the whole stub from assistive tech. `false` keeps the
   * BODY announceable — the date column stays hidden either way. See the
   * ACCESSIBILITY block at the top of this file; this is not a styling flag.
   */
  decorative?: boolean;
  /**
   * `split` (default) is the artifact: a 34% date column, a perforation, and a
   * body carrying the title and place line.
   *
   * `column` is the artifact TORN — the date column alone, filling the frame.
   * For slots too narrow to hold the split: a dense list row's thumbnail is
   * 64-96px wide, where 34% is ~27px and neither the numeral nor a tracked
   * "SEP" fits, and the body would be a 50px column of hyphenated title. The
   * degradation is honest rather than arbitrary — at thumbnail size what you
   * get is the stub half, which is the half that carries the date.
   */
  layout?: "split" | "column";
  /** Type ramp tier. See {@link RAMP}. */
  size?: DateStubSize;
  testId?: string;
  /**
   * Automation id for the title row specifically.
   *
   * Exists so a surface whose title MOVES into the stub can keep the hook it
   * already published: on a poster card with no upload the title used to live
   * in `FeatureScrim` under `<card>-title`, and a test or spec asking for that
   * id should not have to know which of the two treatments rendered.
   */
  titleTestId?: string;
}

export const DateStub = memo<DateStubProps>(
  ({
    title,
    date,
    venueLine,
    note,
    decorative = true,
    layout = "split",
    size = "md",
    testId,
    titleTestId,
  }) => {
    const ramp = RAMP[size];
    const narrow = NARROW_RAMP[size] ? RAMP[NARROW_RAMP[size]!] : null;
    /** Media overrides for a text rung, or nothing when the tier has no step-down. */
    const atNarrow = (
      fontSize: number,
      lineHeight: number,
      letterSpacing?: number,
    ) =>
      narrow
        ? {
            $sm: {
              fontSize,
              lineHeight,
              ...(letterSpacing === undefined ? {} : { letterSpacing }),
            },
          }
        : {};
    const safeTitle = (title ?? "").trim();
    const safeVenueLine = (venueLine ?? "").trim();
    const safeNote = (note ?? "").trim();

    return (
      <StubFrame
        {...(decorative ? DECORATIVE_PROPS : {})}
        {...(testId
          ? isWeb
            ? { "data-testid": testId }
            : { testID: testId }
          : {})}
      >
        {/* The date column is a GRAPHIC rendering of a date and is hidden from
            assistive tech on every surface — see the ACCESSIBILITY block. When
            the whole stub is already hidden this is a harmless no-op. */}
        <StubColumn
          // Torn: the column IS the frame, so there is nothing on the other
          // side of the perforation for it to separate from.
          {...(layout === "column"
            ? ({ width: "100%", borderRightWidth: 0 } as const)
            : { borderRightWidth: ramp.perforation })}
          {...DECORATIVE_PROPS}
        >
          {date ? (
            <YStack alignItems="center">
              {/* `.dow` — first, per the artifact. */}
              <Text
                variant="overline"
                fontSize={ramp.label}
                lineHeight={ramp.labelLine}
                letterSpacing={ramp.labelTrack}
                {...atNarrow(
                  narrow?.label ?? ramp.label,
                  narrow?.labelLine ?? ramp.labelLine,
                  narrow?.labelTrack ?? ramp.labelTrack,
                )}
                color="$onStructure"
                textAlign="center"
                // `.dow{opacity:.85}` — what keeps the weekday subordinate to
                // the numeral without spending a second colour. Snapped to the
                // `Text` atom's own `muted` emphasis rung (0.80) rather than a
                // magic 0.85; the difference is imperceptible and the rung is
                // the system's. Still 10.76:1 (stub) / 5.16:1 (swiss, ember)
                // composited on the fill — AA in every theme.
                emphasis="muted"
                style={{
                  // Letter-spacing is applied after the LAST glyph too, so a
                  // centred tracked run sits left of true centre by exactly
                  // that much. Nudge the optical centre back.
                  paddingLeft: ramp.labelTrack,
                }}
              >
                {date.weekday}
              </Text>
              {/* `.dd` — sans at display weight, line-height .9, tabular. */}
              <Text
                variant="span"
                fontFamily="$heading"
                fontSize={ramp.day}
                lineHeight={ramp.dayLine}
                letterSpacing={ramp.dayTrack}
                {...atNarrow(
                  narrow?.day ?? ramp.day,
                  narrow?.dayLine ?? ramp.dayLine,
                  narrow?.dayTrack ?? ramp.dayTrack,
                )}
                weight="black"
                color="$onStructure"
                textAlign="center"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {date.day}
              </Text>
              {/* `.mo` — last, per the artifact. */}
              <Text
                variant="overline"
                fontSize={ramp.label}
                lineHeight={ramp.labelLine}
                letterSpacing={ramp.labelTrack}
                {...atNarrow(
                  narrow?.label ?? ramp.label,
                  narrow?.labelLine ?? ramp.labelLine,
                  narrow?.labelTrack ?? ramp.labelTrack,
                )}
                color="$onStructure"
                textAlign="center"
                style={{ paddingLeft: ramp.labelTrack }}
              >
                {date.month}
              </Text>
            </YStack>
          ) : (
            // No usable date. The column still frames, it just says so.
            <Text
              variant="overline"
              fontSize={ramp.label}
              lineHeight={ramp.labelLine}
              letterSpacing={ramp.labelTrack}
              {...atNarrow(
                narrow?.label ?? ramp.label,
                narrow?.labelLine ?? ramp.labelLine,
                narrow?.labelTrack ?? ramp.labelTrack,
              )}
              color="$onStructure"
              textAlign="center"
              style={{ paddingLeft: ramp.labelTrack }}
            >
              TBA
            </Text>
          )}
          {layout === "column" && ramp.tearInset > 0 ? (
            <StubTear
              borderRightWidth={ramp.perforation}
              right={ramp.tearInset}
              {...(narrow && narrow.tearInset > 0
                ? { $sm: { right: narrow.tearInset } }
                : {})}
            />
          ) : null}
        </StubColumn>

        {layout === "column" ? null : (
          <StubBody
            paddingHorizontal={ramp.padX}
            paddingVertical={ramp.padY}
            {...(narrow
              ? {
                  $sm: {
                    paddingHorizontal: narrow.padX,
                    paddingVertical: narrow.padY,
                  },
                }
              : {})}
          >
            {/*
              ── ONE CENTRED BLOCK, NOT `space-between` ───────────────────────
              The artifact's `.body` is `space-between` over `.t` and `.v`. That
              is a rule for the specimen it was drawn on — a 3:2 card whose body
              is nearly square, where the title fills the box and there is no free
              space to distribute. Every frame this component actually lands in is
              far from square: the poster card is 2:3 PORTRAIT (a ~190x430 body)
              and the event hero is 16:9 (a ~500x320 one). MEASURED on both,
              `space-between` puts 200px of nothing between the title and the
              place line, and the line stops reading as that title's byline and
              starts reading as a stranded caption.

              So the body's three rows travel together as one block, centred
              against the centred date column beside them. The hierarchy the
              artifact encodes — title, then a smaller muted place line, then a
              quieter note — is untouched; only the slack moves, from between the
              rows to around them. (The PNG reached the same conclusion from the
              same problem and solved half of it, centring the title but leaving
              the place line pinned; at 16:8.4 the remaining gap is small enough
              not to detach.)
            */}
            {safeTitle ? (
              <Text
                variant="span"
                fontFamily="$heading"
                fontSize={ramp.title}
                lineHeight={ramp.titleLine}
                letterSpacing={ramp.titleTrack}
                {...atNarrow(
                  narrow?.title ?? ramp.title,
                  narrow?.titleLine ?? ramp.titleLine,
                  narrow?.titleTrack ?? ramp.titleTrack,
                )}
                weight="bold"
                truncate={!isWeb}
                {...(titleTestId ? { testId: titleTestId } : {})}
                {...(TITLE_CLAMP ? { style: TITLE_CLAMP } : {})}
              >
                {safeTitle}
              </Text>
            ) : null}
            {safeVenueLine ? (
              <Text
                variant="span"
                fontSize={ramp.venue}
                lineHeight={ramp.venueLine}
                {...atNarrow(narrow?.venue ?? ramp.venue, narrow?.venueLine ?? ramp.venueLine)}
                weight="medium"
                tone="muted"
                truncate
              >
                {safeVenueLine}
              </Text>
            ) : null}
            {safeNote ? (
              <Text
                variant="overline"
                fontSize={ramp.note}
                lineHeight={ramp.note + 4}
                letterSpacing={ramp.noteTrack}
                {...atNarrow(
                  narrow?.note ?? ramp.note,
                  (narrow?.note ?? ramp.note) + 4,
                  narrow?.noteTrack ?? ramp.noteTrack,
                )}
                tone="muted"
                truncate
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {safeNote}
              </Text>
            ) : null}
          </StubBody>
        )}
      </StubFrame>
    );
  },
);

DateStub.displayName = "DateStub";
