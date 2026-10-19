/**
 * FR-013 — the action row's labels must not clip at 320px.
 *
 * Observed at 320×640: the primary read **"DISMISS AND …"**.
 *
 * ## Honesty about what this can and cannot prove
 *
 * jsdom has no layout engine — `scrollWidth`/`clientWidth` are 0 for
 * everything — so "is the rendered label truncated" is not a question this
 * suite can ask. What it can do is measure the labels against the budget the
 * page arithmetic gives them, using an estimator that is ANCHORED: the first
 * test below requires the estimator to reject the exact string that was seen
 * clipping. An estimator that passes the known-bad label would prove nothing
 * about the ones we ship, so it is checked against ground truth before it is
 * trusted with anything else.
 *
 * The pixel-accurate confirmation is a browser pass at 320, not this file.
 */
import { describe, expect, it } from "vitest";

import {
  NARROW_LABEL_BUDGET_PX,
  PAIRED_LABEL_BUDGET_PX,
  PRIMARY_ACTION_MIN_WIDTH,
  SCAN_ACTION_LABELS,
  estimateActionLabelWidth,
} from "../scan-action-labels";

/** The two labels this change removed, kept as calibration fixtures. */
const OBSERVED_TRUNCATING = "DISMISS AND SCAN NEXT";
const ALSO_TOO_WIDE = "CHECK IN VOLUNTEER";

describe("the estimator is anchored to a real defect", () => {
  it("calls the label that WAS observed clipping too wide", () => {
    // If this ever passes, the estimator has drifted optimistic and every
    // assertion below is worthless.
    const measured = estimateActionLabelWidth(OBSERVED_TRUNCATING);
    expect(
      measured,
      `"${OBSERVED_TRUNCATING}" measured ${Math.round(measured)}px against a ` +
        `${NARROW_LABEL_BUDGET_PX}px budget — it was SEEN clipping at 320, so ` +
        `an estimator that fits it is wrong`,
    ).toBeGreaterThan(NARROW_LABEL_BUDGET_PX);
  });

  it("also rejects the check-in label, which had the same problem unobserved", () => {
    expect(estimateActionLabelWidth(ALSO_TOO_WIDE)).toBeGreaterThan(
      NARROW_LABEL_BUDGET_PX,
    );
  });

  it("scales with length and ignores surrounding whitespace", () => {
    expect(estimateActionLabelWidth("AB")).toBeGreaterThan(
      estimateActionLabelWidth("A"),
    );
    expect(estimateActionLabelWidth("  Scan next  ")).toBe(
      estimateActionLabelWidth("Scan next"),
    );
    expect(estimateActionLabelWidth("")).toBe(0);
  });
});

describe("every shipped label fits", () => {
  const labels = Object.entries(SCAN_ACTION_LABELS);

  it.each(labels)("%s fits a stacked full-width button at 320", (key, label) => {
    const measured = estimateActionLabelWidth(label);
    expect(
      measured,
      `${key} ("${label.toUpperCase()}") measured ${Math.round(measured)}px ` +
        `against ${NARROW_LABEL_BUDGET_PX}px`,
    ).toBeLessThanOrEqual(NARROW_LABEL_BUDGET_PX);
  });

  it.each(labels)(
    "%s fits a primary pinned at its minimum width",
    (key, label) => {
      // The narrower of the two cases: a primary sharing a row with a secondary
      // sits at `minWidth` before flex grows it. This is the budget the OLD
      // `minWidth: 140` failed — 68px of label — which is why that number moved
      // as part of this fix rather than the label alone.
      const measured = estimateActionLabelWidth(label);
      expect(
        measured,
        `${key} ("${label.toUpperCase()}") measured ${Math.round(measured)}px ` +
          `against ${PAIRED_LABEL_BUDGET_PX}px`,
      ).toBeLessThanOrEqual(PAIRED_LABEL_BUDGET_PX);
    },
  );

  it("the old minWidth would NOT have been enough for the new labels either", () => {
    // Documents why 140 → 180. At 140 the label budget is 68px, and "CHECK IN"
    // does not fit that — so shortening the copy alone would have left a band of
    // viewports (~352-390px) still clipping.
    expect(estimateActionLabelWidth(SCAN_ACTION_LABELS.checkIn)).toBeGreaterThan(
      140 - 72,
    );
    expect(PRIMARY_ACTION_MIN_WIDTH).toBeGreaterThan(140);
  });

  it("keeps the labels short enough to stay short", () => {
    // A cheap tripwire for the next person adding a label: the budget is real
    // but it is an estimate, so leave headroom rather than landing on 165px.
    for (const [key, label] of labels) {
      expect(
        estimateActionLabelWidth(label),
        `${key} has no headroom left`,
      ).toBeLessThan(PAIRED_LABEL_BUDGET_PX * 0.9);
    }
  });
});

describe("the labels still say what the button does", () => {
  it("names the outcome, not the mechanism", () => {
    expect(SCAN_ACTION_LABELS.dismiss).toBe("Scan next");
    // The word an operator reads first should be the thing that happens.
    expect(SCAN_ACTION_LABELS.dismiss.toLowerCase()).not.toContain("dismiss");
  });

  it("does not repeat what the verdict already shouts", () => {
    // The verdict's state line already reads VOLUNTEER and the who line carries
    // the role; the button does not need the word a third time.
    expect(SCAN_ACTION_LABELS.checkIn.toLowerCase()).not.toContain("volunteer");
  });
});
