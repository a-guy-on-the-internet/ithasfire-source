"use client";

import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, type LayoutChangeEvent } from "react-native";
import type { ViewStyle } from "react-native";
import { createPortal } from "react-dom";
import { AnimatePresence, Stack, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";

type TooltipPlacement = "top" | "bottom" | "left" | "right";

type TooltipAlign = "start" | "center" | "end";

type TooltipTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "inverse";

const POINTER_OVERLAP = 1;
const BUBBLE_BORDER_WIDTH = 1;
const FLOATING_MOTION_OFFSET = 4;
const ALIGNMENT_EDGE_INSET = 20;
// Grace period that keeps an uncontrolled tooltip open while the pointer
// crosses the gap from the anchor to the (portalled) bubble, so the bubble is
// reachable/copyable. Consumers driving a controlled tooltip reuse the same
// delay via the exported constant.
export const TOOLTIP_CLOSE_DELAY_MS = 120;

const TooltipRoot = styled(Stack, {
  name: "TooltipRoot",
  display: "inline-flex",
  position: "relative",
});

const TooltipAnchorFrame = styled(Stack, {
  name: "TooltipAnchor",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
});

const TooltipFloatingFrame = styled(Stack, {
  name: "TooltipFloating",
  position: "absolute",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  zIndex: 9999,
  pointerEvents: "none",
});

const TooltipFloatingContent = styled(Stack, {
  name: "TooltipFloatingContent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  animation: "quick",
  pointerEvents: "none",
});

const tooltipToneStyles = {
  neutral: {
    backgroundColor: "$backgroundInverted",
    borderColor: "$backgroundInverted",
    color: "$colorInverted",
  },
  info: {
    backgroundColor: "$backgroundInverted",
    borderColor: "$info",
    color: "$colorInverted",
  },
  success: {
    backgroundColor: "$backgroundInverted",
    borderColor: "$success",
    color: "$colorInverted",
  },
  warning: {
    backgroundColor: "$backgroundInverted",
    borderColor: "$warning",
    color: "$colorInverted",
  },
  danger: {
    backgroundColor: "$backgroundInverted",
    borderColor: "$danger",
    color: "$colorInverted",
  },
  inverse: {
    backgroundColor: "$background",
    borderColor: "$borderColor",
    color: "$color",
  },
} as const satisfies Record<TooltipTone, Record<string, unknown>>;

const TooltipBubble = styled(Stack, {
  name: "TooltipBubble",
  flexShrink: 0,
  borderRadius: 0,
  borderWidth: BUBBLE_BORDER_WIDTH,
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  gap: "$2",
  minHeight: 28,
  maxWidth: 320,
  position: "relative",
  zIndex: 1,
  variants: {
    tone: tooltipToneStyles,
  },
  defaultVariants: {
    tone: "neutral",
  },
});

const TooltipPointerFrame = styled(Stack, {
  name: "TooltipPointer",
  position: "relative",
  pointerEvents: "none",
  width: 0,
  height: 0,
  zIndex: 0,
  variants: {
    placement: {
      top: {},
      bottom: {},
      left: {},
      right: {},
    },
  },
});
type TooltipPointerFrameProps = GetProps<typeof TooltipPointerFrame>;

type FlexDirection = "row" | "row-reverse" | "column" | "column-reverse";

type PlacementLayout = {
  flexDirection: FlexDirection;
  isVertical: boolean;
  centerTransform: string;
  position: (offset: number) => Record<string, string | number>;
  crossStart: "left" | "top";
  crossEnd: "right" | "bottom";
};

const placementLayouts: Record<TooltipPlacement, PlacementLayout> = {
  top: {
    flexDirection: "column",
    isVertical: true,
    centerTransform: "translateX(-50%)",
    position: (offset) => ({ bottom: "100%", marginBottom: offset }),
    crossStart: "left",
    crossEnd: "right",
  },
  bottom: {
    flexDirection: "column-reverse",
    isVertical: true,
    centerTransform: "translateX(-50%)",
    position: (offset) => ({ top: "100%", marginTop: offset }),
    crossStart: "left",
    crossEnd: "right",
  },
  left: {
    flexDirection: "row",
    isVertical: false,
    centerTransform: "translateY(-50%)",
    position: (offset) => ({ right: "100%", marginRight: offset }),
    crossStart: "top",
    crossEnd: "bottom",
  },
  right: {
    flexDirection: "row-reverse",
    isVertical: false,
    centerTransform: "translateY(-50%)",
    position: (offset) => ({ left: "100%", marginLeft: offset }),
    crossStart: "top",
    crossEnd: "bottom",
  },
};

const alignToFlex: Record<TooltipAlign, "flex-start" | "center" | "flex-end"> =
  {
    start: "flex-start",
    center: "center",
    end: "flex-end",
  };

type AlignmentStyle = {
  edges: Record<string, string | number>;
  frameTransform?: string;
  pointerTransform?: string;
};

const alignFrameStyle = (
  placement: TooltipPlacement,
  align: TooltipAlign,
  centerTransform: string,
  pointerLength: number,
  pointerThickness: number,
  showPointer: boolean,
  anchorMainSize?: number,
): AlignmentStyle => {
  const edges: Record<string, string | number> = {};
  const isVertical = placement === "top" || placement === "bottom";

  if (align === "center") {
    if (isVertical) {
      edges.left = "50%";
    } else {
      edges.top = "50%";
    }
    return { edges, frameTransform: centerTransform };
  }

  if (isVertical) {
    if (align === "start") {
      edges.left = 0;
    } else {
      edges.right = 0;
    }
  } else {
    if (align === "start") {
      edges.top = 0;
    } else {
      edges.bottom = 0;
    }
  }

  if (!showPointer) {
    return { edges };
  }

  const pointerOffset = Math.max(pointerLength, 0) / 2;

  if (!pointerOffset) {
    return { edges };
  }

  const maxShift =
    anchorMainSize !== undefined && anchorMainSize > 0
      ? Math.min(pointerOffset, anchorMainSize / 2)
      : pointerOffset;
  const pointerInset = Math.min(maxShift, ALIGNMENT_EDGE_INSET);
  const pointerHalfThickness = Math.max(pointerThickness, 0) / 2;

  const axis: "x" | "y" = isVertical ? "x" : "y";
  const direction = align === "start" ? -1 : 1;
  const shift = direction * maxShift;
  const frameTransform =
    axis === "x" ? `translateX(${shift}px)` : `translateY(${shift}px)`;
  const pointerShiftMagnitude =
    pointerInset > 0
      ? pointerHalfThickness > 0
        ? Math.min(pointerInset, pointerHalfThickness)
        : pointerInset
      : 0;
  const pointerShift = pointerShiftMagnitude
    ? -direction * pointerShiftMagnitude
    : 0;
  const pointerTransform = pointerShift
    ? axis === "x"
      ? `translateX(${pointerShift}px)`
      : `translateY(${pointerShift}px)`
    : undefined;

  return { edges, frameTransform, pointerTransform };
};

const resolveLayout = (
  placement: TooltipPlacement,
  align: TooltipAlign,
  pointerLength: number,
  pointerThickness: number,
  showPointer: boolean,
  anchorMainSize?: number,
) => {
  const layout = placementLayouts[placement];
  const offset = showPointer
    ? Math.max(pointerThickness - POINTER_OVERLAP, 0)
    : 0;
  const alignment = alignFrameStyle(
    placement,
    align,
    layout.centerTransform,
    pointerLength,
    pointerThickness,
    showPointer,
    anchorMainSize,
  );
  const frameStyle = {
    ...layout.position(offset),
    ...alignment.edges,
  };

  return {
    frameStyle: alignment.frameTransform
      ? {
          ...frameStyle,
          transform: alignment.frameTransform,
        }
      : frameStyle,
    pointerTransform: alignment.pointerTransform,
    flexDirection: layout.flexDirection,
    alignItems: alignToFlex[align],
  };
};

const pointerOverlapStyle = (placement: TooltipPlacement) => {
  switch (placement) {
    case "top":
      return { marginTop: -POINTER_OVERLAP } as const;
    case "bottom":
      return { marginBottom: -POINTER_OVERLAP } as const;
    case "left":
      return { marginLeft: -POINTER_OVERLAP } as const;
    case "right":
    default:
      return { marginRight: -POINTER_OVERLAP } as const;
  }
};

type FloatingMotionStyle = {
  opacity: number;
  scale: number;
  x?: number;
  y?: number;
};

const floatingAxisForPlacement = (placement: TooltipPlacement): "x" | "y" =>
  placement === "left" || placement === "right" ? "x" : "y";

const floatingDirectionForPlacement = (placement: TooltipPlacement) =>
  placement === "top" || placement === "left" ? 1 : -1;

const createFloatingMotionStyle = (
  placement: TooltipPlacement,
): FloatingMotionStyle => {
  const axis = floatingAxisForPlacement(placement);
  const offset =
    floatingDirectionForPlacement(placement) * FLOATING_MOTION_OFFSET;
  const style: FloatingMotionStyle = {
    opacity: 0,
    scale: 0.96,
  };
  style[axis] = offset;
  return style;
};

const toneColorTokens = (tone: TooltipTone) => {
  const { backgroundColor = "$surface", borderColor = "$borderColor" } =
    tooltipToneStyles[tone] ?? tooltipToneStyles.neutral;
  return { fill: backgroundColor as string, border: borderColor as string };
};

const pointerDimensions = (
  placement: TooltipPlacement,
  length: number,
  thickness: number,
): Pick<TooltipPointerFrameProps, "width" | "height"> =>
  placement === "left" || placement === "right"
    ? { width: thickness, height: length }
    : { width: length, height: thickness };

const createTriangleStyle = (
  placement: TooltipPlacement,
  halfLength: number,
  thickness: number,
  color: string,
) => {
  const transparent = "transparent";
  const base: Record<string, number | string> = {
    position: "absolute",
    width: 0,
    height: 0,
    borderStyle: "solid",
  };

  switch (placement) {
    case "top":
      base.borderLeftWidth = halfLength;
      base.borderRightWidth = halfLength;
      base.borderTopWidth = thickness;
      base.borderBottomWidth = 0;
      base.borderLeftColor = transparent;
      base.borderRightColor = transparent;
      base.borderBottomColor = transparent;
      base.borderTopColor = color;
      break;
    case "bottom":
      base.borderLeftWidth = halfLength;
      base.borderRightWidth = halfLength;
      base.borderTopWidth = 0;
      base.borderBottomWidth = thickness;
      base.borderLeftColor = transparent;
      base.borderRightColor = transparent;
      base.borderTopColor = transparent;
      base.borderBottomColor = color;
      break;
    case "left":
      base.borderTopWidth = halfLength;
      base.borderBottomWidth = halfLength;
      base.borderLeftWidth = thickness;
      base.borderRightWidth = 0;
      base.borderTopColor = transparent;
      base.borderBottomColor = transparent;
      base.borderRightColor = transparent;
      base.borderLeftColor = color;
      break;
    case "right":
    default:
      base.borderTopWidth = halfLength;
      base.borderBottomWidth = halfLength;
      base.borderRightWidth = thickness;
      base.borderLeftWidth = 0;
      base.borderTopColor = transparent;
      base.borderBottomColor = transparent;
      base.borderLeftColor = transparent;
      base.borderRightColor = color;
      break;
  }

  return base;
};

export interface TooltipPointerProps extends Omit<
  TooltipPointerFrameProps,
  "placement" | "tone" | "width" | "height"
> {
  length?: number;
  placement?: TooltipPlacement;
  tone?: TooltipTone;
  thickness?: number;
}

const TooltipPointer = ({
  length = 16,
  placement = "top",
  tone = "neutral",
  thickness = 8,
  style,
  ...rest
}: TooltipPointerProps) => {
  const { fill, border } = toneColorTokens(tone);

  if (Platform.OS !== "web") {
    return (
      <TooltipPointerFrame
        placement={placement}
        {...pointerDimensions(placement, length, thickness)}
        backgroundColor={fill}
        borderColor={border}
        borderWidth={BUBBLE_BORDER_WIDTH}
        borderRadius="$0"
        style={style}
        {...rest}
      />
    );
  }

  const halfLength = Math.max(0, Math.round(length / 2));
  const outerHalf = halfLength + BUBBLE_BORDER_WIDTH;
  const innerHalf = Math.max(0, halfLength - BUBBLE_BORDER_WIDTH);
  const outerThickness = thickness + BUBBLE_BORDER_WIDTH;
  const innerThickness = Math.max(0, thickness - BUBBLE_BORDER_WIDTH);

  const triangles = [
    <Stack
      key="border"
      pointerEvents="none"
      {...createTriangleStyle(placement, outerHalf, outerThickness, border)}
    />,
  ];

  if (innerThickness > 0) {
    triangles.push(
      <Stack
        key="fill"
        pointerEvents="none"
        {...createTriangleStyle(
          placement,
          Math.max(0, innerHalf),
          innerThickness,
          fill,
        )}
      />,
    );
  }

  return (
    <TooltipPointerFrame placement={placement} style={style} {...rest}>
      {triangles}
    </TooltipPointerFrame>
  );
};

TooltipPointer.displayName = "TooltipPointer";

type TooltipBubbleProps = GetProps<typeof TooltipBubble>;

export interface TooltipProps extends Omit<TooltipBubbleProps, "tone"> {
  anchor: ReactNode;
  align?: TooltipAlign;
  id?: string;
  open?: boolean;
  /**
   * Fired when the pointer enters the (portalled) bubble. Uncontrolled tooltips
   * cancel their own pending close internally; a CONTROLLED consumer uses this
   * to keep its `open` state true while the pointer hovers the bubble to copy.
   */
  onBubblePointerEnter?: (event: unknown) => void;
  /** Fired when the pointer leaves the bubble (controlled consumers close). */
  onBubblePointerLeave?: (event: unknown) => void;
  placement?: TooltipPlacement;
  pointerLength?: number;
  pointerProps?: Omit<
    TooltipPointerProps,
    "length" | "placement" | "thickness" | "tone"
  >;
  pointerThickness?: number;
  roleDescription?: string;
  showPointer?: boolean;
  tone?: TooltipTone;
}

/**
 * Wrap bare string / number children in a <Text> so they're valid inside
 * TooltipBubble (a styled Stack that rejects raw text nodes).
 */
function wrapTextChildren(children: ReactNode): ReactNode {
  if (typeof children === "string" || typeof children === "number") {
    return (
      <Text variant="bodySmall" tone="inherit">
        {children}
      </Text>
    );
  }

  // If every child in a fragment/array is a primitive, wrap the whole thing.
  const arr = Children.toArray(children);
  if (
    arr.length > 0 &&
    arr.every((c) => typeof c === "string" || typeof c === "number")
  ) {
    return (
      <Text variant="bodySmall" tone="inherit">
        {children}
      </Text>
    );
  }

  // Mixed or already-element children — wrap only the bare text nodes.
  if (
    arr.some((c) => typeof c === "string" || typeof c === "number") &&
    arr.some((c) => isValidElement(c))
  ) {
    return Children.map(children, (child) => {
      if (typeof child === "string" || typeof child === "number") {
        return (
          <Text variant="bodySmall" tone="inherit">
            {child}
          </Text>
        );
      }
      return child;
    });
  }

  return children;
}

export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(
  (
    {
      anchor,
      align = "center",
      children,
      id,
      open: openProp,
      onBubblePointerEnter,
      onBubblePointerLeave,
      placement = "top",
      pointerLength = 16,
      pointerProps,
      pointerThickness = 8,
      roleDescription,
      showPointer = true,
      tone = "neutral",
      ...bubbleProps
    },
    ref,
  ) => {
    const [isHovering, setIsHovering] = useState(false);
    const [anchorSize, setAnchorSize] = useState({ width: 0, height: 0 });
    const [bubbleSize, setBubbleSize] = useState({ width: 0, height: 0 });
    const isControlled = openProp !== undefined;
    const open = isControlled ? openProp : isHovering;
    const reactId = useId();
    const tooltipId = id ?? `th-tooltip-${reactId}`;
    const anchorMainSize = useMemo(() => {
      const layout = placementLayouts[placement];
      return layout.isVertical ? anchorSize.height : anchorSize.width;
    }, [placement, anchorSize.height, anchorSize.width]);

    const layout = useMemo(
      () =>
        resolveLayout(
          placement,
          align,
          pointerLength,
          pointerThickness,
          showPointer,
          anchorMainSize,
        ),
      [
        placement,
        align,
        pointerLength,
        pointerThickness,
        showPointer,
        anchorMainSize,
      ],
    );
    const basePointerSize = useMemo(() => {
      if (placement === "left" || placement === "right") {
        return {
          width: pointerThickness,
          height: pointerLength,
          flexShrink: 0,
        } as const;
      }
      return {
        width: pointerLength,
        height: pointerThickness,
        flexShrink: 0,
      } as const;
    }, [placement, pointerLength, pointerThickness]);

    const overlapStyle = useMemo(
      () => pointerOverlapStyle(placement),
      [placement],
    );

    const { style: pointerStyleOverride, ...restPointerProps } =
      pointerProps ?? {};

    const pointerStyleList = useMemo(() => {
      const pointerBase: Array<Record<string, unknown>> = [
        basePointerSize,
        overlapStyle,
      ];
      if (layout.pointerTransform && Platform.OS === "web") {
        pointerBase.push({ transform: layout.pointerTransform });
      }
      if (!pointerStyleOverride) {
        return pointerBase;
      }

      return Array.isArray(pointerStyleOverride)
        ? [...pointerBase, ...pointerStyleOverride]
        : [...pointerBase, pointerStyleOverride];
    }, [
      basePointerSize,
      overlapStyle,
      pointerStyleOverride,
      layout.pointerTransform,
    ]);

    const floatingFrameStyle = useMemo(() => {
      if (Platform.OS === "web") {
        return layout.frameStyle;
      }

      type NativeFrameStyle = Partial<
        Pick<ViewStyle, "top" | "bottom" | "left" | "right" | "transform">
      >;

      const isVertical = placementLayouts[placement].isVertical;
      const baseDistance = isVertical ? anchorSize.height : anchorSize.width;
      const pointerOffset = showPointer
        ? Math.max(pointerThickness - POINTER_OVERLAP, 0)
        : 0;
      const totalOffset = baseDistance + pointerOffset;
      const style: NativeFrameStyle = {};

      switch (placement) {
        case "top":
          style.bottom = totalOffset;
          break;
        case "bottom":
          style.top = totalOffset;
          break;
        case "left":
          style.right = totalOffset;
          break;
        case "right":
        default:
          style.left = totalOffset;
          break;
      }

      const anchorCrossSize = isVertical ? anchorSize.width : anchorSize.height;
      const bubbleCrossSize = isVertical ? bubbleSize.width : bubbleSize.height;
      const transforms: Array<{ translateX?: number; translateY?: number }> =
        [];

      if (align === "center") {
        if (isVertical) {
          style.left = anchorCrossSize / 2;
          if (bubbleCrossSize > 0) {
            transforms.push({ translateX: -bubbleCrossSize / 2 });
          }
        } else {
          style.top = anchorCrossSize / 2;
          if (bubbleCrossSize > 0) {
            transforms.push({ translateY: -bubbleCrossSize / 2 });
          }
        }
      } else if (align === "start") {
        if (isVertical) {
          style.left = 0;
        } else {
          style.top = 0;
        }
      } else {
        if (isVertical) {
          style.right = 0;
        } else {
          style.bottom = 0;
        }
      }

      if (transforms.length > 0) {
        style.transform = transforms as ViewStyle["transform"];
      }

      return style;
    }, [
      layout.frameStyle,
      placement,
      align,
      anchorSize.height,
      anchorSize.width,
      bubbleSize.height,
      bubbleSize.width,
      pointerThickness,
      showPointer,
    ]);

    const floatingMotion = useMemo(() => {
      const enter = createFloatingMotionStyle(placement);
      return {
        enter,
        exit: { ...enter },
      };
    }, [placement]);

    const {
      onLayout: bubbleOnLayout,
      style: bubbleStyleProp,
      ...restBubbleProps
    } = bubbleProps;

    // Make the bubble selectable/copyable on web. Merged onto any caller style
    // (never clobbers it). Native returns the caller style untouched.
    const bubbleInteractiveStyle = useMemo(() => {
      if (Platform.OS !== "web") {
        return bubbleStyleProp;
      }
      const webStyle = {
        cursor: "text",
        userSelect: "text",
        WebkitUserSelect: "text",
      } as const;
      if (!bubbleStyleProp) {
        return webStyle;
      }
      return Array.isArray(bubbleStyleProp)
        ? [webStyle, ...bubbleStyleProp]
        : [webStyle, bubbleStyleProp];
    }, [bubbleStyleProp]);

    const handleAnchorLayout = useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setAnchorSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    }, []);

    const handleBubbleLayout = useCallback(
      (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setBubbleSize((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
        bubbleOnLayout?.(event as never);
      },
      [bubbleOnLayout],
    );

    // ── Anchor → bubble gap bridge (uncontrolled only) ──────────────────
    // The bubble is portalled OUTSIDE the anchor's TooltipRoot, so leaving the
    // anchor toward the bubble fires the anchor's onPointerLeave and would close
    // it before the pointer arrives. Instead of closing immediately we schedule
    // a close; the bubble's own onPointerEnter cancels it, so the pointer can
    // reach the bubble and select/copy the text.
    const closeTimerRef = useRef<number | null>(null);

    const clearCloseTimer = useCallback(() => {
      if (closeTimerRef.current !== null) {
        if (typeof window !== "undefined") {
          window.clearTimeout(closeTimerRef.current);
        }
        closeTimerRef.current = null;
      }
    }, []);

    const scheduleClose = useCallback(() => {
      if (isControlled) {
        return;
      }
      clearCloseTimer();
      if (typeof window === "undefined") {
        setIsHovering(false);
        return;
      }
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setIsHovering(false);
      }, TOOLTIP_CLOSE_DELAY_MS);
    }, [isControlled, clearCloseTimer]);

    // Always clear any pending close timer on unmount.
    useEffect(() => clearCloseTimer, [clearCloseTimer]);

    const enableHover = useCallback(() => {
      if (!isControlled) {
        clearCloseTimer();
        setIsHovering(true);
      }
    }, [isControlled, clearCloseTimer]);

    const disableHover = useCallback(
      (event: unknown) => {
        if (isControlled) {
          return;
        }

        const synthetic = event as {
          currentTarget?: { contains?: (target: unknown) => boolean };
          relatedTarget?: unknown;
        };
        const { currentTarget, relatedTarget } = synthetic;

        // Still short-circuit moves that stay WITHIN the anchor subtree. The
        // portalled bubble is not contained here, so the timer bridge (below)
        // is what keeps it open while the pointer crosses to the bubble.
        if (
          currentTarget?.contains &&
          relatedTarget instanceof Node &&
          currentTarget.contains(relatedTarget)
        ) {
          return;
        }

        scheduleClose();
      },
      [isControlled, scheduleClose],
    );

    const handleBubblePointerEnter = useCallback(
      (event: unknown) => {
        if (!isControlled) {
          enableHover();
        }
        onBubblePointerEnter?.(event);
      },
      [isControlled, enableHover, onBubblePointerEnter],
    );

    const handleBubblePointerLeave = useCallback(
      (event: unknown) => {
        if (!isControlled) {
          scheduleClose();
        }
        onBubblePointerLeave?.(event);
      },
      [isControlled, scheduleClose, onBubblePointerLeave],
    );

    const rootHoverHandlers =
      Platform.OS === "web" && !isControlled
        ? {
            onPointerEnter: enableHover as GetProps<
              typeof TooltipRoot
            >["onPointerEnter"],
            onPointerLeave: disableHover as GetProps<
              typeof TooltipRoot
            >["onPointerLeave"],
          }
        : {};

    // The bubble intercepts pointer events (it re-enables `pointerEvents:auto`
    // over the `none` portal wrappers). On web, wire enter/leave so hovering it
    // keeps the tooltip open (uncontrolled) and notifies controlled consumers.
    // `pointerEvents:auto` is gated on the RESOLVED `open` state: it stays true
    // through the 120ms grace period (so the anchor→bubble hover bridge keeps
    // working), but flips to `none` the instant `open === false` so the fading
    // bubble never intercepts a click meant for a control underneath it.
    const bubbleHoverHandlers =
      Platform.OS === "web"
        ? {
            pointerEvents: (open ? "auto" : "none") as "auto" | "none",
            onPointerEnter: handleBubblePointerEnter as GetProps<
              typeof TooltipBubble
            >["onPointerEnter"],
            onPointerLeave: handleBubblePointerLeave as GetProps<
              typeof TooltipBubble
            >["onPointerLeave"],
          }
        : {};

    const anchorFocusHandlers =
      Platform.OS === "web" && !isControlled
        ? {
            onFocus: enableHover as GetProps<
              typeof TooltipAnchorFrame
            >["onFocus"],
            onBlur: disableHover as GetProps<
              typeof TooltipAnchorFrame
            >["onBlur"],
          }
        : {};

    const pointerElement =
      showPointer && open ? (
        <TooltipPointer
          length={pointerLength}
          placement={placement}
          tone={tone}
          thickness={pointerThickness}
          style={pointerStyleList}
          {...restPointerProps}
        />
      ) : null;

    // ── Web portal positioning ──────────────────────────────────────
    // On web we render the floating bubble via a portal to document.body
    // so it escapes any parent overflow:hidden / stacking-context created
    // by borderRadius, zIndex or transforms (e.g. the shell navbar).
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const [portalPos, setPortalPos] = useState<{
      top: number;
      left: number;
    } | null>(null);

    // biome-ignore lint: we want this to fire on every render when open
    useLayoutEffect(() => {
      if (Platform.OS !== "web" || !open) {
        setPortalPos(null);
        return;
      }
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPortalPos({
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
      });
    }, [open, placement, align, anchorSize.width, anchorSize.height]);

    const floatingContent = (
      <AnimatePresence initial={false}>
        {open ? (
          <TooltipFloatingFrame
            key={`${tooltipId}-${placement}`}
            style={floatingFrameStyle}
            data-tooltip-placement={placement}
          >
            <TooltipFloatingContent
              flexDirection={layout.flexDirection}
              alignItems={layout.alignItems}
              data-animation="fast"
              enterStyle={floatingMotion.enter}
              exitStyle={floatingMotion.exit}
            >
              <TooltipBubble
                ref={ref}
                tone={tone}
                onLayout={handleBubbleLayout}
                id={tooltipId}
                role="tooltip"
                aria-live="polite"
                aria-atomic="true"
                data-tooltip-tone={tone}
                style={bubbleInteractiveStyle}
                {...(roleDescription
                  ? { "aria-roledescription": roleDescription }
                  : {})}
                {...restBubbleProps}
                {...bubbleHoverHandlers}
              >
                {wrapTextChildren(children)}
              </TooltipBubble>
              {pointerElement}
            </TooltipFloatingContent>
          </TooltipFloatingFrame>
        ) : null}
      </AnimatePresence>
    );

    const portalledFloating =
      Platform.OS === "web" && typeof document !== "undefined" && portalPos
        ? createPortal(
            <div
              style={{
                position: "absolute",
                top: portalPos.top,
                left: portalPos.left,
                width: anchorSize.width || undefined,
                height: anchorSize.height || undefined,
                pointerEvents: "none",
                zIndex: 99999,
              }}
            >
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                {floatingContent}
              </div>
            </div>,
            document.body,
          )
        : null;

    return (
      <TooltipRoot {...rootHoverHandlers}>
        <TooltipAnchorFrame
          ref={Platform.OS === "web" ? (anchorRef as any) : undefined}
          onLayout={handleAnchorLayout}
          {...anchorFocusHandlers}
          {...(open && Platform.OS === "web"
            ? { "aria-describedby": tooltipId }
            : {})}
        >
          {anchor}
        </TooltipAnchorFrame>
        {Platform.OS === "web" ? portalledFloating : floatingContent}
      </TooltipRoot>
    );
  },
);

Tooltip.displayName = "Tooltip";

export type { TooltipAlign, TooltipPlacement, TooltipTone };
export const __tooltipInternals = {
  createFloatingMotionStyle,
  resolveLayout,
};
export {};
