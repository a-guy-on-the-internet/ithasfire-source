import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { HTMLAttributeAnchorTarget } from "react";
import { Anchor } from "tamagui";
import { NextLinkAnchor } from "./NextLinkAnchor";

type AnchorProps = ComponentPropsWithoutRef<typeof Anchor>;

export interface LinkProps extends Omit<AnchorProps, "href"> {
  href?: unknown;
  // next/link-like props (optional)
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
  children?: ReactNode;
}

const looksExternal = (href: unknown) => {
  if (!href) return false;
  const s = String(href);
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("//") ||
    s.startsWith("mailto:") ||
    s.startsWith("tel:")
  );
};

/**
 * Thin, themed Link component for app-wide consistency.
 * - Internal (relative) links use `NextLinkAnchor` so Next handles navigation.
 * - External links use Tamagui's `Anchor`.
 *
 * This component intentionally stays very small — styling is handled by
 * callers (Tamagui `Text`, `Button`, or inline styles) so we don't
 * introduce visual regressions.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  (
    {
      href,
      children,
      target,
      rel,
      prefetch,
      replace,
      scroll,
      shallow,
      ...anchorProps
    },
    ref,
  ) => {
    // Treat protocol links and explicit absolute URLs as external
    const isExternal = typeof href === "string" && looksExternal(href);

    if (isExternal) {
      const resolvedRel =
        rel ?? (target === "_blank" ? "noopener noreferrer" : undefined);
      return (
        <Anchor
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          href={href as any}
          ref={ref}
          target={target}
          rel={resolvedRel}
          {...anchorProps}
        >
          {children}
        </Anchor>
      );
    }

    // Internal / relative link — delegate to NextLinkAnchor which will
    // gracefully fall back when Next isn't available (storybook/tests).
    return (
      <NextLinkAnchor
        href={href as any}
        prefetch={prefetch}
        replace={replace}
        scroll={scroll}
        shallow={shallow}
        target={target}
        rel={rel}
        {...anchorProps}
        ref={ref}
      >
        {children}
      </NextLinkAnchor>
    );
  },
);

Link.displayName = "Link";
