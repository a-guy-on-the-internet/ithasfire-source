"use client";

import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { Stack, styled, type GetProps } from "tamagui";

// Floating UI handles collision detection (flip/shift) on web.
// We keep the existing static positioning strategy for native surfaces.
import {
  autoUpdate,
  flip,
  offset as fuiOffset,
  shift,
  size,
  useFloating,
  type Placement as FloatingPlacement,
} from "@floating-ui/react";

import { motionTokens } from "../tokens/motion";

type PopoverTone = "neutral" | "surface";

type PopoverPlacement = "top" | "bottom" | "left" | "right";

const PopoverRoot = styled(Stack, {
  name: "PopoverRoot",
  display: "inline-flex",
  position: "relative",
});

const PopoverAnchorFrame = styled(Stack, {
  name: "PopoverAnchor",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
});

const PopoverFloatingFrame = styled(Stack, {
  name: "PopoverFloating",
  position: "absolute",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  zIndex: 1,
});

const contentPlacementVariants = {
  top: {
    enterStyle: {
      opacity: 0,
      transform: "translate3d(0, -8px, 0)",
    },
    exitStyle: {
      opacity: 0,
      transform: "translate3d(0, -8px, 0)",
    },
    transformOrigin: "center bottom" as const,
  },
  bottom: {
    enterStyle: {
      opacity: 0,
      transform: "translate3d(0, 8px, 0)",
    },
    exitStyle: {
      opacity: 0,
      transform: "translate3d(0, 8px, 0)",
    },
    transformOrigin: "center top" as const,
  },
  left: {
    enterStyle: {
      opacity: 0,
      transform: "translate3d(-8px, 0, 0)",
    },
    exitStyle: {
      opacity: 0,
      transform: "translate3d(-8px, 0, 0)",
    },
    transformOrigin: "right center" as const,
  },
  right: {
    enterStyle: {
      opacity: 0,
      transform: "translate3d(8px, 0, 0)",
    },
    exitStyle: {
      opacity: 0,
      transform: "translate3d(8px, 0, 0)",
    },
    transformOrigin: "left center" as const,
  },
} as const;

const POPPER_ANIMATION: [string, { duration: number; easing: string }] = [
  "quick",
  {
    duration: motionTokens.duration.fast,
    easing: motionTokens.easing.easeOut,
  },
];

const PopoverContentContainer = styled(Stack, {
  name: "PopoverContent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  opacity: 1,
  transform: "translate3d(0, 0, 0)",
  animation: POPPER_ANIMATION,
  variants: {
    placement: contentPlacementVariants,
  },
} as const);

const PopoverFrame = styled(Stack, {
  name: "Popover",
  flexShrink: 0,
  borderRadius: 0,
  borderWidth: 2,
  gap: "$5",
  padding: "$5",
  minWidth: 240,
  variants: {
    tone: {
      neutral: {
        backgroundColor: "$backgroundStrong",
        borderColor: "$borderColorStrong",
        color: "$color",
      },
      surface: {
        backgroundColor: "$surface",
        borderColor: "$borderColor",
        color: "$color",
      },
    },
  },
  defaultVariants: {
    tone: "surface",
  },
});

const PopoverPointerFrame = styled(Stack, {
  name: "PopoverPointer",
  borderRadius: 0,
  borderWidth: 2,
  flexShrink: 0,
  variants: {
    tone: {
      neutral: {
        backgroundColor: "$backgroundStrong",
        borderColor: "$borderColorStrong",
      },
      surface: {
        backgroundColor: "$surface",
        borderColor: "$borderColor",
      },
    },
    placement: {
      top: {
        zIndex: 1,
        borderTopWidth: 0,
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
        marginTop: -2,
      },
      bottom: {
        zIndex: 1,
        borderBottomWidth: 0,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        marginBottom: -2,
      },
      left: {
        borderLeftWidth: 0,
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        marginLeft: -2,
      },
      right: {
        zIndex: 1,
        borderRightWidth: 0,
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
        marginRight: -2,
      },
    },
  },
  defaultVariants: {
    tone: "surface",
    placement: "top",
  },
});

type PopoverFrameProps = GetProps<typeof PopoverFrame>;

type PopoverPointerFrameProps = GetProps<typeof PopoverPointerFrame>;

export interface PopoverPointerProps extends Omit<
  PopoverPointerFrameProps,
  "tone" | "placement" | "width" | "height"
> {
  length?: number;
  placement?: PopoverPlacement;
  thickness?: number;
  tone?: PopoverTone;
}

const pointerDimensionForPlacement = (
  placement: PopoverPlacement,
  length: number,
  thickness: number,
): Pick<PopoverPointerFrameProps, "width" | "height"> =>
  placement === "left" || placement === "right"
    ? { width: thickness, height: length }
    : { width: length, height: thickness };

export const PopoverPointer = ({
  length = 40,
  placement = "top",
  thickness = 20,
  tone = "surface",
  ...props
}: PopoverPointerProps) => (
  <PopoverPointerFrame
    placement={placement}
    tone={tone}
    {...pointerDimensionForPlacement(placement, length, thickness)}
    {...props}
  />
);

