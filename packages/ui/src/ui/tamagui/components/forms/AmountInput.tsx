"use client";

import { forwardRef, useCallback, useEffect, useRef, type ComponentRef } from "react";
import { Platform } from "react-native";
import { Stack, styled } from "tamagui";

import { Text } from "../typography/Text";
import { TextInput, type TextInputProps } from "./TextInput";

// ─────────────────────────────────────────────────────────────────────────
// AmountInput — a `TextInput` with a currency/percent symbol rendered as a
// proper INSET inside the bordered frame, flush with an edge and vertically
// centered, instead of a sibling element floating outside the border.
//
// This mirrors the exact technique `TextInput` already uses for its
// right-side status icon / clear button (`StatusIconWrapper` / `ClearButton`
// in TextInput.tsx): an absolutely-positioned overlay sized to the frame,
// paired with extra padding on the real input so typed text never sits under
// the glyph. Applied here to a left-side `prefix` ("$") and/or right-side
// `suffix` ("%"), so the whole field reads as ONE bordered box.
//
// Used wherever a field needs a symbol or stem INSIDE its own frame:
//   · money/percent — tier price, promo value (dollars or percent, mutually
//     exclusive), promo min-order, promo max-discount. Single glyph, default
//     clearance.
//   · short text stems — the entity-page slug's "/p/" prefix. Multi-character
//     affixes must pass `prefixClearance` / `suffixClearance`; the default is
//     sized for one glyph and a wider affix would sit under the typed value.
//
// Despite the name this is NOT numeric-only: it adds an affix and the padding
// that clears it, and forwards everything else to `TextInput` untouched.
// ─────────────────────────────────────────────────────────────────────────

const AmountInputFrame = styled(Stack, {
  name: "IthasFireAmountInputFrame",
  position: "relative",
  justifyContent: "center",
});

const AffixWrapper = styled(Stack, {
  name: "IthasFireAmountInputAffix",
  position: "absolute",
  top: 0,
  bottom: 0,
  justifyContent: "center",
  pointerEvents: "none",
  variants: {
    side: {
      // Matches the inset TextInput's own StatusIconWrapper uses ("$3" from
      // the edge) so the symbol lines up with where input text itself starts.
      leading: { left: "$3" },
      trailing: { right: "$3" },
    },
  } as const,
});

// Clearance (px) for a single glyph ("$", "%") plus a small gap before the
// typed value — the same amount ("$6" token = 32px) TextInput uses to clear
// its own 16px status icon. Applied via `AFFIX_CLEARANCE_TOKEN` for
// server-rendered/no-JS output, and imperatively in px via
// `patchAffixClearance` (see below) so it actually wins in a real browser.
const AFFIX_CLEARANCE_TOKEN = "$6";
const AFFIX_CLEARANCE_PX = 32;

const isWeb = Platform.OS === "web";

/**
 * Resolve `node` (which may be the raw <input> or a Tamagui/RNW wrapper) to
 * the underlying HTMLInputElement on web. Same helper TextInput.tsx defines
 * privately for its own DOM-attribute patching.
 */
function resolveInputElement(node: unknown): HTMLInputElement | null {
  if (!isWeb || node == null) return null;
  if (node instanceof HTMLInputElement) return node;
  return (node as HTMLElement)?.querySelector?.("input") ?? null;
}

/**
 * Sets `padding-left`/`padding-right` directly on the DOM node with
 * `!important`.
 *
 * WHY THIS IS NECESSARY: `apps/web/src/app/globals.css` has a blanket
 * `input:not([type=...])... { padding: 10px 14px; }` reset. Its selector
 * specificity — an element selector plus six `:not([type=...])` clauses —
 * works out to (0,6,1), which beats every Tamagui atomic padding class
 * (`:root .foo`, (0,2,0)). That includes THIS component's own
 * `paddingLeft`/`paddingRight` prop overrides on `TextInput`: passing
 * `paddingLeft="$6"` compiles to an atomic class that silently loses the
 * cascade to the global reset, so the affix glyph visually OVERLAPS the
 * input's text/placeholder instead of sitting before it. Verified with a
 * live browser (`getComputedStyle` showed 14px, matching the global rule,
 * not the requested 32px) — jsdom-based unit tests can't catch this because
 * jsdom doesn't apply real cascade specificity.
 *
 * An inline `style` attribute with `!important` beats any non-`!important`
 * author stylesheet rule regardless of selector specificity, so patching the
 * DOM node directly is the only reliable fix. Same imperative-DOM-patch
 * pattern `TextInput.tsx` already uses for RNW's other attribute footguns
 * (see `patchInputDOM` there).
 */
