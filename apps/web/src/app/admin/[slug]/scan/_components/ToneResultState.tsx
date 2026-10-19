"use client";

import type { ReactNode } from "react";
import {
  Ban,
  CalendarX2,
  CheckCheck,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  DoorOpen,
  HelpCircle,
  SearchX,
  ServerOff,
  ShieldAlert,
  ShieldQuestion,
  Tag,
  UserCheck,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { YStack } from "tamagui";

import { Text } from "@th/ui";
import type { VerdictTone } from "@th/types";

import type { ScanGlyphId } from "./scan-result-presentation";
import { TONE_FILL_TOKENS, toneToken, toneVar } from "./scan-tone";
import stampStyles from "./tone-result-stamp.module.css";

/**
 * The full-bleed door-mode verdict for the web scan page, on the Ithas Fire
 * Design System's contract (`components/tickets/ScanResult.jsx`, DECISIONS.md
 * D-122…D-126).
 *
 * The native twin is `@th/ui-native`'s `ToneResultState`, which is React Native
 * and cannot be imported here. Same two tones, same shared verdict map
 * (`@th/types`' `SCAN_VERDICTS`), same zone order — one language across both
 * surfaces, two renderers.
 *
 * ## Structure
 *
 *   ① **state** — a small, wide-tracked, uppercase mono line saying what this
 *     pass IS, with the scan time appended: `ALREADY USED · 8:14 PM`.
 *   ② **word** — the instruction, at the display rung: `STOP`, `LET THEM IN`.
 *   ③ **who** — the holder in bold, then the tier, then the `detail` line that
 *     carries the WHY ("Scanned at 21:14 — already admitted." is what settles
 *     an argument with a stranger).
 *
 * Splitting ① from ② is the load-bearing idea: it is what lets TWO tones carry
 * nineteen outcomes without lying. It replaced a four-family system
 * (green/amber/ink/red) whose colours were never in this brand's palette. At a
 * gate "Valid" still requires a decision; "LET THEM IN" does not.
 *
 * ## Redundancy contract (non-negotiable)
 *
 * Colour is never the only channel. Every state carries FOUR: fill colour ·
 * fill *lightness* (PASS is the light one on every theme) · hero glyph · and
 * the state/word pair. A deuteranope reads amber and flame as two similar
 * blocks, which is why the glyph and the two type lines are mandatory rather
 * than decorative.
 *
 * ## Why it owns the colours
 *
 * Callers name a {@link VerdictTone}, never a colour, so no screen can pick a
 * wrong pair. The one legal foreground per fill lives in `TONE_FILL_TOKENS` and
 * is measured by `__tests__/scan-tone-contrast.test.ts` on all three themes.
 * There are no alpha-muted foregrounds anywhere below — including on the state
 * line, where the DS's own `opacity: .85` is DROPPED: on the FAIL pair it
 * measures 4.67:1 (5.92:1 at full opacity), clearing AA by only 0.17, and it is
 * the same bug class this surface already
 * shipped once (70% white on the old green fill was 4.40:1). Hierarchy comes
 * from size and weight only.
 *
 * ## Announcement
 *
 * D-125 makes the verdict the one sanctioned `role="alert"` +
 * `aria-live="assertive"` in the system, and this is a real DOM where that
 * works properly. The verdict block IS the live region — there is deliberately
 * no second announcement channel anywhere on this page. It used to have a
 * separate polite `role="status"` span, and running both would read every
 * verdict twice. The alert wraps the verdict only: the below-the-fold detail
 * panel holds its own buttons and must not be shouted.
 *
 * ## Motion
 *
 * Stamp C (`tone-result-stamp.module.css`). The hero glyph drops in, 180ms on
 * `cubic-bezier(.3,0,.2,1)`: from 1.9× and invisible, overshooting to 0.94×
 * at 70%, landing at 1×, pivoting below centre (`50% 60%`) so it lands rather
 * than pulses. The word fades in over 120ms after a 120ms delay, so it arrives
 * as the glyph lands. Nothing else moves: the tone fill, the state line and
 * the holder/detail lines paint on frame 1, so the fill — the signal the
 * operator reads first, from across a room — is never delayed.
 *
 * This is an owner override of DS D-125 ("ScanResult is the one place with no
 * transition at all"; owner, 2026-10-06; recorded as D-150 in the DS
 * DECISIONS.md). D-125's worry was latency at a gate reading as failure; the
 * stamp keeps that cost to the glyph and word and keeps the whole entry under
 * a quarter second.
 *
 * Motion is visual only. The live region's text is in the DOM, final, on frame
 * 1 — the word animates `opacity`, never `visibility`/`display`, and nothing
 * delays mounting — so a screen reader hears the verdict at once.
 *
 * Under `prefers-reduced-motion: reduce` a CSS rule removes both animations
 * and the render is the static final frame (scale 1, opacity 1), identical to
 * the pre-stamp version. It is CSS rather than a JS branch, so the server and
 * client renders cannot disagree. "No flash/strobe animation ever" still holds:
 * each verdict plays once, a single drop-and-fade with nothing repeating or
 * alternating, and the fill itself never animates.
 *
 * `stampKey` decides when it replays: the glyph and word are keyed on it, so a
 * new verdict re-inserts them and the stamp plays again — two VALID tickets in
 * a row included — while a re-render of the same verdict does not.
 */

/**
 * Glyph id → component. Kept here so the presentation module stays pure.
 *
 * Deliberately NOT called `SCAN_GLYPHS` — that name belongs to the verdict-key
 * → id map in `scan-result-presentation.ts`, and two same-named maps one import
 * apart is a footgun.
 */
export const SCAN_GLYPH_COMPONENTS: Record<ScanGlyphId, LucideIcon> = {
  CheckCircle2,
  DoorOpen,
  CheckCheck,
  CircleDollarSign,
  Ban,
  Tag,
  XCircle,
  CalendarX2,
  Clock,
  HelpCircle,
  SearchX,
  ShieldAlert,
  ServerOff,
  UserCheck,
  WifiOff,
  ShieldQuestion,
};

/**
 * Hero glyph size. One value, not a responsive pair: 88px keeps the state,
 * word and holder above the fold on a 320×568 phone (the smallest viewport
 * this page is designed for) while still reading at arm's length, and a single
 * element means one thing in the DOM for tests and screen readers.
 */
export const HERO_GLYPH_SIZE = 88;
/**
 * DS v2 §6 pins Lucide `strokeWidth: 2`. At 88px that is ~2% of the glyph box
 * (versus ~9% at the 22px used elsewhere) and reads as a hairline outline
 * rather than a symbol. A scale compensation at the hero size ONLY.
 */
export const HERO_STROKE_WIDTH = 3;

/**
 * The word's type size, by length — our stand-in for the DS's
 * `clamp(52px, 13vw, 88px)`.
 *
 * The clamp is authored against the DS's own five words, the longest of which
 * is "Let them in". Our shared map ships nineteen, up to "CHECK THEM IN" — and
 * a viewport-derived clamp does not know that. At 320px the band offers ~286px
 * of text width; at the clamp's 52px floor, uppercase Montserrat Black averages
 * ~0.72em of advance, so a six-character token needs ~225px and a longer one
 * wraps mid-word or overflows. Sizing by LENGTH is deterministic, node-testable
 * and identical to the scanner's `verdictWordFontSize`, so the same word is the
 * same size on both surfaces.
 *
 * Rungs are picked so the longest single token at each rung fits 286px:
 * `STOP`/`DONE`/`HOLD` at 64 (~184px), `SEARCH` at 48 (~208px), `CHECK` at 40
 * (~144px).
 */
export const verdictWordFontSize = (word: string): number =>
  word.length <= 6 ? 64 : word.length <= 11 ? 48 : 40;

/**
 * Above 640px the band is no longer the whole phone screen and the same word
 * can afford the DS's ceiling — 64 × 1.35 = 86, which is the clamp's 88px max
 * in all but name. Below it, the mobile rung stands: this page's primary
 * surface is a phone browser and the mobile value is the one that was measured.
 */
export const WIDE_WORD_SCALE = 1.35;
export const verdictWordFontSizeWide = (word: string): number =>
  Math.round(verdictWordFontSize(word) * WIDE_WORD_SCALE);

/**
 * Leading and tracking travel with the size. The DS's `-2.5px` is authored
 * against its 52–88px clamp; tracking that tight at 40px closes the counters,
 * so it is scaled rather than copied.
 */
const wordMetrics = (size: number) => ({
  fontSize: size,
  lineHeight: Math.round(size * 0.9),
  letterSpacing: -(size * 0.045),
});

/**
 * Holder names, ticket types, event titles and ticket codes are all user data
 * with no length contract — a 64-character code (the server's ceiling) is
 * ~576px at this size, against 286px of usable width at 320px. Break rather
 * than overflow the band.
 */
const BREAK_LONG_WORDS = { overflowWrap: "anywhere" } as const;

/** Codes are tabular so they do not jitter their own width between scans. */
const TABULAR = { ...BREAK_LONG_WORDS, fontVariantNumeric: "tabular-nums" } as const;

type ToneResultStateBaseProps = {
  tone: VerdictTone;
  glyph: ScanGlyphId;
  /**
   * DS zone ① — what this pass IS, already composed with the time
   * (`ALREADY USED · 8:14 PM`). Build it with `@th/types`' `verdictStateLine()`;
   * never concatenate at a call site.
   */
  state: string;
  /**
   * DS zone ② — what to DO. Uppercase, an instruction, never a status.
   * `STOP` / `LET THEM IN` / `CHECK FIRST`.
   */
  word: string;
  /** Holder name. NOT uppercased — `McDonald`, `de la Cruz`, `O'Brien`. */
  name?: string | null;
  /** Ticket type / volunteer role label — the DS's `tier`. */
  typeName?: string | null;
  /** Ticket code. Tabular so it does not jitter its own width. */
  code?: string | null;
  /** DS `detail` — ≤2 lines of WHY, the line that settles an argument. */
  detail?: string | null;
  /**
   * A raw server code/message, for SUPPORT only — the thing a venue reads down
   * the phone to us. Set on a failed round trip and nowhere else.
   *
   * Named `supportRef`, not `ref`: `ref` is reserved on a React component and
   * would be intercepted before it ever reached this function.
   *
   * It is the smallest, lightest line in the block and it sits BELOW the
   * detail, because the one defect this prop exists to prevent is a raw
   * identifier being mistaken for instructions. It carries the same measured
   * `on<Tone>` foreground as everything else here — hierarchy is size and
   * weight, never opacity.
   */
  supportRef?: string | null;
  /**
   * Tap/click-to-dismiss on the whole band. Deliberately withheld on a VALID
   * ticket: there, the operator's single most practised gesture (tap the
   * screen, next person) would silently SKIP an admission — the ticket is never
   * marked, the count is wrong, and nothing tells anyone. See
   * `actionTapDismissable`.
   *
   * It is a REDUNDANT affordance, not the only one: the same action always has
   * a real, labelled button in the action row beneath. That is why the band is
   * not itself a `<button>` — wrapping the verdict in one would give it a
   * single accessible name and collapse the state, word, holder and detail into
   * that name for screen-reader users. Content stays content; the semantics
   * live on the button.
   */
  onDismiss?: () => void;
  /**
   * The identity of the verdict on screen. The glyph and word are keyed on it,
   * so a CHANGE re-inserts them and replays the stamp (see `## Motion`), while
   * a re-render with the same value leaves them, and their finished animation,
   * alone. It must change per verdict, not per render: the host passes
   * `verdictSignature()`, the same identity the haptic cue fires on. Omitted,
   * the stamp plays once, when the band mounts.
   */
  stampKey?: string;
  testID?: string;
};

/**
 * ## Why `hasDetail` is an explicit boolean and not `!!children`
 *
 * It was `!!children` on the native side, and that shipped a dead affordance on
 * ten of eleven states: hosts pass a detail *component* unconditionally and let
 * it return null, but a React element is truthy whether or not it renders
 * anything. Every fail verdict grew an empty `surface` band cut into the fill.
 *
 * The pair is a union rather than an optional flag on purpose: passing
 * `children` without `hasDetail` is a TYPE ERROR, so the two can neither drift
 * nor be forgotten. Hosts derive the boolean from the same pure predicate their
 * detail component uses (`planScanDetail`).
 */
type ToneResultStateDetailProps =
  | { children: ReactNode; hasDetail: boolean }
  | { children?: undefined; hasDetail?: false };

export type ToneResultStateProps = ToneResultStateBaseProps &
  ToneResultStateDetailProps;

export function ToneResultState({
  tone,
  glyph,
  state,
  word,
  name,
  typeName,
  code,
  detail,
  supportRef,
  onDismiss,
  stampKey,
  children,
  hasDetail = false,
  testID,
}: ToneResultStateProps) {
  const pair = TONE_FILL_TOKENS[tone];
  const fill = toneToken(pair.fill);
  const on = toneToken(pair.on);
  const onCss = toneVar(pair.on);
  const Glyph = SCAN_GLYPH_COMPONENTS[glyph];
  const showDetail = hasDetail && children != null;

  const verdictBlock = (
    <YStack
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$5"
      // The DS's `.if-verdict` floor. Short verdicts still read as a field, not
      // as a caption on a coloured strip.
      minHeight={260}
      justifyContent="center"
      $gtSm={{ paddingHorizontal: "$5" }}
      {...(onDismiss
        ? {
            onPress: onDismiss,
            cursor: "pointer",
            "data-testid": "tone-result-dismiss-target",
          }
        : null)}
    >
      <YStack
        /*
          D-125 — the one sanctioned assertive live region in the system, and the
          page's ONLY announcement channel. The detail panel and the support
          reference are deliberately outside it.
        */
        role="alert"
        aria-live="assertive"
        gap="$3"
        data-testid="tone-result-live-region"
      >
        {/*
          Stamp C. Keyed on `stampKey` so a new verdict re-inserts the node and
          the CSS animation replays; the 1.9× opening frame overhangs the
          glyph's box on purpose, at near-zero opacity, and a transform never
          moves the lines below it.
        */}
        <Glyph
          // Distinct from the word's key: siblings that share a key collide.
          key={stampKey == null ? undefined : `${stampKey}:glyph`}
          className={stampStyles.glyph}
          size={HERO_GLYPH_SIZE}
          color={onCss}
          strokeWidth={HERO_STROKE_WIDTH}
          aria-hidden
          data-testid="tone-result-glyph"
        />

        {/*
          ① STATE — the DS's `.if-verdict__state`: IBM Plex Mono, 11px, 3px
          tracking, uppercase. `variant="kicker"` IS that pair from the mono
          ladder, so size and tracking cannot travel apart. Full opacity.
        */}
        <Text
          variant="kicker"
          weight="bold"
          color={on}
          style={BREAK_LONG_WORDS}
          data-testid="tone-result-state-line"
        >
          {state}
        </Text>

        {/*
          ② WORD — the instruction, and the largest thing on the screen.

          `h1`, not the DS's `h2`: the DS authors its `ScanResult` as a card
          inside a shell that owns the page heading. Here, door mode takes the
          page chrome OUT of the document while a verdict is up, and neither the
          admin shell nor this page renders a heading of any level — so an `h2`
          would be an orphan skipped level, while `h1` is simply true. In door
          mode the verdict IS the page.

          Stamp C fades it in by OPACITY only — the text is in the DOM and in
          the live region from frame 1. Keyed with the glyph, for the replay.
        */}
        <Text
          key={stampKey == null ? undefined : `${stampKey}:word`}
          className={stampStyles.word}
          variant="span"
          tag="h1"
          weight="black"
          textTransform="uppercase"
          color={on}
          style={BREAK_LONG_WORDS}
          {...wordMetrics(verdictWordFontSize(word))}
          $gtSm={wordMetrics(verdictWordFontSizeWide(word))}
          data-testid="tone-result-word"
        >
          {word}
        </Text>

        {/*
          ③ WHO — `<b>holder</b> · tier`, exactly as the DS composes it. One line,
          not two: the holder and their tier are one fact ("Dana Whitfield · GA")
          and splitting them costs a whole rung of vertical budget on a screen
          whose bottom is an action row.
        */}
        {name || typeName ? (
          <Text
            variant="span"
            fontSize={20}
            lineHeight={26}
            color={on}
            // NOT uppercase: uppercasing a human name mangles McDonald,
            // de la Cruz, O'Brien.
            style={BREAK_LONG_WORDS}
            data-testid="tone-result-who"
          >
            {name ? (
              <Text
                variant="span"
                fontSize={20}
                lineHeight={26}
                weight="bold"
                color={on}
                data-testid="tone-result-name"
              >
                {name}
              </Text>
            ) : null}
            {name && typeName ? " · " : null}
            {typeName ? (
              <Text
                variant="span"
                fontSize={20}
                lineHeight={26}
                color={on}
                data-testid="tone-result-type"
              >
                {typeName}
              </Text>
            ) : null}
          </Text>
        ) : null}

        {code ? (
          <Text
            variant="code"
            // `monoScale.lg` — 13px / 0.4px. The rung for prices and codes.
            fontSize={13}
            letterSpacing={0.4}
            weight="medium"
            color={on}
            style={TABULAR}
            data-testid="tone-result-code"
          >
            {code}
          </Text>
        ) : null}

        {detail ? (
          <Text
            variant="span"
            fontSize={16}
            lineHeight={22}
            color={on}
            style={BREAK_LONG_WORDS}
            data-testid="tone-result-detail-line"
          >
            {detail}
          </Text>
        ) : null}
      </YStack>

      {/*
        OUTSIDE the live region, on purpose. Inside it, a screen reader shouted
        "Ref: volunteer_scan_token_not_configured" as part of the verdict — a
        raw identifier read aloud as if it were an instruction, the exact defect
        this prop exists to prevent. It stays visible and reachable by normal
        screen-reader navigation, for the support call it is for.
      */}
      {supportRef ? (
        <Text
          variant="code"
          fontSize={11}
          letterSpacing={0.4}
          color={on}
          style={BREAK_LONG_WORDS}
          data-testid="tone-result-ref"
        >
          {/* Labelled, so it reads as a reference an operator can quote rather
              than as another sentence telling them what to do. */}
          Ref: {supportRef}
        </Text>
      ) : null}
    </YStack>
  );

  return (
    <YStack
      width="100%"
      backgroundColor={fill}
      // DS v2: content is strict Swiss. A full-bleed verdict has no radius.
      borderRadius={0}
      data-testid={testID}
    >
      {verdictBlock}

      {showDetail ? (
        /* Below the fold, on `$surface` — every small line lives at 15–16:1
           there instead of fighting the tone fill. Never a dismiss target, and
           never inside the alert: it holds its own buttons. */
        <YStack
          backgroundColor="$surface"
          paddingHorizontal="$4"
          paddingVertical="$4"
          gap="$3"
          $gtSm={{ paddingHorizontal: "$5" }}
          data-testid="tone-result-detail"
        >
          {children}
        </YStack>
      ) : null}
    </YStack>
  );
}
