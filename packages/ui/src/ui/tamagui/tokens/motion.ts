export const motionTokens = {
  duration: {
    fast: 120,
    base: 180,
    slow: 240,
    spring: 220,
  },
  easing: {
    easeOut: "cubic-bezier(0.17, 0.67, 0.45, 1)",
    easeInOut: "cubic-bezier(0.45, 0.05, 0.55, 0.95)",
    easeIn: "cubic-bezier(0.55, 0.06, 0.68, 0.19)",
  },
  spring: {
    base: {
      mass: 1,
      stiffness: 260,
      damping: 20,
    },
  },
} as const;

export type MotionDurationToken = keyof typeof motionTokens.duration;
export type MotionEasingToken = keyof typeof motionTokens.easing;
export type MotionSpringToken = keyof typeof motionTokens.spring;
