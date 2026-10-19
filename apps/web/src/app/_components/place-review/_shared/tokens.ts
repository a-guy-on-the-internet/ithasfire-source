import type { CSSProperties } from "react";

import {
  DURATION,
  SPRING_EASE as MOTION_SPRING_EASE,
  STANDARD_EASE,
} from "@/lib/motion";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens (plain CSS — Swiss style, ink-on-cream stub light surface)
// ─────────────────────────────────────────────────────────────────────────────

export const BG = "rgba(33,28,22,0.03)";
export const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";
export const BORDER_STRONG = "rgba(33,28,22,0.3)";
export const MUTED = "var(--colorMuted, #5C544A)";
export const FG = "var(--color, #211C16)";
export const ERROR_RED = "var(--danger)";

// ─────────────────────────────────────────────────────────────────────────────
// Shared input / chip styles
// ─────────────────────────────────────────────────────────────────────────────

export const INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: BG,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: BORDER,
  borderRadius: 0,
  color: FG,
  fontSize: 16, // 16px prevents iOS auto-zoom on focus
  fontFamily: "var(--font-body, Inter, sans-serif)",
  transition: "border-color 150ms ease-out",
  boxSizing: "border-box" as const,
  minHeight: 44, // touch-friendly
  colorScheme: "light", // native <select>/<option> use light chrome (Windows)
};

// ─────────────────────────────────────────────────────────────────────────────
// Max-length limits — mirror Zod / Prisma constraints
// ─────────────────────────────────────────────────────────────────────────────

export const MAX = {
  PLACE_NAME: 200,
  CITY: 100,
  NAME: 120,
  GENRE: 200,
  DETAIL: 500,
  COMMENT: 1000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slide animation — spring-like overshoot transitions
// All durations + easings come from the centralized motion module
// (`@/lib/motion`). Add new values there, not here.
// ─────────────────────────────────────────────────────────────────────────────

export type SlideDir = "forward" | "backward" | "none";

export const SPRING_EASE = MOTION_SPRING_EASE;
export const EXIT_EASE = STANDARD_EASE;

export const ANIM_ENTER = DURATION.medium;
export const ANIM_EXIT = DURATION.fast;
export const ANIM_DURATION = ANIM_EXIT;

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
        transform: `translateX(${sign * 80}px) scale(0.97)`,
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
        transform: `translateX(${-sign * 50}px) scale(0.98)`,
        filter: "blur(3px)",
        transition: `opacity ${ANIM_EXIT}ms ${EXIT_EASE}, transform ${ANIM_EXIT}ms ${EXIT_EASE}, filter ${ANIM_EXIT}ms ${EXIT_EASE}`,
      };
  }
}
