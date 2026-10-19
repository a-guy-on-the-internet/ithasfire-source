/**
 * Coverage guard for the default-OFF `waitlists` feature gate.
 *
 * `WaitlistJoinForm` is rendered from THREE places (the event body plus the
 * PASSWORD and APPLICATION gate wrappers). During this change one of them was
 * initially missed, which would have left the join affordance live on exactly
 * the events most likely to have a waitlist open. Per-component render tests
 * can't catch that class of bug — they only cover the sites someone remembered
 * to write a test for — so this asserts the invariant over the SOURCE: every
 * module that renders the form must also resolve the `waitlists` gate.
 *
 * If you add a new render site, gate it (`gates?.waitlists === true`) rather
 * than adding an exemption here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

/** The component module itself, and tests, are not render sites. */
const EXEMPT = [
  join("components", "events", "WaitlistJoinForm.tsx"),
  `${join("__tests__")}${"/"}`,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("`waitlists` gate covers every WaitlistJoinForm render site", () => {
  const renderSites = walk(SRC_ROOT).filter((file) => {
    const rel = file.slice(SRC_ROOT.length + 1);
    if (EXEMPT.some((frag) => rel.includes(frag))) return false;
    if (rel.includes(".test.")) return false;
    return readFileSync(file, "utf8").includes("<WaitlistJoinForm");
  });

  it("finds the known render sites (guards against a silent zero-match pass)", () => {
    // A zero-length list would make the assertion below vacuously true — the
    // classic fake gate. Pin the count so a moved/renamed file fails loudly.
    expect(renderSites.length).toBeGreaterThanOrEqual(3);
  });

  it.each(
    walk(SRC_ROOT)
      .filter((file) => {
        const rel = file.slice(SRC_ROOT.length + 1);
        if (EXEMPT.some((frag) => rel.includes(frag))) return false;
        if (rel.includes(".test.")) return false;
        return readFileSync(file, "utf8").includes("<WaitlistJoinForm");
      })
      .map((file) => [file.slice(SRC_ROOT.length + 1), file] as const),
  )("%s resolves the waitlists gate", (_rel, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("useFeatureGates");
    // Fail-CLOSED comparison: `gates?.waitlists` alone would render the form
    // when the gates are still loading (undefined is falsy, but a truthy-check
    // on a Partial invites `!== false` style regressions).
    expect(source).toContain("gates?.waitlists === true");
  });
});
