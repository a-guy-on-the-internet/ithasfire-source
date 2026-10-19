import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Aliased to `test/stubs/react-native.tsx` — see vitest.config.ts.
import { scrollCalls, timingCalls } from "react-native";

// The REAL module — see the alias note in `vitest.config.ts`.
import {
  SCAN_VERDICTS,
  SCAN_VERDICT_KEYS,
} from "@th/types/scan/verdict";

import { NativeThemeProvider } from "../theme";
import {
  HERO_GLYPH_SIZE,
  ToneResultState,
  verdictWordFontSize,
} from "../tone-result-state";
import type { VerdictTone } from "../tone";
import {
  STAMP_GLYPH_MS,
  STAMP_KNEE,
  STAMP_WORD_DELAY_MS,
  STAMP_WORD_MS,
  STAMP_WORD_TOTAL_MS,
  composeKeyframeEasing,
  stampGlyphEasing,
  stampWordEasing,
} from "../use-verdict-stamp";

/**
 * The regression this file exists for.
 *
 * `hasDetail` was `!!children`; the host always passed a `<ResultDetail/>`
 * ELEMENT and let that component return `null`. A React element is truthy
 * whether or not it renders anything, so ten of the eleven states grew a
 * `surface`-coloured band with 20pt of vertical padding and a 44pt "⌄ MORE" row
 * pointing at nothing, cutting a cream stripe into the full-bleed fill.
 *
 * 260 tests were green at the time. All of them were pure-function tests of
 * modules that had no say in what rendered. Hence this file.
 */

const Glyph = ({ size }: { size?: number }) => (
  <i data-testid="hero-glyph" data-size={size} />
);

const renderState = (
  props: Partial<Parameters<typeof ToneResultState>[0]> = {},
) =>
  render(
    <NativeThemeProvider enabledThemes={["stub"]}>
      <ToneResultState
        tone={"fail" as VerdictTone}
        glyph={Glyph as never}
        state="NOT A TICKET"
        word="STOP"
        detail="This ticket is not valid for entry."
        testID="state"
        {...(props as object)}
      />
    </NativeThemeProvider>,
  );

beforeEach(() => {
  scrollCalls.length = 0;
  timingCalls.length = 0;
});
afterEach(cleanup);

describe("ToneResultState — the below-fold affordance", () => {
  it("renders NO detail band and NO 'MORE' row for a fail state with no detail", () => {
    // `children` is passed exactly as the real host passes it: an ELEMENT
    // whose component decided there is nothing to show. That element is
    // truthy — which is the whole bug — so this only passes because the
    // boolean, not the element, decides.
    const EmptyDetail = () => null;
    renderState({ children: <EmptyDetail />, hasDetail: false });

    expect(screen.queryByTestId("tone-result-detail")).toBeNull();
    expect(screen.queryByTestId("tone-result-more")).toBeNull();
    // …and the verdict itself is still fully rendered.
    expect(screen.getByTestId("tone-result-state-line")).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-word")).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-detail-line")).toBeInTheDocument();
  });

  it("still renders nothing when `hasDetail` is false but children exist", () => {
    // Belt and braces: the boolean is authoritative, not the element.
    renderState({
      children: <span data-testid="detail-body">bulk admit</span>,
      hasDetail: false,
    });
    expect(screen.queryByTestId("tone-result-detail")).toBeNull();
    expect(screen.queryByTestId("detail-body")).toBeNull();
  });

  it("renders the detail band AND the 'MORE' row when there IS detail", () => {
    renderState({
      tone: "pass",
      state: "VALID",
      word: "LET THEM IN",
      detail: null,
      children: <span data-testid="detail-body">2 more from this order</span>,
      hasDetail: true,
    });

    expect(screen.getByTestId("tone-result-detail")).toBeInTheDocument();
    expect(screen.getByTestId("detail-body")).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-more")).toBeInTheDocument();
  });

  it("omits the 'MORE' row inline — the detail is already in the flow", () => {
    renderState({
      layout: "inline",
      children: <span data-testid="detail-body">admit</span>,
      hasDetail: true,
    });
    expect(screen.getByTestId("tone-result-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("tone-result-more")).toBeNull();
  });
});

