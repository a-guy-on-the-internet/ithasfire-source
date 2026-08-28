---
name: visual-critique
description: "Get an independent visual-defect critique of rendered UI from Google Antigravity/Gemini (multimodal). Use when you have rendered screens (web at a mobile/desktop viewport, or the Expo app on a simulator) and want a second pair of eyes on OBJECTIVE visual defects — truncation, overflow, misalignment, contrast/a11y, safe-area collisions, broken responsive states. Use when asked to 'check the UI for defects', 'review these screens', 'have Gemini look at the layout', or before shipping a visual change. NOT for subjective taste — Claude owns that."
---

# Visual Critique (Antigravity / Gemini)

Feed rendered UI screenshots to **Antigravity/Gemini** (`agy`, multimodal) for an
independent pass on **objective visual defects**. This is the one UI job that
goes to another model — per the standing split:

- **Gemini judges rendered screens** for objective defects (its multimodal strength).
- **Claude owns UI generation, design-system adherence, copy voice, and every
  taste/design decision** — and decides what to *do* with Gemini's findings.
- **GPT-5.5** is unrelated here (grunt work + code review; see `codex-delegate`).

> **Objective defects, not taste.** Ask Gemini for verifiable problems (things
> that are *wrong*), never "does this look good." If a finding is aesthetic
> judgment, that's Claude's call, not Gemini's.

## How it runs

Everything goes through **`scripts/agy-headless.sh`** (never call `agy` directly —
its `-p` flag ordering is a footgun; the wrapper gets it right and adds the
hang/crash watchdog). `agy` has no `--image` flag: it reads screenshot **files**
by path from a directory you expose via `--images-dir`. So:

1. **Capture the screenshots yourself.**
   - **Web-mobile:** Chrome DevTools MCP — resize to a phone viewport
     (e.g. 390×844), navigate the route, `take_screenshot` to a PNG.
   - **Web-desktop:** same, at a desktop width.
   - **Mobile-mobile (Expo):** boot the app in a simulator, `xcrun simctl io
     booted screenshot out.png` (iOS) / `adb exec-out screencap` (Android).
   - Drop them all in one folder, one file per screen, descriptively named.
2. **Run the critique**, referencing the files by path in the prompt:

```bash
scripts/agy-headless.sh --images-dir /tmp/ui-shots -- \
  "You are reviewing mobile app screenshots for OBJECTIVE visual defects only,
   not taste. Files: /tmp/ui-shots/home.png, /tmp/ui-shots/checkout.png, ...
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
