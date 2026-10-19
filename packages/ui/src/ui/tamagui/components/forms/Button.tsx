import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ReactElement,
} from "react";
import { Platform } from "react-native";
import {
  Button as TamaguiButton,
  View,
  styled,
  stylePropsText,
  type GetProps,
  type TamaguiElement,
} from "tamagui";

import { BUTTON_SLOT_ATTRIBUTE } from "./button-slot";
import { BUTTON_VARIANT_STYLES, type ButtonVariant } from "./button-variants";

const focusRing = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$accent",
  outlineOffset: 2,
};

// The variant ladder lives in a dependency-free leaf module so non-Vitest
// runners (Playwright) can import it without tripping over react-native's
// Flow syntax. Re-exported here: every existing consumer imports it from
// this file.
const variantStyles = BUTTON_VARIANT_STYLES;

export { BUTTON_VARIANT_STYLES };
export type { ButtonVariant };

/**
 * v2 size scale mapped onto the existing keys (do not rename keys —
 * hundreds of call sites): $3 = v2 "sm", $4 = v2 "md", $5 = v2 "lg".
 * Icon-only buttons are square, so minWidth mirrors these heights
 * (applied in the forwardRef wrapper below).
 *
 * Label fontSize uses literal px: v2 button label sizes (10/11/12/13)
 * are off the type scale by design — uppercase 700 + 1.5px tracking
 * needs a smaller optical size than the body scale provides.
 */
const sizeHeights = {
  $1: 28,
  $2: 34,
  $3: 36,
  $4: 44,
  $5: 54,
} as const;

/** Exported for regression tests — single source for size heights and
 * icon-only square minWidths. */
export const BUTTON_SIZE_HEIGHTS = sizeHeights;

// Dev-only: icon-only a11y warning fires once per session (see below).
let warnedIconA11y = false;