describe("ToneResultState — dismiss semantics", () => {
  it("keeps the 'MORE' row OUT of the dismiss target", () => {
    // The hint used to sit inside the tap-to-dismiss `Pressable`, so the one
    // gesture that promised "show me more" threw the result away instead.
    const onDismiss = vi.fn();
    renderState({
      onDismiss,
      children: <span>detail</span>,
      hasDetail: true,
    });

    fireEvent.click(screen.getByTestId("tone-result-more"));
    expect(onDismiss).not.toHaveBeenCalled();
    // It scrolls the fold into view instead.
    expect(scrollCalls.length).toBe(1);

    fireEvent.click(screen.getByTestId("tone-result-dismiss-target"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders no dismiss target at all when `onDismiss` is withheld", () => {
    // VALID in manual mode: tap-to-dismiss there would let the operator's most
    // practised gesture silently SKIP an admission.
    renderState({ tone: "pass", state: "VALID", word: "LET THEM IN" });
    expect(screen.queryByTestId("tone-result-dismiss-target")).toBeNull();
  });
});

describe("ToneResultState — the DS structure (state · word · who)", () => {
  it("renders the hero glyph, the STATE line and the WORD", () => {
    // Colour is never the only channel. With two tones, the state line and the
    // word ARE the outcome — a build that dropped either would look correct in
    // a screenshot and be unusable at a door.
    renderState();
    expect(screen.getByTestId("hero-glyph")).toHaveAttribute(
      "data-size",
      String(HERO_GLYPH_SIZE),
    );
    expect(screen.getByTestId("tone-result-state-line").textContent).toBe(
      "NOT A TICKET",
    );
    expect(screen.getByTestId("tone-result-word").textContent).toBe("STOP");
  });

  it("sets the WORD at the display rung, above everything else on screen", () => {
    const { container } = renderState();
    expect(
      container.querySelector('[data-variant="display"]')?.textContent,
    ).toBe("STOP");
  });

  it("renders every line on the tone fill at FULL opacity", () => {
    // The DS's `.if-verdict__state` carries `opacity: .85`; we drop it. An
    // alpha foreground on a tone fill is the bug class this surface already
    // shipped once, and the token-pair contrast guard measures TOKENS — it
    // cannot see an alpha applied at a call site, which is exactly why this
    // assertion has to live at the render layer.
    renderState({ name: "Dana Whitfield", typeName: "GA", code: "Code ABC123" });
    for (const id of [
      "tone-result-state-line",
      "tone-result-word",
      "tone-result-who",
      "tone-result-code",
      "tone-result-detail-line",
    ]) {
      const opacity = screen.getByTestId(id).getAttribute("data-opacity");
      expect(opacity, `${id} carries opacity ${opacity}`).toBe(null);
    }
  });

  it("caps the detail line at 2 lines (the SE vertical budget)", () => {
    renderState();
    expect(screen.getByTestId("tone-result-detail-line")).toHaveAttribute(
      "data-lines",
      "2",
    );
  });

  it("puts the holder and their tier on ONE line, holder in bold", () => {
    renderState({ name: "Dana Whitfield", typeName: "General Admission" });
    const who = screen.getByTestId("tone-result-who");
    // The DS composes `<b>{holder}</b> · {tier}` as one `who` line.
    expect(who.textContent).toBe("Dana Whitfield · General Admission");
    expect(screen.getByTestId("tone-result-type").parentElement).toBe(who);
  });

  it("does not uppercase the holder name", () => {
    renderState({ name: "Marisol de la Cruz" });
    expect(screen.getByText("Marisol de la Cruz")).toHaveAttribute(
      "data-transform",
      "none",
    );
  });
});

describe("ToneResultState — the word fits", () => {
  /**
   * The measurement that made this a function rather than a constant: at 56px,
   * Montserrat Black uppercase averages ~35pt per character, so a 320pt phone
   * (272pt after the 24pt gutters) fits ~7 characters per line. "CHECK THEM IN"
   * would break to three lines and lose the third to `numberOfLines={2}` — the
   * instruction, truncated, on the one screen that exists to carry it.
   *
   * ~0.62em per character for Montserrat Black uppercase; two lines allowed.
   */
  const NARROWEST_SCREEN = 320;
  const GUTTERS = 48;
  const AVG_CHAR_EM = 0.62;

  it.each(SCAN_VERDICT_KEYS.map((k) => [k, SCAN_VERDICTS[k].word] as const))(
    "%s: %s breaks into at most two lines at 320pt",
    (_key, word) => {
      const size = verdictWordFontSize(word);
      const available = NARROWEST_SCREEN - GUTTERS;
      // Greedy wrap on spaces, the same way the layout engine does.
      let lines = 1;
      let used = 0;
      for (const chunk of word.split(" ")) {
        const w = chunk.length * size * AVG_CHAR_EM;
        const withSpace = used === 0 ? w : used + size * AVG_CHAR_EM + w;
        if (withSpace > available && used > 0) {
          lines += 1;
          used = w;
        } else {
          used = withSpace;
        }
        // A single unbreakable token wider than the screen cannot be saved by
        // wrapping at all.
        expect(w, `"${chunk}" at ${size}px`).toBeLessThanOrEqual(available);
      }
      expect(lines, `"${word}" at ${size}px`).toBeLessThanOrEqual(2);
    },
  );
});

describe("ToneResultState — announcements", () => {
  it("carries NO live region (the host announces once, ordered)", () => {
    /**
     * The DS makes the verdict the one sanctioned `role="alert"` +
     * `aria-live="assertive"` (D-125). That is a WEB mechanism: on React Native
     * live regions are Android-only and unreliable on iOS, so the host fires an
     * explicit `announceForAccessibility` instead.
     *
     * Both would be a DOUBLE announcement — which is what shipped, and TalkBack
     * read every verdict twice. Worse, a live region reads in TREE order, which
     * puts the offline provenance LAST: the one ordering that misleads, because
     * provenance qualifies everything after it.
     */
    const { container } = renderState();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

/**
 * Stamp C (owner override of D-125, 2026-10-06; D-150). The stub does not
 * animate — it records timings and resolves values at render — so these prove
 * STRUCTURE: what is mounted on frame 1, which frame a static verdict rests
 * on, and when a stamp is (re)started. How 180ms of it looks is a device
 * question.
 */
describe("ToneResultState — stamp C", () => {
  const renderStamp = (props: {
    stampKey?: string;
    reducedMotion?: boolean;
    word?: string;
  }) =>
    render(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ToneResultState
          tone={"fail" as VerdictTone}
          glyph={Glyph as never}
          state="ALREADY USED"
          word={props.word ?? "STOP"}
          detail="Scanned 22 minutes ago at Gate A"
          stampKey={props.stampKey}
          reducedMotion={props.reducedMotion}
        />
      </NativeThemeProvider>,
    );

  it("mounts every line with its final text on frame 1, glyph at the 0% keyframe", () => {
    renderStamp({ stampKey: "alreadyUsed|TKT-1", reducedMotion: false });

    // Text is present and final for assistive tech — opacity is paint only.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "ALREADY USED",
    );
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      "Scanned 22 minutes ago at Gate A",
    );
    expect(screen.getByTestId("hero-glyph")).toBeInTheDocument();

    const glyph = screen.getByTestId("tone-result-glyph");
    expect(glyph.getAttribute("data-opacity")).toBe("0");
    const transform = JSON.parse(glyph.getAttribute("data-transform") ?? "[]");
    expect(transform).toEqual([
      { translateY: expect.closeTo(-0.9 * HERO_GLYPH_SIZE * 0.1, 5) },
      { scale: 1.9 },
    ]);
    // The state line and fill are NOT wrapped: they appear instantly.
    expect(
      screen
        .getByTestId("tone-result-state-line")
        .closest(
          '[data-testid="tone-result-word-stamp"], [data-testid="tone-result-glyph"]',
        ),
    ).toBeNull();
  });

  it("starts ONE native timing per channel — no JS-chained legs or delays", () => {
    renderStamp({ stampKey: "alreadyUsed|TKT-1", reducedMotion: false });

    // Two timings, each covering its whole run. A sequence of legs or an
    // `Animated.delay` would hop back to the JS thread mid-stamp; a second
    // glyph timing here is how that regression would show.
    expect(timingCalls).toHaveLength(2);
    const [glyph, word] = timingCalls;
    expect(glyph).toMatchObject({
      toValue: 1,
      duration: STAMP_GLYPH_MS,
      easing: stampGlyphEasing,
      useNativeDriver: true,
    });
    expect(word).toMatchObject({
      toValue: 1,
      duration: STAMP_WORD_TOTAL_MS,
      easing: stampWordEasing,
      useNativeDriver: true,
    });
    expect(word).not.toHaveProperty("delay");
    expect(STAMP_WORD_TOTAL_MS).toBe(STAMP_WORD_DELAY_MS + STAMP_WORD_MS);
    expect(
      screen.getByTestId("tone-result-word-stamp").getAttribute("data-opacity"),
    ).toBe("0");
  });

  it.each([
    ["reduced motion", { stampKey: "k", reducedMotion: true }],
    ["no stampKey", { reducedMotion: false }],
    ["reducedMotion not passed", { stampKey: "k" }],
  ])(
    "rests on the static final frame with %s — no timing at all",
    (_l, props) => {
      renderStamp(props);
      expect(timingCalls).toHaveLength(0);
      const glyph = screen.getByTestId("tone-result-glyph");
      expect(glyph.getAttribute("data-opacity")).toBe("1");
      expect(JSON.parse(glyph.getAttribute("data-transform") ?? "[]")).toEqual([
        { translateY: 0 },
        { scale: 1 },
      ]);
      expect(
        screen
          .getByTestId("tone-result-word-stamp")
          .getAttribute("data-opacity"),
      ).toBe("1");
    },
  );

  it("eases EACH keyframe leg, as CSS does, not the whole run", () => {
    // A non-identity curve, because the stub's bezier is the identity and an
    // identity curve cannot tell per-leg easing from one curve over the run.
    const square = (t: number) => t * t;
    const f = composeKeyframeEasing(square, STAMP_KNEE);

    expect(f(0)).toBe(0);
    expect(f(1)).toBeCloseTo(1, 10);
    // Mid leg 1: 0.7 · (0.5)² — one curve over the run would give 0.35² = 0.1225.
    expect(f(0.35)).toBeCloseTo(0.175, 10);
    // Mid leg 2: 0.7 + 0.3 · (0.5)² — one curve would give 0.85² = 0.7225.
    expect(f(0.85)).toBeCloseTo(0.775, 10);
    // Continuous at the knee, and progress crosses 0.7 exactly there.
    expect(f(STAMP_KNEE - 1e-9)).toBeCloseTo(STAMP_KNEE, 6);
    expect(f(STAMP_KNEE)).toBe(STAMP_KNEE);

    // The glyph's curve is this composition (the timing test pins that the
    // glyph timing uses `stampGlyphEasing`).
    expect(stampGlyphEasing(0)).toBe(0);
    expect(stampGlyphEasing(STAMP_KNEE)).toBeCloseTo(STAMP_KNEE, 10);
    expect(stampGlyphEasing(1)).toBeCloseTo(1, 10);
  });

  it("holds the word at 0 for its 120ms delay, then fades linearly over 120ms", () => {
    const at = (ms: number) => stampWordEasing(ms / STAMP_WORD_TOTAL_MS);
    expect(at(0)).toBe(0);
    expect(at(60)).toBe(0);
    expect(at(STAMP_WORD_DELAY_MS)).toBe(0);
    expect(at(STAMP_WORD_DELAY_MS + STAMP_WORD_MS / 2)).toBeCloseTo(0.5, 10);
    expect(at(STAMP_WORD_TOTAL_MS)).toBeCloseTo(1, 10);
  });

  it("replays on a NEW stampKey (same outcome, different ticket) and not on a same-key re-render", () => {
    const { rerender } = renderStamp({
      stampKey: "valid|A",
      reducedMotion: false,
    });
    expect(timingCalls).toHaveLength(2);
    const first = [...timingCalls];

    // Same verdict, re-rendered (a parent rebuilt the presentation object).
    rerender(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ToneResultState
          tone={"fail" as VerdictTone}
          glyph={Glyph as never}
          state="ALREADY USED"
          word="STOP"
          stampKey="valid|A"
          reducedMotion={false}
        />
      </NativeThemeProvider>,
    );
    expect(timingCalls).toHaveLength(2);
    expect(first.every((c) => !c.stopped)).toBe(true);

    // A new verdict on the same mounted instance.
    rerender(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ToneResultState
          tone={"fail" as VerdictTone}
          glyph={Glyph as never}
          state="ALREADY USED"
          word="STOP"
          stampKey="valid|B"
          reducedMotion={false}
        />
      </NativeThemeProvider>,
    );
    expect(timingCalls).toHaveLength(4);
    // The previous stamp was stopped before the new one began.
    expect(first.every((c) => c.stopped)).toBe(true);
    // …and the new one was reset to the 0% keyframe.
    expect(timingCalls[2]?.value.getValue()).toBe(0);
  });

  it("jumps to the final frame when reduce-motion resolves true mid-stamp, and does not replay when it turns off again", () => {
    const rerenderWith = (
      rerender: (ui: ReactElement) => void,
      reducedMotion: boolean,
    ) =>
      rerender(
        <NativeThemeProvider enabledThemes={["stub"]}>
          <ToneResultState
            tone={"fail" as VerdictTone}
            glyph={Glyph as never}
            state="ALREADY USED"
            word="STOP"
            stampKey="k"
            reducedMotion={reducedMotion}
          />
        </NativeThemeProvider>,
      );

    // `useReducedMotion` starts `false` and resolves async.
    const { rerender } = renderStamp({ stampKey: "k", reducedMotion: false });
    expect(timingCalls).toHaveLength(2);

    rerenderWith(rerender, true);
    expect(timingCalls.every((c) => c.stopped)).toBe(true);
    for (const c of timingCalls) expect(c.value.getValue()).toBe(1);

    rerenderWith(rerender, false);
    expect(timingCalls).toHaveLength(2);
  });

  it("stops a running stamp on unmount", () => {
    const { unmount } = renderStamp({ stampKey: "k", reducedMotion: false });
    expect(timingCalls).toHaveLength(2);
    unmount();
    expect(timingCalls.every((c) => c.stopped)).toBe(true);
  });
});
