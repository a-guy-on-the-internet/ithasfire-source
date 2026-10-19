import { render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Forward everything a real anchor would carry (tabIndex, aria-*, className,
// handlers) so the a11y assertions below exercise MarqueeBand's real props.
// `prefetch` is a NextLinkAnchor prop, not a DOM attribute — strip it.
vi.mock("@th/ui", () => ({
  NextLinkAnchor: ({
    children,
    prefetch: _prefetch,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children?: ReactNode;
    prefetch?: boolean;
  }) => <a {...rest}>{children}</a>,
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ prefetch: vi.fn() }),
}));

import { MarqueeBand, type MarqueeItem } from "../MarqueeBand";

const makeItems = (count: number): MarqueeItem[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `item-${i}`,
    href: `/events/show-${i}`,
    ariaLabel: `Show ${i}`,
    segments: [
      { text: `SHOW ${i}`, tone: "primary" as const },
      { text: "· extra", tone: "muted" as const },
    ],
  }));

describe("MarqueeBand", () => {
  it("renders null below minItems (default 3) — no skeleton, no chrome", () => {
    const { container } = render(
      <MarqueeBand items={makeItems(2)} sectionAriaLabel="Test band" />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("respects a caller-supplied minItems", () => {
    render(
      <MarqueeBand
        items={makeItems(2)}
        minItems={2}
        sectionAriaLabel="Test band"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Test band" }),
    ).toBeInTheDocument();
  });

  it("exposes exactly one accessible link per item; duplicate copies are aria-hidden with tabIndex -1", () => {
    const { container } = render(
      <MarqueeBand items={makeItems(3)} sectionAriaLabel="Test band" />,
    );

    // getAllByRole excludes aria-hidden subtrees — only the first copy's
    // links are in the accessibility tree, one per item.
    const accessibleLinks = screen.getAllByRole("link");
    expect(accessibleLinks).toHaveLength(3);
    expect(accessibleLinks.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Show 0",
      "Show 1",
      "Show 2",
    ]);
    for (const link of accessibleLinks) {
      expect(link).not.toHaveAttribute("tabindex");
    }

    // Pre-measurement the band renders 2 copies; every anchor beyond the
    // first copy is decorative: aria-hidden and out of the tab order.
    const allAnchors = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a.marquee-band-link"),
    );
    expect(allAnchors).toHaveLength(6);
    const decorative = allAnchors.filter((a) => !accessibleLinks.includes(a));
    expect(decorative).toHaveLength(3);
    for (const anchor of decorative) {
      expect(anchor).toHaveAttribute("aria-hidden", "true");
      expect(anchor).toHaveAttribute("tabindex", "-1");
    }
  });

  it("injects the keyframes <style> exactly once across mounts", () => {
    render(<MarqueeBand items={makeItems(3)} sectionAriaLabel="Band one" />);
    render(<MarqueeBand items={makeItems(4)} sectionAriaLabel="Band two" />);

    const styles = document.querySelectorAll("#marquee-band-scroll-keyframes");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("@keyframes marquee-band-scroll");
  });
});
