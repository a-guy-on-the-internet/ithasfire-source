import { useMemo, type CSSProperties } from "react";

type RectLike = {
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
  left?: number | null;
};

type Props = {
  color?: string;
  hitSlop?: RectLike | null | undefined;
};

const DEV_MODE = process.env.NODE_ENV !== "production";

let debugEnabled = false;

const coerceNumber = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const applyHitSlop = (hitSlop?: RectLike | null) => ({
  top: coerceNumber(hitSlop?.top),
  right: coerceNumber(hitSlop?.right),
  bottom: coerceNumber(hitSlop?.bottom),
  left: coerceNumber(hitSlop?.left),
});

export function PressabilityDebugView({
  color = "mediumspringgreen",
  hitSlop,
}: Props) {
  if (!DEV_MODE || !isEnabled()) {
    return null;
  }

  const offsets = useMemo(() => applyHitSlop(hitSlop), [hitSlop]);

  const style: CSSProperties = {
    position: "absolute",
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: color,
    backgroundColor: color,
    opacity: 0.15,
    top: -offsets.top,
    right: -offsets.right,
    bottom: -offsets.bottom,
    left: -offsets.left,
    pointerEvents: "none",
  };

  return <div style={style} />;
}

export function isEnabled(): boolean {
  return DEV_MODE ? debugEnabled : false;
}

export function setEnabled(value: boolean): void {
  if (DEV_MODE) {
    debugEnabled = value;
  }
}
