import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Aliased to `test/stubs/react-native.tsx` — see vitest.config.ts.
import { timingCalls } from "react-native";

import {
  ExpressDwellFooter,
  type ExpressDwellPhase,
} from "../express-dwell-footer";
import { NativeThemeProvider } from "../theme";
import { ToneResultState } from "../tone-result-state";

/**
 * FR-004 zone ⑨ — what a jsdom render CAN honestly prove about the dwell.
 *
 * Not the 1.2s of motion (Yoga is not running and neither is the RAF loop) —
 * the STRUCTURE and the WORDS, which is where the real hazards are:
 *
 *   - a frozen bar with no word looks exactly like a broken one, so each
 *     non-running phase must say what it is;
 *   - reduced motion must produce a static full-width rule AND a word, never a
 *     silently missing indicator;
 *   - a hold must not restart the animation (release does that);
 *   - the footer must not be `position: absolute` in `inline` layout, which is
 *     the bug this component's host slot shipped with.
 */

const Glyph = ({ size }: { size?: number }) => (
  <i data-testid="hero-glyph" data-size={size} />
);

const renderFooter = (props: Partial<ExpressDwellFooterProps> = {}) =>
  render(
    <NativeThemeProvider enabledThemes={["stub"]}>
      <ExpressDwellFooter
        tone="pass"
        phase="running"
        durationMs={1200}
        reducedMotion={false}
        cycleKey={1}
        testID="dwell"
        {...props}
      />
    </NativeThemeProvider>,
  );

type ExpressDwellFooterProps = Parameters<typeof ExpressDwellFooter>[0];

beforeEach(() => {
  timingCalls.length = 0;
});
afterEach(cleanup);

describe("ExpressDwellFooter", () => {
  it("renders the rule and starts a timing for the dwell while running", () => {
    renderFooter();
    expect(screen.getByTestId("express-dwell-rule")).toBeInTheDocument();
    expect(timingCalls).toHaveLength(1);
    expect(timingCalls[0]).toMatchObject({ toValue: 0, duration: 1200 });
    // Motion mode: the moving rule IS the message, so no word competes with it.
    expect(screen.queryByTestId("express-dwell-label")).toBeNull();
  });

  it("under reduced motion renders a STATIC full-width rule plus the word", () => {
    renderFooter({ reducedMotion: true });
    const rule = screen.getByTestId("express-dwell-rule");
    expect(rule).toBeInTheDocument();
    expect(rule.getAttribute("data-width")).toBe("100%");
    // No animation is started at all — the countdown becomes a text state.
    expect(timingCalls).toHaveLength(0);
    expect(screen.getByTestId("express-dwell-label")).toHaveTextContent(
      "AUTO-ADMITTED · DISMISSING",
    );
  });

  it("says HOLDING while held, and does not start a new timing", () => {
    renderFooter({ phase: "holding" as ExpressDwellPhase });
    expect(screen.getByTestId("express-dwell-label")).toHaveTextContent(
      "HOLDING — RELEASE TO CONTINUE",
    );
    // Restart happens on RELEASE (the host bumps `cycleKey`), never on press.
    expect(timingCalls).toHaveLength(0);
  });

  it("says AUTO-DISMISS PAUSED when a screen reader has suspended the dwell", () => {
    renderFooter({ phase: "paused" as ExpressDwellPhase });
    expect(screen.getByTestId("express-dwell-label")).toHaveTextContent(
      "AUTO-DISMISS PAUSED",
    );
    expect(timingCalls).toHaveLength(0);
  });

  it("restarts the timing when the cycle key changes (release restarts from full)", () => {
    const { rerender } = renderFooter({ cycleKey: 1 });
    expect(timingCalls).toHaveLength(1);
    rerender(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ExpressDwellFooter
          tone="pass"
          phase="running"
          durationMs={1200}
          reducedMotion={false}
          cycleKey={2}
          testID="dwell"
        />
      </NativeThemeProvider>,
    );
    expect(timingCalls).toHaveLength(2);
  });
});

describe("ToneResultState footer slot", () => {
  const renderWithFooter = (layout: "fill" | "inline") =>
    render(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ToneResultState
          tone="pass"
          glyph={Glyph as never}
          state="VALID"
          word="LET THEM IN"
          name="Marisol Delgado-Rivera"
          layout={layout}
          footer={
            <ExpressDwellFooter
              tone="pass"
              phase="running"
              durationMs={1200}
              reducedMotion={false}
              cycleKey={1}
            />
          }
        />
      </NativeThemeProvider>,
    );

  it("pins the footer absolutely in `fill` — that region HAS a bottom edge", () => {
    renderWithFooter("fill");
    expect(screen.getByTestId("tone-result-footer")).toHaveStyle({
      position: "absolute",
    });
  });

  it("keeps the footer in NORMAL FLOW in `inline`", () => {
    // The regression: `footer` was `position: absolute; bottom: 0`
    // unconditionally. In `inline` the state is a normal-flow child of a
    // scrolling document, so an absolute footer does not pin to any edge the
    // operator can see — it lands ON TOP of the state's own last rows.
    renderWithFooter("inline");
    const footer = screen.getByTestId("tone-result-footer");
    expect(footer.style.position).not.toBe("absolute");
  });
});

describe("ToneResultState hold gesture", () => {
  it("exposes a hold target when `onHoldStart` is given without `onDismiss`", () => {
    const events: string[] = [];
    render(
      <NativeThemeProvider enabledThemes={["stub"]}>
        <ToneResultState
          tone="pass"
          glyph={Glyph as never}
          state="VALID"
          word="LET THEM IN"
          onHoldStart={() => events.push("in")}
          onHoldEnd={() => events.push("out")}
        />
      </NativeThemeProvider>,
    );
    // A VALID state in express mode must NOT be tap-to-dismiss — tapping the
    // screen is the operator's most practised gesture and would silently skip
    // the next admission.
    expect(screen.queryByTestId("tone-result-dismiss-target")).toBeNull();
    expect(screen.getByTestId("tone-result-hold-target")).toBeInTheDocument();
  });
});