const buttonConfig = {
  name: "IthasFireButton",
  // Base = default size $3 (v2 "sm").
  height: sizeHeights.$3,
  paddingHorizontal: "$4",
  gap: "$2",
  borderRadius: 0,
  borderWidth: 2,
  fontWeight: "700",
  fontSize: 11,
  fontFamily: "$body",
  // v2: +1.5px tracking on uppercase labels. NOTE: textTransform deliberately
  // does NOT live in this config — as a top-level frame prop it leaks onto the
  // DOM as an invalid attribute (see Button.theme.test.tsx). Web gets it via
  // the wrapper's style (CSS cascade); native via textProps in the wrapper.
  letterSpacing: 1.5,
  transition: "all 150ms ease-out",
  focusStyle: focusRing,
  disabledStyle: {
    // v2 disabled treatment.
    opacity: 0.45,
    cursor: "not-allowed",
  },
  variants: {
    variant: variantStyles,
    size: {
      // Compact chrome escape hatch — below the v2 scale (dense toolbars).
      $1: {
        height: sizeHeights.$1,
        paddingHorizontal: "$2",
        gap: "$2",
        fontSize: 10,
      },
      // Transitional step between compact chrome and v2 "sm".
      $2: {
        height: sizeHeights.$2,
        paddingHorizontal: "$3",
        gap: "$2",
        fontSize: 11,
      },
      // v2 "sm" — the default (values live on the base config above).
      $3: {},
      // v2 "md".
      $4: {
        height: sizeHeights.$4,
        paddingHorizontal: "$5",
        gap: "$2",
        fontSize: 12,
      },
      // v2 "lg".
      $5: {
        height: sizeHeights.$5,
        paddingHorizontal: "$6",
        gap: "$2",
        fontSize: 13,
      },
    },
    icon: {
      true: {
        paddingHorizontal: 0,
        // Square fallback for the default size; the wrapper overrides
        // minWidth per size (icon-only buttons must be square).
        minWidth: sizeHeights.$3,
        justifyContent: "center",
      },
      false: {},
    },
    // Locked: applied AFTER `variant` so its styles win — used for CTAs
    // the operator can see but lacks the role to invoke. Orange border
    // preserved (brand affordance), muted fill, no press-bounce.
    locked: {
      true: {
        backgroundColor: "$surfaceMuted",
        borderColor: "$brandSecondary",
        color: "$colorMuted",
        cursor: "not-allowed",
        opacity: 0.85,
        hoverStyle: {
          backgroundColor: "$surfaceMuted",
          borderColor: "$brandSecondary",
          color: "$colorMuted",
        },
        pressStyle: {
          backgroundColor: "$surfaceMuted",
          borderColor: "$brandSecondary",
          color: "$colorMuted",
          scale: 1,
        },
      },
      false: {},
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "$3",
    icon: false,
    locked: false,
  },
} as const;

const StyledButton = styled(
  TamaguiButton,
  buttonConfig as unknown as Parameters<typeof styled>[1],
);

/**
 * The frame `asChild` renders through. NOT `StyledButton`, on purpose.
 *
 * `StyledButton` is `styled(TamaguiButton)`, and TamaguiButton is
 * `ButtonFrame.styleable(...)`: a styled HOC. Tamagui's outer createComponent
 * short-circuits `asChild` straight to `Slot` with the raw children and props,
 * so the inner Button, the part that turns variant / size / frame config into
 * styles, never renders. The child got our raw inline `style` (the uppercase)
 * and nothing else: a MANAGE link measured 0px border and 19.5px tall in
 * Chrome. A plain `styled(View)` resolves its own styles to atomic classes,
 * and `Slot` merges className + style + handlers onto the child.
 *
 * - Class mode (no `disableClassName`): Tamagui never attaches its runtime
 *   hover/press listeners when `asChild` is set, so hover / press / focus
 *   only work as compiled `:hover` / `:active` / `:focus` CSS rules.
 * - `validStyles: stylePropsText`: a View drops text styles (fontSize,
 *   fontWeight, letterSpacing, fontFamily) by default. A slotted child has no
 *   ButtonText to carry them, so the frame must emit them for the label to
 *   inherit.
 * - No `role` / `tag`: the child's own semantics (an <a> stays a link, a
 *   native <button type="submit"> stays a submit) are the point of asChild.
 * - `display: flex` is NOT here: under asChild Tamagui drops every style equal
 *   to its web View defaults (display flex, border-box, …), even when set
 *   explicitly, so it never reaches the child. The <a> computed
 *   `display: block` and the label sat at the top of the box. The wrapper sets
 *   it inline instead (see the asChild branch below).
 */
const SlottedButtonFrame = styled(
  View,
  {
    ...buttonConfig,
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    textDecorationLine: "none",
  } as unknown as Parameters<typeof styled>[1],
  { validStyles: stylePropsText } as unknown as Parameters<typeof styled>[2],
  // Same variant/size/icon/locked surface as StyledButton (the config casts
  // above erase it from the inferred type).
) as unknown as typeof StyledButton;

// Re-exported for consumers of this file; the literal lives in a leaf module
// so NextLinkAnchor can share it without importing react-native.
export { BUTTON_SLOT_ATTRIBUTE };

export type ButtonSize = keyof typeof buttonConfig.variants.size;

export interface ButtonProps extends Omit<
  GetProps<typeof TamaguiButton>,
  "variant" | "size" | "icon"
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  /**
   * Locked affordance: the CTA is visible but not invokable. Renders the
   * orange brand border with a muted fill and forwards `disabled` /
   * `aria-disabled` so onPress is suppressed at runtime, and (on web) takes
   * the button out of the Tab order like any disabled Button. Put the "why"
   * in the aria-label and in visible text nearby. Use when an
   * operator lacks the role to perform the primary action but should
   * still see that the action exists.
   */
  locked?: boolean;
}

