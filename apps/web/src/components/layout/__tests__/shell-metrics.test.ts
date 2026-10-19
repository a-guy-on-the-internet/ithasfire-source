import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SHELL_GUTTER,
  SHELL_GUTTER_MOBILE,
} from "@/components/layout/shell-metrics";

// The footer's Swiss grid is plain DOM cells, so it cannot read the TS
// constants at the breakpoint the other two bands use — it reads
// `--shell-gutter` from `globals.css` instead. That mirror is the one place
// this system can silently drift back into three different grids, and the
// symptom (a band 16px off across 600–640px) is invisible to every unit test
// in the app because they all mock Tamagui's styled away.
const CSS = readFileSync(
  join(__dirname, "..", "..", "..", "app", "globals.css"),
  "utf8",
);

const gutterIn = (source: string): number | null => {
  const match = /--shell-gutter:\s*(\d+)px/.exec(source);
  return match ? Number(match[1]) : null;
};

describe("shell grid metrics", () => {
  it("publishes the mobile gutter as the base value of --shell-gutter", () => {
    const base = CSS.split("@media (min-width: 641px)")[0];
    const rule = base.slice(base.lastIndexOf(".th-shell-band"));
    expect(gutterIn(rule)).toBe(SHELL_GUTTER_MOBILE);
  });

  it("switches --shell-gutter to the desktop value at $gtSm (641px)", () => {
    const index = CSS.indexOf(".th-shell-band");
    const scoped = CSS.slice(index);
    const media = scoped.slice(scoped.indexOf("@media (min-width: 641px)"));
    expect(gutterIn(media)).toBe(SHELL_GUTTER);
  });
});