function patchAffixClearance(
  el: HTMLInputElement | null,
  leftPx: number | undefined,
  rightPx: number | undefined,
) {
  if (!el) return;
  if (leftPx != null) {
    el.style.setProperty("padding-left", `${leftPx}px`, "important");
  } else if (el.style.paddingLeft) {
    el.style.removeProperty("padding-left");
  }
  if (rightPx != null) {
    el.style.setProperty("padding-right", `${rightPx}px`, "important");
  } else if (el.style.paddingRight) {
    el.style.removeProperty("padding-right");
  }
}

export type AmountInputProps = TextInputProps & {
  /**
   * Symbol rendered as an inset inside the input's border, flush with the
   * left edge (e.g. "$"). Omit for no leading symbol.
   */
  prefix?: string;
  /**
   * Symbol rendered as an inset inside the input's border, flush with the
   * right edge (e.g. "%"). Independent of `prefix` — pass either, both, or
   * neither. `suffix` is not designed to combine with `clearable`, which also
   * claims the right-side inset on the underlying `TextInput`.
   */
  suffix?: string;
  /**
   * Clearance (px) reserved for a MULTI-character prefix such as a URL stem
   * ("/p/"). The default suits a single glyph; a longer affix needs more or
   * the typed value starts underneath it. Only pass this when the affix is
   * wider than one character.
   */
  prefixClearance?: number;
  /** Same, for a multi-character `suffix`. */
  suffixClearance?: number;
};

type AmountInputElement = ComponentRef<typeof TextInput>;

export const AmountInput = forwardRef<AmountInputElement, AmountInputProps>(
  (
    {
      prefix,
      suffix,
      prefixClearance,
      suffixClearance,
      containerWidth,
      fullWidth,
      ...rest
    },
    ref,
  ) => {
    const resolvedFrameWidth = containerWidth ?? (fullWidth ? "100%" : 240);

    const domRef = useRef<HTMLInputElement | null>(null);
    const leftPx = prefix ? (prefixClearance ?? AFFIX_CLEARANCE_PX) : undefined;
    // `status` puts TextInput's own 16px icon in the right inset. TextInput
    // asks for the clearance via a Tamagui class, which the global
    // `input:not([type=…])` reset outranks (see patchAffixClearance) — so when
    // this component is already patching padding imperatively, patch the right
    // side too rather than let the value slide under the status icon.
    const rightPx = suffix
      ? (suffixClearance ?? AFFIX_CLEARANCE_PX)
      : rest.status
        ? AFFIX_CLEARANCE_PX
        : undefined;

    // Ref callback fires synchronously during the commit phase (before
    // paint), matching TextInput's own DOM-patch timing so there's no
    // flash of overlapping text.
    const refCallback = useCallback(
      (node: unknown) => {
        const el = resolveInputElement(node);
        domRef.current = el;
        patchAffixClearance(el, leftPx, rightPx);

        if (typeof ref === "function") {
          ref(node as never);
        } else if (ref) {
          (ref as React.MutableRefObject<unknown>).current = node;
        }
      },
      [leftPx, rightPx, ref],
    );

    // Re-assert after every render — same reasoning as TextInput's own
    // re-assert effect: an unrelated re-render can't be allowed to silently
    // drop the clearance since nothing else in this component re-derives it.
    useEffect(() => {
      patchAffixClearance(domRef.current, leftPx, rightPx);
    });

    return (
      <AmountInputFrame width={resolvedFrameWidth}>
        <TextInput
          ref={refCallback}
          {...rest}
          containerWidth={containerWidth}
          fullWidth={fullWidth}
          {...(prefix
            ? { paddingLeft: prefixClearance ?? AFFIX_CLEARANCE_TOKEN }
            : {})}
          {...(suffix
            ? { paddingRight: suffixClearance ?? AFFIX_CLEARANCE_TOKEN }
            : {})}
        />
        {prefix ? (
          <AffixWrapper side="leading">
            <Text variant="body" tone="muted">
              {prefix}
            </Text>
          </AffixWrapper>
        ) : null}
        {suffix ? (
          <AffixWrapper side="trailing">
            <Text variant="body" tone="muted">
              {suffix}
            </Text>
          </AffixWrapper>
        ) : null}
      </AmountInputFrame>
    );
  },
);

AmountInput.displayName = "AmountInput";
