import { createElement, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Tamagui stacks render as their `tag` (default div) and forward only the
// aria-/data- attributes the component relies on, so landmark semantics stay
// assertable without pulling in the real style engine.
vi.mock("tamagui", () => {
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("aria-") || key.startsWith("data-")) {
        domProps[key] = value;
      }
    }
    return createElement(tag ?? "div", domProps, children);
  };
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      // Mirror the real NextLinkAnchor: it forwards aria-/data- attributes AND
      // every `on*` handler (incl. onClick) to the underlying anchor.
      if (
        key.startsWith("aria-") ||
        key.startsWith("data-") ||
        /^on[A-Z]/.test(key)
      ) {
        domProps[key] = value;
      }
    }
    return (
      <a href={href} {...domProps}>
        {children}
      </a>
    );
  },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("lucide-react", () => ({
  ChevronRight: () => null,
}));

vi.mock("@/lib/design-tokens", () => ({
  DANGER: "var(--danger)",
  FOREGROUND: "var(--color)",
  MUTED_TEXT: "var(--colorMuted)",
}));

import { SettingsNav, type SettingsNavGroup, type SettingsNavItem } from "../SettingsNav";

const icon = <span data-testid="icon" />;

function item(overrides: Partial<SettingsNavItem> & { id: string }): SettingsNavItem {
  return {
    label: overrides.id,
    icon,
    href: `/account/settings/${overrides.id}`,
    ...overrides,
  };
}

const GROUPS: SettingsNavGroup[] = [
  {
    id: "account",
    label: "Account",
    items: [
      item({ id: "profile", label: "Profile" }),
      item({ id: "security", label: "Security" }),
    ],
  },
  {
    id: "work",
    label: "Your work",
    items: [item({ id: "bookings", label: "Bookings", count: 3 })],
  },
];

const FOOTER: SettingsNavItem[] = [
  item({
    id: "danger",
    label: "Delete account",
    href: "/account/settings/danger",
    tone: "danger",
  }),
];

describe("SettingsNav", () => {
  it("renders every group header and every item label", () => {
    render(<SettingsNav groups={GROUPS} activeId="profile" />);

    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Your work")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Bookings")).toBeInTheDocument();
  });

  it("exposes a single labelled navigation landmark", () => {
    render(<SettingsNav groups={GROUPS} activeId="profile" />);

    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).toBeInTheDocument();
  });

  it("marks only the active item with aria-current=page", () => {
    render(
      <SettingsNav groups={GROUPS} footerItems={FOOTER} activeId="security" />,
    );

    const links = screen.getAllByRole("link");
    const current = links.filter(
      (link) => link.getAttribute("aria-current") === "page",
    );

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Security");
    // Every other link is explicitly un-marked, not just differently marked.
    for (const link of links) {
      if (link === current[0]) continue;
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("renders a group's emptyState instead of items when it has none", () => {
    const groups: SettingsNavGroup[] = [
      GROUPS[0]!,
      {
        id: "work",
        label: "Your work",
        items: [],
        emptyState: <span>Set up your work profile</span>,
      },
    ];

    render(<SettingsNav groups={groups} activeId="profile" />);

    expect(screen.getByText("Your work")).toBeInTheDocument();
    expect(screen.getByText("Set up your work profile")).toBeInTheDocument();
    expect(screen.queryByText("Bookings")).not.toBeInTheDocument();
  });

  it("renders footerItems after all groups", () => {
    render(
      <SettingsNav groups={GROUPS} footerItems={FOOTER} activeId="profile" />,
    );

    const labels = screen
      .getAllByRole("link")
      .map((link) => link.textContent?.replace(/\d+/g, "").trim());

    expect(labels).toEqual([
      "Profile",
      "Security",
      "Bookings",
      "Delete account",
    ]);
  });

  it("renders items as anchors pointing at their href", () => {
    render(
      <SettingsNav groups={GROUPS} footerItems={FOOTER} activeId="profile" />,
    );

    expect(screen.getByTestId("settings-nav-item-security")).toHaveAttribute(
      "href",
      "/account/settings/security",
    );
    expect(screen.getByTestId("settings-nav-item-danger")).toHaveAttribute(
      "href",
      "/account/settings/danger",
    );
  });

  it("renders a count badge for an item that has one", () => {
    render(<SettingsNav groups={GROUPS} activeId="profile" />);

    expect(screen.getByText("3")).toBeInTheDocument();
    // Items without a count get no badge.
    expect(
      screen.getByTestId("settings-nav-item-profile").textContent,
    ).toBe("Profile");
  });

  it("lets a badged item state its count in words", () => {
    // Without this the link's accessible name is "Bookings 3" — a numeral with
    // no unit, which is what the badge markup produces on its own.
    const groups: SettingsNavGroup[] = [
      {
        id: "work",
        label: "Your work",
        items: [
          item({
            id: "bookings",
            label: "Bookings",
            count: 3,
            ariaLabel: "Bookings, 3 awaiting response",
          }),
        ],
      },
    ];

    render(<SettingsNav groups={groups} activeId="profile" />);

    expect(
      screen.getByRole("link", { name: "Bookings, 3 awaiting response" }),
    ).toBeInTheDocument();
    // The visible numeral stays on screen; it is just no longer announced
    // twice.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("leaves the accessible name computed when no ariaLabel is given", () => {
    render(<SettingsNav groups={GROUPS} activeId="profile" />);

    expect(
      screen.getByTestId("settings-nav-item-bookings"),
    ).not.toHaveAttribute("aria-label");
  });

  describe("onSelect click interception", () => {
    it("intercepts a plain left-click: calls onSelect and prevents navigation", () => {
      const onSelect = vi.fn();
      render(
        <SettingsNav groups={GROUPS} activeId="profile" onSelect={onSelect} />,
      );

      // fireEvent.click returns false when the handler called preventDefault
      // on the (cancelable) event — i.e. the real navigation was suppressed.
      const notPrevented = fireEvent.click(
        screen.getByTestId("settings-nav-item-security"),
      );

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(
        "security",
        "/account/settings/security",
      );
      expect(notPrevented).toBe(false);
    });

    it("does NOT intercept a modified click, so open-in-new-tab still navigates", () => {
      const onSelect = vi.fn();
      render(
        <SettingsNav groups={GROUPS} activeId="profile" onSelect={onSelect} />,
      );

      for (const modifiers of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        // Non-left button (e.g. middle-click).
        { button: 1 },
      ]) {
        const notPrevented = fireEvent.click(
          screen.getByTestId("settings-nav-item-security"),
          modifiers,
        );
        // Default not prevented → the browser performs the real navigation.
        expect(notPrevented).toBe(true);
      }

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("leaves rows as plain links when no onSelect is given", () => {
      render(<SettingsNav groups={GROUPS} activeId="profile" />);

      // No handler wired → a plain click is not prevented (real navigation).
      const notPrevented = fireEvent.click(
        screen.getByTestId("settings-nav-item-security"),
      );
      expect(notPrevented).toBe(true);
    });
  });
});
