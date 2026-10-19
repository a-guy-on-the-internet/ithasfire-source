/**
 * Stamp C — the verdict's entry motion (owner, 2026-10-06; DS D-150 overriding
 * D-125). jsdom runs no animations and evaluates no media queries, so this
 * suite guards what CAN regress silently at this level:
 *
 *   - the glyph and the word carry the stamp hooks, and nothing else does;
 *   - the live region's text is complete on the first render (the fade is
 *     visual only — a screen reader must hear the verdict at once);
 *   - the replay identity: a NEW verdict re-inserts the animated nodes, a
 *     re-derived SAME verdict keeps them;
 *   - the reduced-motion rule exists for both animated classes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ReactElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IthasFireProvider } from "@th/ui";
import type { ResolveScanPayloadOutput } from "@th/core/use-cases/scanning";

import {
  ScanResultState,
  useScanVerdict,
  verdictSignature,
} from "../ScanResultState";
import { ToneResultState } from "../ToneResultState";
import stampStyles from "../tone-result-stamp.module.css";

const render = (ui: ReactElement) =>
  rtlRender(<IthasFireProvider>{ui}</IthasFireProvider>);

const wrap = (ui: ReactElement) => <IthasFireProvider>{ui}</IthasFireProvider>;

const noop = () => {};

const ticket = (over: Record<string, unknown> = {}): ResolveScanPayloadOutput =>
  ({
    kind: "ticket",
    ticketId: "tk_id",
    ticketCode: "tk_9f3a2b7c1d4e",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hu_1",
    holderDisplay: "Marisol Delgado-Rivera",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    ...over,
  }) as ResolveScanPayloadOutput;

function Harness({
  result,
  admitted = false,
  canCheckInVolunteer = true,
}: {
  result: ResolveScanPayloadOutput;
  admitted?: boolean;
  canCheckInVolunteer?: boolean;
}) {
  const verdict = useScanVerdict({
    result,
    override: null,
    admitted,
    selectedEventName: "Autumn Showcase",
    canCheckInVolunteer,
  });
  if (!verdict) return null;
  return (
    <ScanResultState
      verdict={verdict}
      onDismiss={noop}
      onAdmitTicket={noop}
      admitPending={false}
      onCheckInVolunteer={noop}
      checkInPending={false}
      onScanCrossTicket={noop}
      resolvePending={false}
    />
  );
}

describe("stamp hooks", () => {
  it("resolves the CSS-module class names (a missing mapping would make every class assertion below vacuous)", () => {
    expect(stampStyles.glyph).toEqual(expect.any(String));
    expect(stampStyles.glyph).not.toBe("");
    expect(stampStyles.word).toEqual(expect.any(String));
    expect(stampStyles.word).not.toBe("");
    expect(stampStyles.glyph).not.toBe(stampStyles.word);
  });

  it("puts the drop on the glyph and the fade on the word, and on nothing else", () => {
    render(
      <ToneResultState
        tone="fail"
        glyph="Ban"
        state="ALREADY USED · 8:14 PM"
        word="STOP"
        name="Dana Whitfield"
        typeName="GA"
        code="tk_1"
        detail="Scanned at 21:14 — already admitted."
        testID="band"
      />,
    );
    expect(screen.getByTestId("tone-result-glyph")).toHaveClass(stampStyles.glyph);
    expect(screen.getByTestId("tone-result-word")).toHaveClass(stampStyles.word);

    // The fill, the state line and the who/detail lines paint on frame 1.
    const band = screen.getByTestId("band");
    const animated = band.querySelectorAll(
      `.${stampStyles.glyph}, .${stampStyles.word}`,
    );
    expect(animated).toHaveLength(2);
    for (const id of [
      "band",
      "tone-result-state-line",
      "tone-result-who",
      "tone-result-code",
      "tone-result-detail-line",
    ]) {
      const el = screen.getByTestId(id);
      expect(el).not.toHaveClass(stampStyles.glyph);
      expect(el).not.toHaveClass(stampStyles.word);
    }
  });
});

describe("the alert is complete on the first render", () => {
  it("holds state, word, holder and detail as final text, with nothing hidden", () => {
    render(
      <ToneResultState
        tone="pass"
        glyph="CheckCircle2"
        state="VALID · 8:14 PM"
        word="LET THEM IN"
        name="Dana Whitfield"
        typeName="GA"
        detail="First scan tonight."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("VALID · 8:14 PM");
    expect(alert).toHaveTextContent("LET THEM IN");
    expect(alert).toHaveTextContent("Dana Whitfield · GA");
    expect(alert).toHaveTextContent("First scan tonight.");

    // The word animates opacity only: it is a real, exposed heading.
    const word = screen.getByRole("heading", { level: 1, name: "LET THEM IN" });
    expect(word).not.toHaveAttribute("aria-hidden");
    expect(word.style.visibility).not.toBe("hidden");
    expect(word.style.display).not.toBe("none");

    // The glyph is decorative and stays out of the accessibility tree.
    expect(screen.getByTestId("tone-result-glyph")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("replay identity", () => {
  it("is the verdict key plus the subject", () => {
    // A cheap pin on the shared definition — the haptic cue uses it too.
    const result = ticket();
    let sig = "";
    function Probe() {
      const v = useScanVerdict({
        result,
        override: null,
        selectedEventName: null,
        canCheckInVolunteer: true,
      });
      sig = v ? verdictSignature(v) : "";
      return null;
    }
    render(<Probe />);
    expect(sig).toMatch(/\|tk_9f3a2b7c1d4e$/);
  });

  it("keeps the animated nodes across a re-render of the SAME verdict", () => {
    const result = ticket();
    const { rerender } = render(<Harness result={result} />);
    const glyph = screen.getByTestId("tone-result-glyph");
    const word = screen.getByTestId("tone-result-word");

    // The owner query settling re-derives the verdict object without changing
    // what the operator is told. That must not replay the stamp.
    rerender(wrap(<Harness result={result} canCheckInVolunteer={false} />));
    expect(screen.getByTestId("tone-result-glyph")).toBe(glyph);
    expect(screen.getByTestId("tone-result-word")).toBe(word);

    // A fresh envelope for the same pass (same key, same subject) is the same
    // verdict too.
    rerender(wrap(<Harness result={ticket()} canCheckInVolunteer={false} />));
    expect(screen.getByTestId("tone-result-glyph")).toBe(glyph);
    expect(screen.getByTestId("tone-result-word")).toBe(word);
  });

  it("re-inserts them for a new pass with the SAME outcome (a cross-ticket jump)", () => {
    const { rerender } = render(<Harness result={ticket()} />);
    const glyph = screen.getByTestId("tone-result-glyph");
    const word = screen.getByTestId("tone-result-word");
    const wordText = word.textContent;

    rerender(wrap(<Harness result={ticket({ ticketCode: "tk_other" })} />));
    // Same word, same glyph, new pass: it must stamp again.
    expect(screen.getByTestId("tone-result-word").textContent).toBe(wordText);
    expect(screen.getByTestId("tone-result-glyph")).not.toBe(glyph);
    expect(screen.getByTestId("tone-result-word")).not.toBe(word);
  });

  it("re-inserts them when the admit lands on the card in place", () => {
    const scanned = ticket({ status: "SCANNED" });
    const { rerender } = render(<Harness result={scanned} />);
    const glyph = screen.getByTestId("tone-result-glyph");
    const word = screen.getByTestId("tone-result-word");

    rerender(wrap(<Harness result={scanned} admitted />));
    expect(screen.getByTestId("tone-result-glyph")).not.toBe(glyph);
    expect(screen.getByTestId("tone-result-word")).not.toBe(word);
  });

  it("replays because of the key, not by accident (control: no stampKey, no re-insert)", () => {
    // Without this, the "re-inserts" cases above could pass on some unrelated
    // remount. Same band, word text changed, no key: React reuses the nodes and
    // a CSS animation would NOT restart.
    const band = (word: string, stampKey?: string) => (
      <ToneResultState
        tone="pass"
        glyph="CheckCircle2"
        state="VALID"
        word={word}
        stampKey={stampKey}
      />
    );
    const { rerender } = render(band("LET THEM IN"));
    const glyph = screen.getByTestId("tone-result-glyph");
    const word = screen.getByTestId("tone-result-word");
    rerender(wrap(band("DONE")));
    expect(screen.getByTestId("tone-result-glyph")).toBe(glyph);
    expect(screen.getByTestId("tone-result-word")).toBe(word);

    rerender(wrap(band("DONE", "a")));
    const keyedGlyph = screen.getByTestId("tone-result-glyph");
    rerender(wrap(band("DONE", "b")));
    expect(screen.getByTestId("tone-result-glyph")).not.toBe(keyedGlyph);
  });

  it("does not remount the live region itself", () => {
    // Only the glyph and word are keyed: the alert container persists, so the
    // announcement behaviour of an in-place change is what it was before.
    const { rerender } = render(<Harness result={ticket()} />);
    const region = screen.getByTestId("tone-result-live-region");
    rerender(wrap(<Harness result={ticket({ ticketCode: "tk_other" })} />));
    expect(screen.getByTestId("tone-result-live-region")).toBe(region);
  });
});

describe("reduced motion", () => {
  // jsdom evaluates no media queries, so the rule is checked in the stylesheet
  // itself: both animated classes, inside the reduced-motion block, with the
  // animation removed. That is the whole static-final-frame contract — the
  // classes set no transform/opacity outside their keyframes.
  const css = readFileSync(
    join(__dirname, "..", "tone-result-stamp.module.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("removes both animations under prefers-reduced-motion: reduce", () => {
    const block = css.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/,
    );
    expect(block).not.toBeNull();
    const inner = block![1];
    expect(inner).toMatch(/\.glyph\b/);
    expect(inner).toMatch(/\.word\b/);
    expect(inner).toMatch(/animation:\s*none/);
  });

  it("keeps the resting state free of transform and opacity outside the keyframes", () => {
    const outsideKeyframes = css
      .replace(/@keyframes[\s\S]*?\}\s*\}/g, "")
      .replace(/@media[\s\S]*?\}\s*\}/g, "");
    expect(outsideKeyframes).not.toMatch(/(^|[\s;{])transform:/);
    expect(outsideKeyframes).not.toMatch(/(^|[\s;{])opacity:/);
  });
});
