---
name: visual-critique
description: "Objective visual-defect pass by Gemini over rendered screenshots (web, or the Expo app on a simulator): truncation, overflow, misalignment, contrast, safe-area collisions, broken responsive states. Use before shipping a visual change or when asked to check screens for defects. Taste stays with Claude."
---

# Visual Critique (Antigravity / Gemini)

Feed rendered UI screenshots to **Antigravity/Gemini** (`agy`, multimodal) for an
independent pass on **objective visual defects**. This is the one UI job that
goes to another model — per the standing split:

- **Gemini judges rendered screens** for objective defects (its multimodal strength).
- **Claude owns UI generation, design-system adherence, copy voice, and every
  taste/design decision** — and decides what to *do* with Gemini's findings.
- **GPT (Codex)** is unrelated here (grunt work + code review; see `codex-delegate`).

> **Objective defects, not taste.** Ask Gemini for verifiable problems (things
> that are *wrong*), never "does this look good." If a finding is aesthetic
> judgment, that's Claude's call, not Gemini's.

## How it runs

Everything goes through **`scripts/agy-headless.sh`** (never call `agy` directly —
its `-p` flag ordering is a footgun; the wrapper gets it right and adds the
hang/crash watchdog). `agy` has no `--image` flag: it reads screenshot **files**
by path from a directory you expose via `--images-dir`. So:

1. **Capture the screenshots yourself.**
   - **Web (phone and desktop):** delegate to the `browser-driver` agent (a
     subagent drives the same MCP tools itself, by its rules). It saves PNGs under `.playwright-mcp/<subdir>/` (the MCP servers refuse other
     paths) and uses `emulate` for phone widths, since `resize_page` stops at
     ~500px. Point `--images-dir` at that subdir.
   - **Mobile (Expo):** boot the app in a simulator, `xcrun simctl io
     booted screenshot out.png` (iOS) / `adb exec-out screencap` (Android).
   - Drop them all in one folder, one file per screen, descriptively named.
2. **Run the critique**, referencing the files by path in the prompt:

```bash
scripts/agy-headless.sh --images-dir .playwright-mcp/ui-shots -- \
  "You are reviewing mobile app screenshots for OBJECTIVE visual defects only,
   not taste. Files: .playwright-mcp/ui-shots/home.png, .playwright-mcp/ui-shots/checkout.png, ...
   For each: flag text truncation/overflow, clipped or overlapping elements,
   misalignment/broken grid, inconsistent spacing between similar elements,
   touch targets under ~44x44pt, likely WCAG-AA contrast failures, content
   colliding with the status bar/notch/home-indicator safe areas, broken or
   stretched images, and anything cut off at the edge. Per finding: screen,
   precise defect, rough location, severity (blocking/notable/minor). If a
   screen has no objective defects, say so — do not invent issues or comment on
   aesthetics. End with the 3 highest-priority fixes across all screens."
```

Output is between `---AGY-BEGIN---` / `---AGY-END---`.

## Reading the result

- **Exit 0** — critique returned; **Claude triages it**: confirm each finding
  against the screenshot/spec (Gemini can hallucinate a defect), keep the real
  ones, discard noise. The findings are input, not a verdict.
- **Exit 125** — watchdog left it running (cap/stall); read the diagnosis, then
  raise `--cap-seconds` or kill the printed PID. Inconclusive.
- **Exit 1** — `agy` errored; log path is on stderr.

## Notes

- Model: the wrapper defaults to the strongest Gemini tier on the plan
  (currently `"Gemini 3.1 Pro (High)"` — standing preference: critiques run on
  the highest model available). Pass `--model` with an exact string from
  `agy models` (has spaces/parens — quote it) to downshift to a Flash tier for
  cheap bulk passes.
- Auth: Antigravity account (free individual tier), browser sign-in via bare
  `agy`. No `GOOGLE_APPLICATION_CREDENTIALS` involvement.
- Gemini can be confidently wrong about a defect — always verify against the
  actual screenshot before acting. Diversity has a triage tax.
