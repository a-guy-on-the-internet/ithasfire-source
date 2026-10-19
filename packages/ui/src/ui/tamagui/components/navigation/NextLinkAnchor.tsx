import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { HTMLAttributeAnchorTarget } from "react";
import { Anchor } from "tamagui";

import { BUTTON_SLOT_ATTRIBUTE } from "../forms/button-slot";

// Storybook (especially react-vite) may run without Next's runtime present.
// Lazily resolve next/link at runtime and gracefully fall back.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNextLink = (): any | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("next/link") as { default: unknown }).default;
  } catch {
    return null;
  }
};

// Non-handler, non-aria/data props that are safe to pass to a DOM <a>.
const DOM_SAFE_ANCHOR_PROPS = new Set([
  "style",
  "className",
  "role",
  "id",
  "title",
  "tabIndex",
  "download",
  "hrefLang",
  "referrerPolicy",
]);

interface NextLinkAnchorProps extends Omit<
  ComponentPropsWithoutRef<typeof Anchor>,
  "href"
> {
  href: unknown;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
  children?: ReactNode;
  /**
   * DOM anchor click handler. Tamagui's `Anchor` types only `onPress`, but this
   * adapter renders a real `next/link` `<a>` (and a DOM `Anchor` in the
   * fallback), and already forwards every `on*` handler to it — so the web
   * `onClick` is the correct, supported way to intercept clicks (e.g. shallow
   * `history.pushState` routing that calls `preventDefault()`).
   */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

/**
 * A small adapter that renders a `next/link` around content with Tamagui
 * styling. Uses the modern Next.js `Link` API (no `legacyBehavior`).
 *
 * When Next.js is not available (Storybook, tests), falls back to
 * Tamagui's `Anchor` component.
 *
 * Exported from `@th/ui` so apps can reuse a single implementation.
 */
export const NextLinkAnchor = forwardRef<
  HTMLAnchorElement,
  NextLinkAnchorProps
>(
  (
    // `shallow` is accepted for back-compat but ignored (removed in modern Next.js)
    {
      href,
      prefetch,
      replace,
      scroll,
      shallow: _shallow,
      children,
      target,
      rel,
      ...anchorProps
    },
    ref,
  ) => {
    const resolvedRel =
      rel ?? (target === "_blank" ? "noopener noreferrer" : undefined);

    const NextLink = getNextLink();

    if (!NextLink) {
      return (
        <Anchor
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          href={href as any}
          ref={ref}
          target={target}
          rel={resolvedRel}
          display="flex"
          alignItems="center"
          {...anchorProps}
        >
          {children}
        </Anchor>
      );
    }

    // Modern Next.js Link renders its own <a> element. Forward the DOM-safe
    // subset of the remaining props to it — event handlers (onClick,
    // onMouseEnter, onFocus…), aria-*/data-* attributes, and a small
    // allowlist — with caller `style` merged over the base. Tamagui-only
    // style props (display, alignItems, space tokens…) are NOT forwarded:
    // they aren't valid DOM attributes and would emit React unknown-prop
    // warnings; they only take effect in the Anchor fallback branch above.
    const domSafeProps: Record<string, unknown> = {};
    let callerStyle: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(
      anchorProps as Record<string, unknown>,
    )) {
      if (value === undefined) continue;
      if (key === "style" && value && typeof value === "object") {
        callerStyle = value as Record<string, unknown>;
      } else if (
        /^on[A-Z]/.test(key) ||
        key.startsWith("aria-") ||
        key.startsWith("data-") ||
        DOM_SAFE_ANCHOR_PROPS.has(key)
      ) {
        domSafeProps[key] = value;
      }
    }

    // Slotted by `<Button asChild>` (it puts BUTTON_SLOT_ATTRIBUTE on its
    // child): the button's classes carry the display, alignment and the
    // variant's colour ladder. Inline defaults would shadow them, and
    // `color: inherit` turned every variant's label into the surrounding text
    // colour.
    const slottedByButton = BUTTON_SLOT_ATTRIBUTE in domSafeProps;
    const baseStyle = slottedByButton
      ? { textDecoration: "none" }
      : {
          display: "flex",
          alignItems: "center",
          textDecoration: "none",
          color: "inherit",
        };

    return (
      <NextLink
        href={href as string}
        prefetch={prefetch}
        replace={replace}
        scroll={scroll}
        ref={ref}
        target={target}
        rel={resolvedRel}
        {...domSafeProps}
        style={{
          ...baseStyle,
          ...callerStyle,
        }}
      >
        {children}
      </NextLink>
    );
  },
);

NextLinkAnchor.displayName = "NextLinkAnchor";