export const Button = forwardRef<TamaguiElement, ButtonProps>(
  (
    {
      style,
      variant = "primary",
      size = "$3",
      icon = false,
      locked = false,
      ...rest
    },
    ref,
  ) => {
    const flattenedStyle = Array.isArray(style)
      ? Object.assign(
          {},
          ...style.filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === "object",
          ),
        )
      : style;
    const mergedStyle = {
      textTransform: "uppercase" as const,
      ...(flattenedStyle && typeof flattenedStyle === "object"
        ? flattenedStyle
        : {}),
    } as NonNullable<GetProps<typeof TamaguiButton>["style"]>;

    // v2: icon-only buttons must be square — mirror the size's height as
    // minWidth ($4 / v2 "md" lands on the 44px touch target minimum).
    const iconSquareProps = icon
      ? { minWidth: sizeHeights[size] ?? sizeHeights.$3 }
      : undefined;

    if (process.env.NODE_ENV !== "production" && icon && !warnedIconA11y) {
      const restRecord = rest as Record<string, unknown>;
      const hasA11yLabel =
        restRecord["aria-label"] != null ||
        restRecord["aria-labelledby"] != null ||
        restRecord.accessibilityLabel != null;
      if (!hasA11yLabel) {
        // v2 requires an accessible name on icon-only buttons — the icon
        // glyph alone is invisible to screen readers. Warned once per
        // session to avoid flooding consoles on re-rendering surfaces.
        warnedIconA11y = true;
        console.warn(
          "[@th/ui Button] icon-only button rendered without aria-label / aria-labelledby / accessibilityLabel — v2 requires an accessible name. (Further occurrences suppressed.)",
        );
      }
    }

    // RN has no View→Text style inheritance, so the wrapper-style uppercase
    // below never reaches the label on native — forward it to ButtonText via
    // textProps there. Caller-supplied textProps still win via the merge.
    //
    // On web the label ALSO needs `color: inherit`. Tamagui hoists the variant's
    // resting `color` onto ButtonText as its OWN css color, which then shadows
    // the frame — and `hoverStyle`/`pressStyle` colors only ever land on the
    // FRAME, never on ButtonText. So every variant whose label color changes
    // between rungs silently kept its RESTING label through hover and press.
    // On `outlined` that painted #B93312 text on the #B93312 hover fill: a 1:1
    // label, i.e. the button rendered as a blank orange rectangle (verified in
    // Chrome on /sign-up). Inheriting from the frame makes the label track all
    // three rungs, which is what the variant's documented ladder always assumed.
    // Web-only: `inherit` is not a valid RN color.
    const restForTextProps = rest as { textProps?: Record<string, unknown> };
    const mergedTextProps = {
      textProps: {
        ...(Platform.OS === "web"
          ? { color: "inherit" as const }
          : { textTransform: "uppercase" as const }),
        ...(restForTextProps.textProps ?? {}),
      },
    };

    // Locked is purely a visual + interaction lock — also forward the
    // native `disabled` + `aria-disabled` so click/press handlers don't
    // fire and assistive tech reports the state correctly. Caller-set
    // `disabled` still wins (non-locked but disabled is valid too).
    const restProps = rest as Record<string, unknown>;
    const callerDisabled = restProps.disabled === true;
    const effectiveDisabled = callerDisabled || locked;
    // `locked` is a custom variant added via the styled-config cast;
    // the Tamagui type erases it, so spread it through an untyped
    // bag (same pattern used for `rest` above).
    //
    // `aria-disabled` is only ADDED here, never written as `undefined`. This bag
    // is spread LAST, so an unconditional `"aria-disabled": ... || undefined`
    // silently erased a caller-supplied value (object spread overwrites with an
    // explicit undefined). NavigationRail's "an aria-disabled the styled Button
    // strips anyway" comment was describing exactly this bug.
    //
    // The pattern that needs it: a pending action that must say "busy, don't
    // press" WITHOUT taking the `disabled` prop, because `disabled` also applies
    // `disabledStyle` (opacity 0.45) — which dims the very spinner/label that IS
    // the progress feedback. Such a caller passes `aria-busy` + `aria-disabled`
    // and guards the press in its own handler.
    const lockedProps: Record<string, unknown> = {
      locked,
      disabled: effectiveDisabled,
    };
    if (effectiveDisabled) lockedProps["aria-disabled"] = true;

    // An inert button leaves the Tab order. Tamagui never emits a native
    // `disabled` here — it renders `aria-disabled="true" tabindex="0"` (measured
    // in the live app) — so without this a keyboard user could Tab onto a dead
    // "Confirm", press Enter, and get nothing back.
    //
    // `tabIndex={-1}`, deliberately NOT a native `disabled`: callers pass
    // `disabled={busy}` during a submit, when the button the user just pressed
    // holds focus. Native `disabled` can blur it and drop focus to <body>; a
    // `-1` element keeps focus it already has and only stops being a Tab stop.
    // A virtual-cursor screen reader still reaches it and hears "dimmed".
    //
    // Scope: only the `disabled` prop and `locked` (both inert). A caller that
    // passes `aria-disabled` alone (the aria-busy pattern above) is untouched
    // and stays focusable. A caller-supplied `tabIndex` wins. Web only: on
    // React Native `tabIndex` maps onto `focusable`, and nothing native renders
    // this atom today, so native behaviour is left alone.
    if (
      effectiveDisabled &&
      Platform.OS === "web" &&
      restProps.tabIndex == null
    ) {
      lockedProps.tabIndex = -1;
    }

    if (restProps.asChild) {
      // See SlottedButtonFrame. `textProps` is dropped: there is no ButtonText
      // to receive it, and Slot would spread it onto the child's DOM node.
      const {
        children,
        textProps: _textProps,
        onClick,
        onPress,
        onPressIn,
        onPressOut,
        ...slotRest
      } = restProps as Record<string, unknown> & {
        onClick?: (event: unknown) => void;
        onPress?: (event: unknown) => void;
        onPressIn?: (event: unknown) => void;
        onPressOut?: (event: unknown) => void;
      };
      // Under asChild Tamagui forwards only `onPress` (as the child's
      // onClick) and drops a raw `onClick`. `<Link legacyBehavior passHref>`
      // injects exactly that onClick — its client-side navigation — so route
      // it into the press handler (onPress for an HTML child, the child's own
      // onClick for a component child; see below) or those links fall back
      // to full page loads.
      type ClickHandler = (event: unknown) => void;
      type ClickableChild = ReactElement<{
        onClick?: ClickHandler;
        onAuxClick?: ClickHandler;
        disabled?: boolean;
      }>;
      const element = isValidElement(children)
        ? (children as ClickableChild)
        : null;
      // Tamagui's Slot maps `onPress` → `onClick` only for an HTML child
      // (`typeof type === "string"`). A component child (NextLinkAnchor) gets
      // `onPress` verbatim, NextLinkAnchor forwards every `on*` prop to
      // next/link, and next/link spreads it onto the <a>: React logs
      // "Unknown event handler property `onPress`" and the handler never
      // runs. So the slot's onPress is only ever passed to an HTML child; a
      // component child gets the same handling folded into its onClick.
      const htmlChild = !!element && typeof element.type === "string";
      const nativeControlChild =
        !!element && (element.type === "button" || element.type === "input");
      // Disabled + a link (or any non-native) child: Tamagui passes onPress
      // through whatever `disabled` says, and a link has no native disabled,
      // so a bare <a href> still followed its href and a legacyBehavior
      // Link's onClick still pushed the route. Swallow the click instead:
      // call neither handler and cancel the default action.
      const blockClick: ClickHandler = (event) => {
        (event as { preventDefault?: () => void } | null)?.preventDefault?.();
      };
      const callerPress: ClickHandler | undefined =
        onClick && onPress
          ? (event) => {
              onClick(event);
              onPress(event);
            }
          : (onPress ?? onClick);
      const blocked = effectiveDisabled && !nativeControlChild;
      const pressHandler = blocked ? blockClick : callerPress;
      // onPressIn / onPressOut need no remapping: under asChild Tamagui's own
      // createComponent (getWebEvents) turns them into onMouseDown / onMouseUp
      // and onTouchStart / onTouchEnd on the frame, BEFORE Slot, for HTML and
      // component children alike (measured: next/link receives onMouseDown /
      // onMouseUp, never onPressIn). Slot's own pressMap never sees them. What
      // that path does not do is honour `disabled`: an inert link, or an inert
      // native <button> child (Chrome still fires mousedown / touchstart on a
      // disabled form control), still ran them. The normal Button suppresses
      // them when disabled, so any disabled or locked slot drops them,
      // whatever the child; otherwise they pass through.
      const pressInOut = effectiveDisabled
        ? null
        : {
            ...(onPressIn ? { onPressIn } : null),
            ...(onPressOut ? { onPressOut } : null),
          };
      // The child itself:
      // - native <button>/<input>, disabled: disabled natively, or a
      //   `disabled` Cancel/Save still fires its onClick and submits the form.
      // - any other child, blocked: its own onClick is replaced too. Slot runs
      //   the child's handler BEFORE the slot's, so the slot's preventDefault
      //   alone would come too late for it. (On a NextLinkAnchor child this
      //   onClick reaches next/link, which skips navigation once
      //   defaultPrevented is set.) It also gets aria-disabled + tabIndex -1,
      //   and an onAuxClick that cancels a middle-click: that fires auxclick,
      //   not click, and opened the href in a new tab. The href stays: an <a>
      //   without one stops being a link (no role, so "link, dimmed" is lost to
      //   screen readers), next/link requires it, and what is left (context
      //   menu "Open in new tab", dragging the link out) is a deliberate
      //   two-step act on a destination that is visible in the DOM anyway.
      // - a component child with a caller handler: composed into its onClick,
      //   child first, then the caller's unless the child prevented default,
      //   which is the order Slot uses for an HTML child.
      let child: unknown = children;
      if (element && effectiveDisabled && nativeControlChild) {
        child = cloneElement(element, { disabled: true });
      } else if (element && blocked) {
        child = cloneElement(element, {
          onClick: blockClick,
          onAuxClick: blockClick,
        });
      } else if (element && !htmlChild && pressHandler) {
        const childOnClick = element.props.onClick;
        child = cloneElement(element, {
          onClick: (event: unknown) => {
            childOnClick?.(event);
            if (
              (event as { defaultPrevented?: boolean } | null)
                ?.defaultPrevented
            ) {
              return;
            }
            pressHandler(event);
          },
        });
      }
      const slotPress = htmlChild ? pressHandler : undefined;
      // Inline because Tamagui strips a default-valued `display` under asChild
      // (see SlottedButtonFrame). A caller's own `display` prop wins, as does
      // a `display` inside any media prop (`$sm={{ display: "none" }}`):
      // an inline display would beat that media class. A caller's
      // `style.display` wins via the spread.
      const callerSetsDisplay =
        slotRest.display != null ||
        Object.entries(slotRest).some(
          ([key, value]) =>
            key.startsWith("$") &&
            !!value &&
            typeof value === "object" &&
            "display" in (value as Record<string, unknown>),
        );
      const slotStyle =
        !callerSetsDisplay
          ? ({
              display: "flex",
              ...(mergedStyle as Record<string, unknown>),
            } as typeof mergedStyle)
          : mergedStyle;
      return (
        <SlottedButtonFrame
          ref={ref}
          variant={variant as never}
          size={size as never}
          icon={icon as never}
          {...iconSquareProps}
          style={slotStyle}
          {...{ [BUTTON_SLOT_ATTRIBUTE]: "" }}
          {...slotRest}
          {...(slotPress ? { onPress: slotPress as never } : null)}
          {...pressInOut}
          {...lockedProps}
        >
          {child as ReactElement}
        </SlottedButtonFrame>
      );
    }

    return (
      <StyledButton
        ref={ref}
        variant={variant as never}
        size={size as never}
        icon={icon as never}
        {...iconSquareProps}
        style={mergedStyle}
        {...restProps}
        {...mergedTextProps}
        {...lockedProps}
      />
    );
  },
);

Button.displayName = "Button";
