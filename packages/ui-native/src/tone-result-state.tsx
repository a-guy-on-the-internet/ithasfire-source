import { useCallback, useRef, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { ChevronDown, type LucideIcon } from "lucide-react-native";

import { Text } from "./text";
import { useColors } from "./theme";
import { toneColors, type VerdictTone } from "./tone";
import { useVerdictStamp } from "./use-verdict-stamp";

/**
 * The full-bleed door-mode verdict, on the Ithas Fire Design System.
 *
 * One skeleton for every outcome; only tokens, glyph and copy change. This
 * component owns the tone → fill/foreground mapping, so **no screen can pick a
 * wrong pair**: callers name a {@link VerdictTone}, never a colour. Today the
 * FAIL pair is one theme-invariant pair (`verdictFail` #B93312 with white,
 * 5.92:1 on Ember and Stub alike), so a fail does not change colour with the
 * theme — but the pair is still read from the palette, so re-pairing a tone is
 * a palette edit and never a hunt through call sites.
 *
 * ## Structure (DS `components/tickets/ScanResult.jsx`, D-122…D-126)
 *
 *   ① **state** — a small, wide-tracked, uppercase line saying what this pass
 *     IS, with the scan time appended: `ALREADY USED · 8:14 PM`.
 *   ② **word** — the instruction, at the display rung: `STOP`, `LET THEM IN`.
 *   ③ **who** — the holder in bold, then the tier, then the `detail` line that
 *     carries the WHY ("Scanned 22 minutes ago at Gate A" is what settles an
 *     argument with a stranger).
 *
 * Splitting ① from ② is what lets TWO tones carry every verdict key (nineteen
 * today). It replaced
 * a four-family system (green/amber/ink/red) whose colours were never in this
 * brand's palette. At a gate "Valid" still requires a decision; "LET THEM IN"
 * does not.
 *
 * ## Redundancy contract (non-negotiable)
 *
 * Colour is never the only channel. Every state carries FOUR: fill colour · fill
 * *lightness* (PASS is the light one in both themes) · hero glyph · and the
 * state/word pair. Deuteranopes read amber and flame as two similar blocks,
 * which is why the 96px glyph and the two type lines are mandatory rather than
 * decorative.
 *
 * ## Why it paints edge to edge
 *
 * `ScreenSurface` wraps children in a padded stack; a verdict with a 16pt
 * gutter around it is not full-bleed, it is a big card. The component
 * absolutely fills its parent, so the parent must be the (unpadded) region to
 * cover.
 *
 * ## Motion — stamp C
 *
 * The tone fill, ① state, ③ who/detail and every control appear on frame 1.
 * Only two things move, and only once per verdict:
 *
 *   - the **glyph** drops in like a rubber stamp: 180ms, `cubic-bezier(.3, 0,
 *     .2, 1)` on each leg, scale 1.9 → 0.94 at 70% → 1, opacity 0 → 1 by 70%,
 *     landing about a point 60% down the glyph (see `use-verdict-stamp.ts`);
 *   - the ② **word** fades 0 → 1 over 120ms, linear, starting 120ms in.
 *
 * This is an owner override of DS D-125 ("no transition at all on the scan
 * verdict" — owner, 2026-10-06; recorded as D-150). D-125's reason still holds
 * for everything that carries the decision, which is why the fill does not
 * move: the colour change IS the verdict and it is never late. The stamp is
 * 240ms of emphasis on top of a screen that is already fully readable.
 *
 * It plays when the host passes a {@link ToneResultStateBaseProps.stampKey}
 * and an explicit `reducedMotion={false}`; anything else is the static final
 * frame (scale 1, opacity 1). It replays when `stampKey` changes, never on a
 * re-render of the same verdict. Nothing is mounted late: the word and who are
 * in the tree, with their text, from the first commit — opacity is paint only,
 * and the host's one announcement does not wait for it. No flash, no strobe,
 * no loop.
 *
 * ## Hero-glyph stroke
 *
 * DS v2 §6 pins Lucide `strokeWidth: 2`. At 96px that is ~2% of the glyph box
 * (versus ~9% at the 22px used elsewhere) and reads as a hairline outline
 * rather than a symbol. {@link HERO_STROKE_WIDTH} is a scale compensation at
 * the hero size ONLY — every other icon in the scan flow stays at 2.
 *
 * ## Announcements — a deliberate divergence from the DS
 *
 * D-125 makes the verdict the one sanctioned `role="alert"` +
 * `aria-live="assertive"` in the system. That is a WEB mechanism. On React
 * Native, live regions are Android-only (`accessibilityLiveRegion`) and
 * unreliable on iOS, so the native equivalent is the host's explicit
 * `AccessibilityInfo.announceForAccessibility`.
 *
 * This container therefore carries NO `accessibilityLiveRegion`, and hosts must
 * not add a second announcement. It used to have one, and the result was
 * TalkBack reading every verdict twice — while a live region reads in TREE
 * order, which puts the offline provenance LAST, the one ordering that
 * misleads. The host announces once: provenance, then state, then word, then
 * who.
 */

/** Hero glyph size. Drop to 80 only if a device measures negative slack. */
export const HERO_GLYPH_SIZE = 96;
/** See the docblock — a scale compensation, not a new grammar. */
export const HERO_STROKE_WIDTH = 3;

/**
 * The word's type size, by length — the native stand-in for the DS's
 * `clamp(52px, 13vw, 88px)`.
 *
 * RN `StyleSheet` has no `vw` and no `clamp`, and the alternative
 * (`adjustsFontSizeToFit`) shrinks silently and unpredictably per device. This
 * is deterministic and node-testable, which matters because the failure it
 * prevents is invisible in a simulator running at 390pt: the words are not all
 * four characters. At 56px, "CHECK THEM IN" needs ~380pt for its first line and
 * a 320pt phone offers 272pt after gutters — so it wraps to THREE lines and the
 * third is clipped by `numberOfLines={2}`. The instruction, truncated.
 *
 * Rungs are picked so the longest word at each rung still breaks into at most
 * two lines at 320pt. Exported so `__tests__/tone-result-state.test.tsx` can
 * assert every word in `@th/types`' `SCAN_VERDICTS` against it.
 */
export const verdictWordFontSize = (word: string): number =>
  word.length <= 6 ? 64 : word.length <= 11 ? 48 : 40;

type ToneResultStateBaseProps = {
  tone: VerdictTone;
  /** 96pt hero glyph. Must differ per outcome, not just per tone. */
  glyph: LucideIcon;
  /**
   * DS zone ① — what this pass IS, already composed with the time
   * (`ALREADY USED · 8:14 PM`). Build it with `@th/types`'
   * `verdictStateLine()`; never concatenate at a call site.
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
  /** Ticket code, tabular. */
  code?: string | null;
  /** DS `detail` — ≤2 lines of WHY, the line that settles an argument. */
  detail?: string | null;
  /** Offline provenance chip (zone ①) — see `MetaChip`. */
  provenance?: ReactNode;
  /**
   * Tap-to-dismiss. Deliberately absent on VALID-in-manual-mode: with
   * tap-to-dismiss there, the operator's single most practised gesture (tap
   * the screen, next person) silently SKIPS an admission — the ticket is never
   * marked, the count is wrong, and nothing tells anyone. Terminal states have
   * no such hazard, so for them dismissal is the biggest possible target.
   */
  onDismiss?: () => void;
  /** Screen-reader label for the whole block when it is tappable. */
  dismissAccessibilityLabel?: string;
  /**
   * Bottom edge (zone ⑨) — the express progress rule lands here.
   *
   * ⚠️ Positioning follows {@link ToneResultStateBaseProps.layout}, and it has
   * to. It used to be `position: absolute; bottom: 0` unconditionally, which is
   * correct ONLY for `fill` (a layer that absolutely covers its region, so
   * "bottom" is the bottom of the screen area). An `inline` host renders in
   * normal flow inside a scrolling document, where an absolutely-positioned
   * footer pins to the bottom of the STATE box and lands on top of whatever
   * content is there — it does not pin to any edge the operator can see. In
   * `inline` the footer is therefore a normal-flow last child.
   */
  footer?: ReactNode;
  /**
   * Press-and-hold on the verdict block. Express mode's "let me look at this
   * one longer" affordance: hold pauses the dwell, release restarts it FROM
   * FULL. Independent of {@link onDismiss} — a VALID state in express mode has
   * no tap-to-dismiss (that would silently skip an admission) but must still be
   * holdable.
   */
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  /**
   * `fill` (default) absolutely covers the parent region — the door mode.
   * `inline` renders in normal flow for surfaces that are a scrolling document
   * rather than a single verdict (the manual-search screen, which has a
   * keyboard, a query field and a result list on screen at once). Same tone
   * vocabulary either way; only the positioning differs.
   */
  layout?: "fill" | "inline";
  /**
   * Which verdict this is — the stamp's replay identity (see `## Motion`). A
   * NEW value stamps again; the same value on a re-render does not. Hosts
   * derive it from the outcome (verdict key + subject), never from object
   * identity, which changes whenever the screen rebuilds the same verdict.
   * Absent → no stamp.
   */
  stampKey?: string;
  /**
   * The OS reduce-motion preference, read by the HOST (this package does not
   * subscribe to it: a per-mount query would start `false` on every verdict).
   * Only an explicit `false` animates — a host that forgets the prop gets the
   * static frame, not motion the operator turned off.
   */
  reducedMotion?: boolean;
  testID?: string;
};

/**
 * ## Why `hasDetail` is an explicit boolean and not `!!children`
 *
 * It WAS `!!children`, and that shipped a dead affordance on ten of the eleven
 * states. Hosts pass a detail *component* unconditionally and let it return
 * `null` when there is nothing to show — but a React element is truthy whether
 * or not it renders anything, so `!!children` was permanently `true`. Every
 * terminal verdict grew a `surface`-coloured band and a 44pt "⌄ MORE" row
 * pointing at an empty panel, cutting a cream stripe into the full-bleed fill.
 *
 * The prop pair below is a union rather than an optional flag on purpose:
 * passing `children` without `hasDetail` is a **type error**, so the two can
 * neither drift nor be forgotten. Hosts derive the boolean from the SAME pure
 * predicate their detail component uses (see
 * `apps/scanner/src/lib/result-detail-plan.ts`).
 */
type ToneResultStateDetailProps =
  | {
      /**
       * Below-the-fold detail, rendered on `surface` (NOT the tone fill) so
       * all the small text lives at 15–16:1. Never a dismiss target — it holds
       * its own buttons.
       */
      children: ReactNode;
      /** True only when `children` will actually render something. */
      hasDetail: boolean;
    }
  | { children?: undefined; hasDetail?: false };

export type ToneResultStateProps = ToneResultStateBaseProps &
  ToneResultStateDetailProps;

export const ToneResultState = ({
  tone,
  glyph: Glyph,
  state,
  word,
  name,
  typeName,
  code,
  detail,
  provenance,
  onDismiss,
  dismissAccessibilityLabel,
  onHoldStart,
  onHoldEnd,
  children,
  hasDetail = false,
  footer,
  layout = "fill",
  stampKey,
  reducedMotion,
  testID,
}: ToneResultStateProps) => {
  const colors = useColors();
  const { fill, on } = toneColors(colors, tone);
  const wordSize = verdictWordFontSize(word);
  const showDetail = hasDetail && children != null;
  // `inline` hosts are already a scrolling document with the detail sitting
  // directly beneath in normal flow — there is no fold to hint at, and no
  // scroll view of our own to drive.
  const showMoreRow = showDetail && layout === "fill";

  const stamp = useVerdictStamp({
    stampKey,
    reducedMotion,
    glyphSize: HERO_GLYPH_SIZE,
  });

  const scrollRef = useRef<ScrollView | null>(null);
  const detailYRef = useRef(0);
  const onDetailLayout = useCallback((e: LayoutChangeEvent) => {
    detailYRef.current = e.nativeEvent.layout.y;
  }, []);
  const scrollToDetail = useCallback(() => {
    scrollRef.current?.scrollTo({ y: detailYRef.current, animated: true });
  }, []);

  const verdictBlock = (
    <View
      style={[styles.verdictBlock, showMoreRow ? styles.verdictBlockTight : null]}
    >
      {provenance ? (
        <View style={styles.provenanceSlot}>{provenance}</View>
      ) : null}

      {/*
        Sized to the glyph (`alignSelf`), so the stamp scales about the glyph
        and not about the middle of a full-width row.
      */}
      <Animated.View
        style={[styles.glyphStamp, stamp.glyphStyle]}
        testID="tone-result-glyph"
      >
        <Glyph
          size={HERO_GLYPH_SIZE}
          color={on}
          strokeWidth={HERO_STROKE_WIDTH}
          aria-hidden
        />
      </Animated.View>

      {/*
        ① STATE. Wide tracking and uppercase stand in for the DS's mono face:
        the scanner loads Montserrat only, so `--font-mono` has no native
        equivalent to switch to. Full opacity — the DS's `opacity: .85` is
        dropped here on purpose (see `tone.ts`).
      */}
      <Text
        variant="caption"
        weight="bold"
        letterSpacing={3}
        textTransform="uppercase"
        color={on}
        numberOfLines={2}
        style={styles.state}
        testID="tone-result-state-line"
      >
        {state}
      </Text>

      {/*
        ② WORD — the instruction, and the largest thing on the screen. The
        wrapper fades it (stamp C); the text itself is mounted and final.
      */}
      <Animated.View style={stamp.wordStyle} testID="tone-result-word-stamp">
        <Text
          variant="display"
          weight="black"
          textTransform="uppercase"
          color={on}
          numberOfLines={2}
          style={[
            styles.word,
            {
              fontSize: wordSize,
              lineHeight: Math.round(wordSize * 0.9),
              // The DS's -2.5px is authored against its 52–88px clamp; tracking
              // that tight at 40px closes the counters. Scaled, not copied.
              letterSpacing: -(wordSize * 0.045),
            },
          ]}
          testID="tone-result-word"
        >
          {word}
        </Text>
      </Animated.View>

      {/*
        ③ WHO — `<b>holder</b> · tier`, exactly as the DS composes it. One line,
        not two: the holder and their tier are one fact ("Dana Whitfield · GA")
        and splitting them cost a whole rung of vertical budget on a screen
        whose bottom is a control rail.
      */}
      {name || typeName ? (
        <Text
          variant="h4"
          // `h4` defaults to UPPERCASE — override it. Uppercasing a human name
          // mangles McDonald, de la Cruz, O'Brien.
          textTransform="none"
          weight="regular"
          color={on}
          numberOfLines={2}
          ellipsizeMode="tail"
          style={styles.who}
          testID="tone-result-who"
        >
          {name ? (
            <Text
              variant="h4"
              textTransform="none"
              weight="bold"
              color={on}
              style={styles.who}
            >
              {name}
            </Text>
          ) : null}
          {name && typeName ? " · " : null}
          {typeName ? (
            <Text
              variant="h4"
              textTransform="none"
              weight="regular"
              color={on}
              style={styles.who}
              testID="tone-result-type"
            >
              {typeName}
            </Text>
          ) : null}
        </Text>
      ) : null}

      {code ? (
        <Text
          variant="bodySmall"
          weight="medium"
          letterSpacing={1}
          color={on}
          style={styles.code}
          testID="tone-result-code"
        >
          {code}
        </Text>
      ) : null}

      {detail ? (
        <Text
          variant="body"
          color={on}
          // Capped at 2 lines, and the SE vertical budget was computed on 2. A
          // third line pushes the WHY below the fold on the states that need it
          // most.
          numberOfLines={2}
          style={styles.detail}
          testID="tone-result-detail-line"
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );

  /**
   * The detail block is never a dismiss target, and neither is the hint that
   * points at it. This row lives OUTSIDE the dismiss `Pressable` and carries
   * its own action — tapping "MORE" scrolls the fold into view instead of
   * throwing the result away.
   */
  const moreRow = showMoreRow ? (
    <Pressable
      onPress={scrollToDetail}
      accessibilityRole="button"
      accessibilityLabel="More detail"
      accessibilityHint="Scrolls to the detail below this result."
      style={styles.moreRow}
      testID="tone-result-more"
    >
      <ChevronDown size={14} color={on} aria-hidden />
      <Text
        variant="caption"
        weight="bold"
        letterSpacing={1.5}
        textTransform="uppercase"
        color={on}
      >
        More
      </Text>
    </Pressable>
  ) : null;

  const interactive = !!onDismiss || !!onHoldStart;

  const body = (
    <>
      {interactive ? (
        <Pressable
          onPress={onDismiss}
          onPressIn={onHoldStart}
          onPressOut={onHoldEnd}
          accessibilityRole="button"
          // One composed label so a screen-reader user gets ONE swipe
          // target, not seven. Order mirrors the visual one: state, word, who.
          accessibilityLabel={
            dismissAccessibilityLabel ??
            [state, word, name, typeName, detail].filter(Boolean).join(". ")
          }
          accessibilityHint={
            onDismiss
              ? "Dismisses this result and re-arms the camera."
              : "Press and hold to pause the automatic dismiss countdown."
          }
          testID={
            onDismiss ? "tone-result-dismiss-target" : "tone-result-hold-target"
          }
        >
          {verdictBlock}
        </Pressable>
      ) : (
        verdictBlock
      )}

      {moreRow}

      {showDetail ? (
        <View
          style={[styles.detailPanel, { backgroundColor: colors.surface }]}
          onLayout={onDetailLayout}
          testID="tone-result-detail"
        >
          {children}
        </View>
      ) : null}
    </>
  );

  return (
    <View
      style={[
        layout === "fill" ? styles.root : styles.rootInline,
        { backgroundColor: fill },
      ]}
      testID={testID}
    >
      {layout === "inline" ? (
        // Inline mode does NOT scroll: it is already inside its host's scroll
        // view, and a nested vertical ScrollView eats the parent's drag.
        <View>{body}</View>
      ) : (
        // Door mode scrolls: the verdict must fill the region even when the
        // content is short, and the below-fold detail has to be reachable when
        // it is long.
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.scrollContent,
            // The `fill` footer floats over the scroll's bottom edge, so the
            // last line of content needs somewhere to end that isn't under it.
            footer ? styles.scrollContentWithFooter : null,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {body}
        </ScrollView>
      )}

      {footer ? (
        <View
          style={[
            layout === "fill" ? styles.footerFill : styles.footerInline,
            // The fill is repeated here ON PURPOSE. In `fill` layout this box
            // floats over the scroll, and the scroll can contain the
            // `surface`-coloured detail band — so a footer with a transparent
            // background puts `on<Tone>` text over cream at ~1.2:1 the moment
            // the operator scrolls. Its own backdrop makes the measured pair
            // the same one the guard test checks.
            { backgroundColor: fill },
          ]}
          testID="tone-result-footer"
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    // DS v2: content is strict Swiss. A full-bleed verdict has no radius.
    borderRadius: 0,
  },
  rootInline: {
    borderRadius: 0,
    overflow: "hidden",
  },
  scrollContent: {
    flexGrow: 1,
  },
  scrollContentWithFooter: {
    paddingBottom: 48,
  },
  verdictBlock: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 24,
    gap: 8,
  },
  /** The MORE row supplies the bottom padding when it renders. */
  verdictBlockTight: {
    paddingBottom: 0,
  },
  provenanceSlot: {
    marginBottom: 4,
  },
  glyphStamp: {
    alignSelf: "flex-start",
  },
  state: {
    marginTop: 8,
  },
  /**
   * Size, leading and tracking are computed per word (see
   * {@link verdictWordFontSize}); only the spacing lives here.
   */
  word: {
    marginTop: 4,
    marginBottom: 4,
  },
  who: {
    fontSize: 22,
    lineHeight: 28,
  },
  code: {
    fontVariant: ["tabular-nums"],
  },
  detail: {
    marginTop: 4,
  },
  moreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    paddingHorizontal: 24,
    paddingBottom: 8,
    // ≥44pt target — it is a real control now, not a caption.
    minHeight: 44,
  },
  detailPanel: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    gap: 12,
  },
  /**
   * `fill` only. The state absolutely covers its region, so pinning the footer
   * to that region's bottom edge is what "zone ⑨" means.
   */
  footerFill: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  /**
   * `inline`. The host is a scrolling document and this box is a normal-flow
   * child of it, so there is no bottom edge to pin to — absolute positioning
   * here just lays the footer ON TOP of the state's own last rows. Normal flow
   * puts it after them, which is where it reads.
   */
  footerInline: {
    width: "100%",
  },
});
