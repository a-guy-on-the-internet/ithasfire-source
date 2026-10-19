/**
 * FR-005 — the stats strip's WIDTH COLLAPSE LADDER, as a pure function.
 *
 * Pure (no React, no react-native) so the ladder can be asserted at 320 / 375 /
 * 430 in vitest instead of being eyeballed on one simulator. The strip is one
 * line carrying up to four things on a 375pt screen, and the naive layout
 * overflows — the design's own arithmetic puts the worst case at 456pt against
 * 375 available. A documented collapse order is the design; hoping it fits is
 * not.
 *
 * ## The ladder (design §4)
 *
 * 1. **Express is icon-only, always.** A `Zap` glyph with an accessible label.
 *    It is a mode indicator, not a metric.
 * 2. **Offline and queue are ONE chip.** They co-occur; `⌁ OFFLINE 3` says
 *    both. Never two chips.
 * 3. **At most two labelled chips.** When a third condition is live the
 *    lowest-priority label collapses to its glyph plus a count. Priority,
 *    highest first: `FAILED` → `OFFLINE/QUEUE` → capacity. `FAILED` outranks
 *    everything: it is the only one that means someone got in and the server
 *    does not know.
 * 4. **Then the counter drops its word** (`ADMITTED 128 / 450` → `128 / 450`
 *    with a `Users` glyph).
 *
 * ## About the width estimate
 *
 * `CHAR_WIDTH_PX` is the design's measured average for 12px Montserrat 700 at
 * 1.5 tracking. It is an ESTIMATE, and the renderer does not rely on it being
 * right: the counter is `flexShrink`-able with `numberOfLines={1}`, so a
 * mis-estimate degrades to an ellipsis rather than an overflow. The ladder's
 * job is to make the common cases read well, not to be a layout engine.
 */

export type CapacityBand = "normal" | "near" | "at";

/** Average glyph advance for the strip's 12px/700/1.5-tracking label type. */
export const CHAR_WIDTH_PX = 8.2;
/** Strip horizontal padding, both sides. */
const H_PADDING = 32;
/** Inline glyph box. */
const GLYPH_PX = 12;
/** Chip padding + internal gap. */
const CHIP_CHROME_PX = 22;
/** Gap between top-level strip elements. */
const ELEMENT_GAP_PX = 8;

const textWidth = (s: string): number => s.length * CHAR_WIDTH_PX;
const chipWidth = (label: string): number =>
  textWidth(label) + GLYPH_PX + CHIP_CHROME_PX;

export type StatsStripInput = {
  /** Available width in points (the screen/container width). */
  width: number;
  scanned: number;
  total: number;
  band: CapacityBand;
  /** Device has no connection. */
  offline: boolean;
  /** Rows sitting in `scan_queue`. */
  queueDepth: number;
  /**
   * FR-010 terminal drops. Wired in build step 4; the ladder needs the slot
   * now because `FAILED` is the highest-priority chip and therefore decides
   * what collapses around it.
   */
  failedCount?: number;
  /**
   * FR-004 express mode. Wired in build step 4. Icon-only by rule 1 — a mode
   * that admits people with zero taps must never be invisible.
   */
  expressEnabled?: boolean;
};

export type StatsStripChip = {
  id: "failed" | "sync";
  /** null when the chip has collapsed to glyph + count. */
  label: string | null;
  count: number;
};

export type StatsStripPlan = {
  counter: {
    /** False once the word has been dropped for width. */
    showWord: boolean;
    /** `ADMITTED` / `NEAR CAPACITY` / `AT CAPACITY`. */
    word: string;
    /** `128 / 450` — rendered tabular so it doesn't jitter as it climbs. */
    value: string;
  };
  chips: StatsStripChip[];
  showExpress: boolean;
  /** Estimated laid-out width, for tests and debugging. */
  estimatedWidth: number;
};

/** Left-block word per capacity band. */
export const CAPACITY_WORD: Record<CapacityBand, string> = {
  normal: "ADMITTED",
  near: "NEAR CAPACITY",
  at: "AT CAPACITY",
};

export function capacityBand(scanned: number, total: number): CapacityBand {
  if (total <= 0) return "normal";
  const pct = scanned / total;
  if (pct >= 1) return "at";
  if (pct >= 0.9) return "near";
  return "normal";
}

export function planStatsStrip(input: StatsStripInput): StatsStripPlan {
  const failedCount = input.failedCount ?? 0;
  const word = CAPACITY_WORD[input.band];
  const value = `${input.scanned.toLocaleString()} / ${input.total.toLocaleString()}`;

  const chips: StatsStripChip[] = [];
  if (failedCount > 0) {
    chips.push({ id: "failed", label: "FAILED", count: failedCount });
  }
  // Rule 2 — one chip, never two. Shown when either condition is live.
  if (input.offline || input.queueDepth > 0) {
    chips.push({
      id: "sync",
      label: input.offline ? "OFFLINE" : "QUEUED",
      count: input.queueDepth,
    });
  }

  const showExpress = !!input.expressEnabled;
  let showWord = true;

  const measure = (): number => {
    const counter =
      textWidth(showWord ? `${word} ${value}` : value) +
      (showWord ? 0 : GLYPH_PX + 6);
    const chipTotal = chips.reduce(
      (sum, c) =>
        sum +
        chipWidth(
          c.label
            ? `${c.label}${c.count > 0 ? ` ${c.count}` : ""}`
            : `${c.count}`,
        ),
      0,
    );
    const elements = 1 + chips.length + (showExpress ? 1 : 0);
    return (
      H_PADDING +
      counter +
      chipTotal +
      (showExpress ? GLYPH_PX : 0) +
      Math.max(0, elements - 1) * ELEMENT_GAP_PX
    );
  };

  // Step 3 — collapse the lowest-priority LABELLED chip first (`sync`).
  if (measure() > input.width) {
    const sync = chips.find((c) => c.id === "sync");
    if (sync) sync.label = null;
  }
  // Step 4 — then the counter's word.
  if (measure() > input.width) {
    showWord = false;
  }
  // Last resort — `FAILED` gives up its label too rather than overflow. It
  // keeps its glyph and count, so the signal survives even here.
  if (measure() > input.width) {
    const failed = chips.find((c) => c.id === "failed");
    if (failed) failed.label = null;
  }

  return {
    counter: { showWord, word, value },
    chips,
    showExpress,
    estimatedWidth: measure(),
  };
}
