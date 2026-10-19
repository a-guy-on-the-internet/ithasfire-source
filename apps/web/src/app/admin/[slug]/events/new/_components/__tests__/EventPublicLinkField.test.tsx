/**
 * The builder's "Public link" field.
 *
 * What this pins:
 *  - it renders ONLY when a stranger could open the link — nothing at all (no
 *    label, no gutter) for a DRAFT or an event cancelled without going live;
 *  - it shows the absolute SHORT URL without the scheme, and the long
 *    canonical URL for a legacy event with no short ID;
 *  - Copy is the handler it is given (the builder's own, so both copy paths
 *    stay one path); View event is a real new-tab link to the canonical page;
 *  - on phones the actions sit on their own row, View event icon-only with an
 *    accessible name.
 *
 * MOCKS: tamagui / @th/ui reduced to DOM elements forwarding data- and aria-
 * attributes; `useIsMobile` is switchable.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const PASS_PROP = /^(data-|aria-)|^(id|role|href|target|rel)$/;
const domProps = (rest: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PASS_PROP.test(key)) out[key] = value;
  }
  return out;
};

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => React.createElement("div", domProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => React.createElement("span", domProps(rest), children),
    // `tag="a"` is a real Button capability; honour it so the link
    // assertions test the component, not the mock.
    Button: ({
      children,
      onPress,
      tag,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      tag?: string;
      [key: string]: unknown;
    }) =>
      tag === "a"
        ? React.createElement("a", domProps(rest), children)
        : React.createElement(
            "button",
            { type: "button", onClick: onPress, ...domProps(rest) },
            children,
          ),
    useTranslations: () => (key: string) => key,
  };
});

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));

const { EventPublicLinkField } = await import("../EventPublicLinkField");

const PUBLISHED_AT = new Date("2026-09-01T12:00:00.000Z");
const SLUG = "demo/us/general/lower-east-side-charity-fundraiser--ab12cd";
const SHORT_ID = "wqsdk6pxzi";

const onCopy = vi.fn();

const renderField = (
  overrides: Partial<{
    status: "DRAFT" | "PUBLISHED" | "CANCELLED" | "COMPLETED" | "ARCHIVED";
    publishedAt: Date | null;
    slug: string | null;
    shortId: string | null;
  }> = {},
) =>
  render(
    <EventPublicLinkField
      status="PUBLISHED"
      publishedAt={PUBLISHED_AT}
      slug={SLUG}
      shortId={SHORT_ID}
      onCopy={onCopy}
      {...overrides}
    />,
  );

beforeEach(() => {
  mobile.value = false;
  onCopy.mockReset();
});

describe("EventPublicLinkField", () => {
  it("a published event shows its absolute short URL, without the scheme", () => {
    renderField();
    expect(screen.getByTestId("event-public-link")).toBeInTheDocument();
    expect(screen.getByText("admin.ebPublicLink")).toBeInTheDocument();
    expect(screen.getByTestId("event-public-link-url")).toHaveTextContent(
      `${window.location.host}/e/${SHORT_ID}`,
    );
    expect(
      screen.getByTestId("event-public-link-url").textContent,
    ).not.toMatch(/^https?:/);
  });

  it("renders NOTHING for a DRAFT — though a draft has a slug and short ID from creation", () => {
    const { container } = renderField({ status: "DRAFT", publishedAt: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a CANCELLED event that was never published", () => {
    const { container } = renderField({
      status: "CANCELLED",
      publishedAt: null,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("stays for a CANCELLED event that WAS live (its link still resolves)", () => {
    renderField({ status: "CANCELLED", publishedAt: PUBLISHED_AT });
    expect(screen.getByTestId("event-public-link-url")).toHaveTextContent(
      `/e/${SHORT_ID}`,
    );
  });

  it("a legacy event without a short ID shows the long canonical URL", () => {
    renderField({ shortId: null });
    expect(screen.getByTestId("event-public-link-url")).toHaveTextContent(
      `${window.location.host}/events/${SLUG}`,
    );
  });

  it("Copy link calls the builder's handler", () => {
    renderField();
    fireEvent.click(screen.getByTestId("event-public-link-copy"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("event-public-link-copy")).toHaveTextContent(
      "eventDetail.shareCopyLink",
    );
  });

  it("View event is a real new-tab link to the canonical page, noopener", () => {
    renderField();
    const view = screen.getByRole("link", { name: /pageActions\.viewEvent/ });
    expect(view).toBe(screen.getByTestId("event-public-link-view"));
    expect(view).toHaveAttribute("href", `/events/${SLUG}`);
    expect(view).toHaveAttribute("target", "_blank");
    expect(view).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("labels the group so the actions are announced as the public link's", () => {
    renderField();
    const group = screen.getByRole("group", { name: "admin.ebPublicLink" });
    expect(group).toContainElement(screen.getByTestId("event-public-link-copy"));
  });

  it("on a phone View event is icon-only with an accessible name", () => {
    mobile.value = true;
    renderField();
    const view = screen.getByRole("link", { name: "pageActions.viewEvent" });
    expect(view).toHaveAttribute("aria-label", "pageActions.viewEvent");
    expect(view).toHaveAttribute("href", `/events/${SLUG}`);
    expect(view).not.toHaveTextContent("pageActions.viewEvent");
    // Copy keeps its visible label.
    expect(screen.getByTestId("event-public-link-copy")).toHaveTextContent(
      "eventDetail.shareCopyLink",
    );
  });
});