PopoverPointer.displayName = "PopoverPointer";

export interface PopoverProps extends PopoverFrameProps {
  anchor: ReactNode;
  offset?: number;
  open?: boolean;
  placement?: PopoverPlacement;
  pointerLength?: number;
  pointerProps?: Omit<
    PopoverPointerProps,
    "tone" | "placement" | "length" | "thickness"
  >;
  pointerThickness?: number;
  showPointer?: boolean;
  tone?: PopoverTone;
}

export const Popover = forwardRef<HTMLDivElement, PopoverProps>(
  (
    {
      children,
      anchor,
      offset = 12,
      open = true,
      placement = "top",
      pointerLength = 40,
      pointerProps,
      pointerThickness = 20,
      showPointer = true,
      tone = "surface",
      ...rest
    },
    ref,
  ) => {
    const prefersFloatingUi = Platform.OS === "web";
    const isHorizontal = placement === "left" || placement === "right";
    const pointerFirst = placement === "bottom" || placement === "right";

    // Native/static positioning fallback.
    const nativeFloatingStyle = (() => {
      switch (placement) {
        case "top":
          return {
            bottom: "100%",
            marginBottom: offset,
            left: "50%",
            transform: "translateX(-50%)",
          } as const;
        case "bottom":
          return {
            top: "100%",
            marginTop: offset,
            left: "50%",
            transform: "translateX(-50%)",
          } as const;
        case "left":
          return {
            right: "100%",
            marginRight: offset,
            top: "50%",
            transform: "translateY(-50%)",
          } as const;
        case "right":
        default:
          return {
            left: "100%",
            marginLeft: offset,
            top: "50%",
            transform: "translateY(-50%)",
          } as const;
      }
    })();

    const floatingPlacement = useMemo<FloatingPlacement>(() => {
      // Our component only exposes the 4 primary sides.
      // Floating UI will auto-flip and shift as needed.
      switch (placement) {
        case "top":
          return "top";
        case "bottom":
          return "bottom";
        case "left":
          return "left";
        case "right":
        default:
          return "right";
      }
    }, [placement]);

    const { refs, floatingStyles, update } = useFloating({
      placement: floatingPlacement,
      middleware: [
        fuiOffset(offset),
        flip(),
        shift({ padding: 8 }),
        // Ensure the frame never exceeds the viewport.
        size({
          padding: 8,
          apply({ availableWidth, availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              maxWidth: `${availableWidth}px`,
              maxHeight: `${availableHeight}px`,
            });
          },
        }),
      ],
      whileElementsMounted: prefersFloatingUi
        ? (referenceEl, floatingEl, onUpdate) =>
            autoUpdate(referenceEl, floatingEl, onUpdate)
        : undefined,
    });

    // Keep external refs working.
    const mergedFloatingRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (!prefersFloatingUi) return;
      if (!open) return;
      // One extra update after mount/open helps avoid a 1-frame misplacement.
      update();
    }, [open, prefersFloatingUi, update]);

    const setFloatingRef = (node: HTMLDivElement | null) => {
      mergedFloatingRef.current = node;
      refs.setFloating(node);
      if (!ref) return;
      if (typeof ref === "function") {
        ref(node);
        return;
      }
      (ref as { current: HTMLDivElement | null }).current = node;
    };

    const [anchorNode, setAnchorNode] = useState<ReactNode>(anchor);
    useEffect(() => {
      setAnchorNode(anchor);
    }, [anchor]);

    const pointerElement = showPointer ? (
      <PopoverPointer
        length={pointerLength}
        placement={placement}
        thickness={pointerThickness}
        tone={tone}
        {...pointerProps}
      />
    ) : null;
    const containerDirection = isHorizontal ? "row" : "column";

    return (
      <PopoverRoot>
        <PopoverAnchorFrame
          // @floating-ui uses a real DOM ref; on native we ignore this.
          ref={
            prefersFloatingUi
              ? (refs.setReference as unknown as any)
              : undefined
          }
        >
          {anchorNode}
        </PopoverAnchorFrame>
        {open ? (
          <PopoverFloatingFrame
            // Floating UI provides computed top/left.
            style={
              prefersFloatingUi
                ? (floatingStyles as unknown as any)
                : nativeFloatingStyle
            }
          >
            <PopoverContentContainer
              placement={placement}
              flexDirection={containerDirection}
            >
              {pointerFirst ? pointerElement : null}
              <PopoverFrame
                ref={prefersFloatingUi ? setFloatingRef : ref}
                // Prevent super long menus from rendering off-screen; allow internal scrolling.
                maxHeight={prefersFloatingUi ? "80vh" : undefined}
                overflow={prefersFloatingUi ? "scroll" : undefined}
                tone={tone}
                {...rest}
              >
                {children}
              </PopoverFrame>
              {!pointerFirst ? pointerElement : null}
            </PopoverContentContainer>
          </PopoverFloatingFrame>
        ) : null}
      </PopoverRoot>
    );
  },
);

Popover.displayName = "Popover";

export type { PopoverPlacement, PopoverTone };
