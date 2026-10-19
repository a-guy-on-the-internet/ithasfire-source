import type { CSSProperties } from "react";

import { DURATION, SPRING_EASE as MOTION_SPRING_EASE, STANDARD_EASE } from "@/lib/motion";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens — Swiss style, ink-on-cream stub light surface.
//
// NOTE (duplication): these plain-CSS constants + the slide helper are
// pattern-copied from `place-review/_shared/tokens.ts`. The attendee form is a
// separate, much smaller flow, so we deliberately do NOT import that feature's
// `_shared` module (cross-feature coupling into another form's internals). The
// motion primitives (`DURATION`/eases) come from the canonical `@/lib/motion`
// source, not from place-review. If a third review-style form appears, promote
// these to a shared `@th/ui` module then.
// ─────────────────────────────────────────────────────────────────────────────

export const BG = "rgba(33,28,22,0.03)";
export const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";
export const BORDER_STRONG = "rgba(33,28,22,0.3)";
export const MUTED = "var(--colorMuted, #5C544A)";
export const FG = "var(--color, #211C16)";
export const ERROR_RED = "var(--danger)";

export const INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  background: BG,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: BORDER,
  borderRadius: 0,
  color: FG,
  fontSize: 16, // 16px prevents iOS auto-zoom on focus
  fontFamily: "var(--font-body, 'Montserrat', sans-serif)",
  transition: "border-color 150ms ease-out",
  boxSizing: "border-box",
  minHeight: 44, // touch-friendly
  colorScheme: "light",
};

export const MAX = {
  TEXT: 2000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slide animation — trimmed from the place-review helper.
// ─────────────────────────────────────────────────────────────────────────────

export type SlideDir = "forward" | "backward" | "none";

export const SPRING_EASE = MOTION_SPRING_EASE;
export const EXIT_EASE = STANDARD_EASE;

export const ANIM_ENTER = DURATION.medium;
export const ANIM_EXIT = DURATION.fast;

export function getSlideStyle(
  dir: SlideDir,
  phase: "enter" | "active" | "exit",
): CSSProperties {
  if (dir === "none")
    return {
      opacity: 1,
      transform: "translateX(0) scale(1)",
      filter: "blur(0px)",
    };

  const sign = dir === "forward" ? 1 : -1;

  switch (phase) {
    case "enter":
      return {
        opacity: 0,
        transform: `translateX(${sign * 72}px) scale(0.98)`,
        filter: "blur(4px)",
        transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}, filter ${ANIM_ENTER}ms ${SPRING_EASE}`,
      };
    case "active":
      return {
        opacity: 1,
        transform: "translateX(0) scale(1)",
        filter: "blur(0px)",
        transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}, filter ${ANIM_ENTER}ms ${SPRING_EASE}`,
      };
    case "exit":
      return {
        opacity: 0,
        transform: `translateX(${-sign * 44}px) scale(0.98)`,
        filter: "blur(3px)",
        transition: `opacity ${ANIM_EXIT}ms ${EXIT_EASE}, transform ${ANIM_EXIT}ms ${EXIT_EASE}, filter ${ANIM_EXIT}ms ${EXIT_EASE}`,
      };
  }
}
