"use client";

import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import type { ReactNode } from "react";
import { cloneElement, isValidElement, useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { YStack, type StackProps } from "tamagui";

export type PopoverTone = "surface";

export type PopoverProps = {
  children?: ReactNode;
  anchor?: ReactNode;
  /**
   * Position against a node that is ALREADY mounted somewhere else, instead of
   * rendering `anchor` here. `anchor` is cloned to take the Floating UI
   * reference ref, which re-parents the trigger into this component — and a
   * trigger that only becomes an anchor when the popover opens is therefore
   * unmounted and remounted on every open, losing focus, DOM identity and
   * hover state. Pass the element when the trigger must stay where it is;
   * `anchor` is then ignored for positioning.
   */
  anchorElement?: Element | null;
  open?: boolean;
  placement?: Placement;
  tone?: PopoverTone;
  /** Pixel offset from the anchor */
  offset?: number;
  /** Default: match popover width to anchor width */
  matchAnchorWidth?: boolean;
  /** Extra props to apply to the popover container */
  contentProps?: Partial<StackProps>;
};

const toneToStyles: Record<
  PopoverTone,
  {
    borderColor: StackProps["borderColor"];
    backgroundColor: StackProps["backgroundColor"];
  }
> = {
  surface: { borderColor: "$borderColor", backgroundColor: "$background" },
};

/** The gap kept between a popover and every viewport edge. */
const VIEWPORT_PADDING = 8;

/**
 * The `maxWidth` the panel gets: the tighter of the caller's own limit
 * (`contentProps.maxWidth`) and the width the viewport has left, so long
 * content wraps instead of spilling off-screen but a caller's narrower cap
 * (the filter panel's 320) survives on wide screens.
 *
 * A number caps in px; a CSS length string (`"calc(100vw - 16px)"`) goes
 * through `min()`. A Tamagui token (`"$20"`) cannot be resolved here, so it
 * is unsupported and ignored: use a number or a CSS length. A `maxWidth` in
 * `contentProps.style` is overwritten (the inline write wins): pass it as
 * `contentProps.maxWidth`.
 */
export function resolveMaxWidth(callerMax: unknown, availableWidth: number): string {
  const room = Math.max(0, Math.floor(availableWidth));
  const available = `${room}px`;
  if (typeof callerMax === "number" && Number.isFinite(callerMax)) {
    return `${Math.min(callerMax, room)}px`;
  }
  if (typeof callerMax === "string" && callerMax !== "" && !callerMax.startsWith("$")) {
    return `min(${callerMax}, ${available})`;
  }
  return available;
}

/**
 * The Floating UI middleware chain for the web popover, in the documented
 * order (offset, flip, shift, size): `size` reads `shift`'s result, and both
 * keep `VIEWPORT_PADDING` from the viewport edge.
 */
export type PopoverLiveOptions = {
  matchAnchorWidth: boolean;
  callerMaxWidth?: unknown;
};

/**
 * `live` is a ref the `apply` callback reads on every run: `useFloating`
 * compares middleware by `toString`, so values captured in the closure would
 * go stale after the first render.
 */
export function buildPopoverMiddleware(opts: {
  offsetPx: number;
  live: { current: PopoverLiveOptions };
}) {
  return [
    offset(opts.offsetPx),
    flip(),
    shift({ padding: VIEWPORT_PADDING }),
    size({
      padding: VIEWPORT_PADDING,
      apply({ rects, elements, availableWidth }) {
        // Caps a content-sized panel at the room the viewport has: at 320px
        // it could otherwise be as wide as the viewport, and no shift can give
        // it an edge on both sides (it ended at x=326).
        const { matchAnchorWidth, callerMaxWidth } = opts.live.current;
        elements.floating.style.maxWidth = resolveMaxWidth(callerMaxWidth, availableWidth);
        if (!matchAnchorWidth) return;
        Object.assign(elements.floating.style, {
          width: `${Math.round(rects.reference.width)}px`,
        });
      },
    }),
  ];
}

/**
 * Small anchored popover built on Floating UI.
 * - On web: positions content absolutely + portals via Floating UI.
 * - On native: falls back to inline rendering (no DOM), keeping behavior predictable.
 */
export const Popover = ({
  anchor,
  anchorElement,
  open = false,
  children,
  placement = "bottom-start",
  tone = "surface",
  offset: offsetPx = 6,
  matchAnchorWidth = true,
  contentProps,
}: PopoverProps) => {
  const isWeb = Platform.OS === "web";
  const externalAnchor = anchorElement !== undefined;

  const live = useRef<PopoverLiveOptions>({ matchAnchorWidth });
  live.current = { matchAnchorWidth, callerMaxWidth: contentProps?.maxWidth };

  const { refs, floatingStyles } = useFloating({
    placement,
    open,
    strategy: isWeb ? "fixed" : "absolute",
    whileElementsMounted: isWeb ? autoUpdate : undefined,
    middleware: isWeb
      ? buildPopoverMiddleware({ offsetPx, live })
      : [],
  });

  const { setReference } = refs;
  useEffect(() => {
    if (!isWeb || !externalAnchor) return;
    setReference(anchorElement ?? null);
  }, [anchorElement, externalAnchor, isWeb, setReference]);

  const resolvedAnchor = useMemo(() => {
    if (!anchor) return null;
    if (!isWeb || externalAnchor) return anchor;
    if (!isValidElement(anchor)) return anchor;
    return cloneElement(anchor as any, {
      ref: setReference,
    });
  }, [anchor, externalAnchor, isWeb, setReference]);

  if (!open) {
    return <>{resolvedAnchor}</>;
  }

  if (!isWeb) {
    // No DOM to position against; render inline (native is typically sheet/modal).
    return (
      <>
        {resolvedAnchor}
        {children}
      </>
    );
  }

  const toneStyles = toneToStyles[tone];
  const { style: contentStyle, ...restContentProps } = contentProps ?? {};

  return (
    <>
      {resolvedAnchor}
      <FloatingPortal>
        <YStack
          ref={refs.setFloating}
          borderWidth={2}
          borderColor={toneStyles.borderColor}
          backgroundColor={toneStyles.backgroundColor}
          borderRadius={0}
          overflow="hidden"
          zIndex={1000}
          {...restContentProps}
          // LAST, and merged over any caller `style`: `{...contentProps}` used
          // to sit after `style={floatingStyles}` and silently replaced it, so
          // a caller that passed `contentProps.style` (a shadow, say) stripped
          // `position: fixed` and the translate off the panel. It then fell
          // into normal flow at the end of the portal's <body> node —
          // bottom-left of the document, nowhere near its anchor.
          style={{ ...(contentStyle as object), ...(floatingStyles as any) }}
        >
          {children}
        </YStack>
      </FloatingPortal>
    </>
  );
};
