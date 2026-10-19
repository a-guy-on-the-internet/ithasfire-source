/**
 * The consumer mobile bottom nav: four fixed destinations below 960px, one
 * page-contextual action in the raised centre slot, nothing at all on desktop.
 *
 * `NavigationBottomBar` (@th/ui) is stubbed — it needs a TamaguiProvider and a
 * theme in jsdom, and its own rendering is covered in `packages/ui`. The stub
 * mirrors only the contract this component depends on, and records the props
 * so the tab list, routes, active flags and the ABSENCE of a `testIdBase`
 * override can be asserted directly.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

// ── Viewport ────────────────────────────────────────────────────────────────
// jsdom's own matchMedia always reports `matches: false`, which would pin every
// test to the desktop branch. Drive it from a settable viewport width instead.
let viewportWidth = 390;

const setViewportWidth = (width: number) => {
  viewportWidth = width;
};

beforeEach(() => {
  viewportWidth = 390;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        get matches() {
          return max ? viewportWidth <= Number(max[1]) : false;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    },
  });
});

// ── Router ──────────────────────────────────────────────────────────────────
const push = vi.fn();
let pathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
}));

// ── @th/ui ──────────────────────────────────────────────────────────────────
type BarProps = {
  sections: Array<{
    id: string;
    label: string;
    items: Array<{
      id: string;
      label: string;
      route: string;
      active?: boolean;
      icon?: ReactNode;
    }>;
  }>;
  currentRoute: string;
  onSelect: (route: string, meta: unknown) => void;
  testIdBase?: string;
  centerAction?: {
    id: string;
    label: string;
    icon?: ReactNode;
    onPress: () => void;
    testId?: string;
  };
};

let lastBarProps: BarProps | null = null;

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  NavigationBottomBar: (props: BarProps) => {
    lastBarProps = props;
    return (
      <div data-testid={props.testIdBase ?? "navigation-bottom-bar"}>
        {props.sections.flatMap((section) =>
          section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`nav-item-${item.id}`}
              aria-pressed={Boolean(item.active)}
              onClick={() =>
                props.onSelect(item.route, { sectionId: section.id })
              }
            >
              {item.label}
            </button>
          )),
        )}
        {props.centerAction ? (
          <button
            type="button"
            data-testid={props.centerAction.testId ?? "nav-center"}
            onClick={props.centerAction.onPress}
          >
            {props.centerAction.label}
          </button>
        ) : null}
      </div>
    );
  },
}));

import { ConsumerBottomNav } from "../ConsumerBottomNav";
import {
  usePagePrimaryAction,
  useSupportOpener,
} from "../page-primary-action";

/** Stands in for SupportWidget, which publishes its open-panel action. */
const SupportPublisher = ({ onOpen }: { onOpen: () => void }) => {
  useSupportOpener(onOpen);
  return null;
};

const Publisher = ({
  label,
  onPress,
  enabled,
}: {
  label: string;
  onPress: () => void;
  enabled?: boolean;
}) => {
  usePagePrimaryAction({ label, onPress, enabled });
  return null;
};

afterEach(() => {
  lastBarProps = null;
  push.mockClear();
  pathname = "/";
});

const lookup = (catalog: Record<string, unknown>, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );

describe("ConsumerBottomNav", () => {
  it("renders the four consumer destinations at mobile widths", () => {
    render(<ConsumerBottomNav />);

    expect(screen.getByTestId("navigation-bottom-bar")).toBeInTheDocument();
    expect(lastBarProps?.sections).toHaveLength(1);
    expect(
      lastBarProps?.sections[0].items.map((item) => [item.id, item.route]),
    ).toEqual([
      ["home", "/"],
      ["search", "/search"],
      ["tickets", "/my-tickets"],
      // Support is a DESTINATION (2026-08-28), not a floating bubble; its
      // "route" is a sentinel that opens the panel in place. Account is not a
      // tab — it lives in the top navbar's avatar menu, and a fifth tab does
      // not fit beside the 64px centre square at 320px.
      ["support", "#support"],
    ]);
  });

  it("sends Home to /es from an /es page and lights it there (spanish-seo FR-006)", () => {
    pathname = "/es";
    render(<ConsumerBottomNav />);

    const home = lastBarProps?.sections[0].items.find((i) => i.id === "home");
    expect(home?.route).toBe("/es");
    expect(home?.active).toBe(true);

    fireEvent.click(screen.getByTestId("nav-item-home"));
    expect(push).toHaveBeenCalledWith("/es");
  });

  it("keeps Home on / from an English page", () => {
    pathname = "/events/category/music";
    render(<ConsumerBottomNav />);

    const home = lastBarProps?.sections[0].items.find((i) => i.id === "home");
    expect(home?.route).toBe("/");
    expect(home?.active).toBe(false);
  });

  it("renders nothing at desktop widths", () => {
    setViewportWidth(1280);
    render(<ConsumerBottomNav />);

    expect(screen.queryByTestId("navigation-bottom-bar")).toBeNull();
  });

  it.each([
    ["/sign-in", "auth surfaces render without the shell"],
    ["/admin/acme/orders", "AdminShell brings its own bottom bar"],
    // /sell is the one shell-wrapped route in this list: `AppChrome` does NOT
    // bypass `AppShell` for it, so without the prefix the consumer bar stacks
    // on `SellerShell`'s own `NavigationBottomBar`.
    ["/sell/listings", "SellerShell brings its own bottom bar"],
  ])("renders nothing on %s (%s)", (path) => {
    pathname = path;
    render(<ConsumerBottomNav />);

    expect(screen.queryByTestId("navigation-bottom-bar")).toBeNull();
  });

  it("keeps NavigationBottomBar's default testIdBase (the support widget measures it)", () => {
    render(<ConsumerBottomNav />);

    expect(lastBarProps?.testIdBase).toBeUndefined();
    expect(screen.getByTestId("navigation-bottom-bar")).toBeInTheDocument();
  });

  it.each([
    ["/", "home"],
    ["/search", "search"],
    ["/my-tickets/abc123", "tickets"],
  ])("marks the tab matching %s as active", (path, activeId) => {
    pathname = path;
    render(<ConsumerBottomNav />);

    const active = lastBarProps?.sections[0].items.filter(
      (item) => item.active,
    );
    expect(active?.map((item) => item.id)).toEqual([activeId]);
  });

  // Global navigation under a payment form is four ways to abandon a cart, so
  // both checkouts suppress the bar entirely and rely on their own single
  // "Back to event" exit. Resale is a checkout on a different path — it was
  // missing from the list until 2026-08-30.
  it.each([
    "/events/checkout/some-org/us/general/a-show",
    "/events/resale/2f0b6b52-0c33-4e2f-9f04-7f0c1a2b3c4d",
  ])("renders nothing on a checkout surface (%s)", (route) => {
    pathname = route;
    const { container } = render(<ConsumerBottomNav />);

    expect(container).toBeEmptyDOMElement();
    expect(lastBarProps).toBeNull();
  });

  // Whole path segments, not string prefixes: an EVENT whose slug happens to
  // start with "checkout" or "resale" is an ordinary event page and keeps the
  // bar (the event door reserves room for it at first paint).
  it.each(["/events/checkout", "/events/checkout/x", "/events/resale"])(
    "renders nothing on the route itself or beneath it (%s)",
    (route) => {
      pathname = route;
      render(<ConsumerBottomNav />);

      expect(screen.queryByTestId("navigation-bottom-bar")).toBeNull();
    },
  );

  it.each([
    "/events/checkout-night",
    "/events/resale-rave",
    "/sell-out-show",
    "/administer",
  ])("keeps the bar on a page that only shares a prefix (%s)", (route) => {
    pathname = route;
    render(<ConsumerBottomNav />);

    expect(screen.getByTestId("navigation-bottom-bar")).toBeInTheDocument();
  });

  it("leaves every tab inactive on an unrelated route", () => {
    pathname = "/events/some-show";
    render(<ConsumerBottomNav />);

    expect(
      lastBarProps?.sections[0].items.every((item) => item.active === false),
    ).toBe(true);
  });

  it("navigates to a tab's route when it is selected", () => {
    render(<ConsumerBottomNav />);

    fireEvent.click(screen.getByTestId("nav-item-tickets"));

    expect(push).toHaveBeenCalledWith("/my-tickets");
  });

  it("opens the support panel from the Support tab instead of navigating", () => {
    const onOpen = vi.fn();
    render(
      <>
        <SupportPublisher onOpen={onOpen} />
        <ConsumerBottomNav />
      </>,
    );

    lastBarProps?.onSelect("#support", {} as never);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("renders no centre action until a page publishes one", () => {
    render(<ConsumerBottomNav />);

    expect(lastBarProps?.centerAction).toBeUndefined();
    expect(screen.queryByTestId("consumer-bottom-nav-primary")).toBeNull();
  });

  it("renders the published centre action and invokes its handler", () => {
    const onPress = vi.fn();
    pathname = "/events/some-show";
    render(
      <>
        <Publisher label="Get tickets" onPress={onPress} />
        <ConsumerBottomNav />
      </>,
    );

    const cta = screen.getByTestId("consumer-bottom-nav-primary");
    expect(cta).toHaveTextContent("Get tickets");

    fireEvent.click(cta);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("drops the centre action when the publishing page disables it", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <>
        <Publisher label="Get tickets" onPress={onPress} enabled />
        <ConsumerBottomNav />
      </>,
    );
    expect(
      screen.getByTestId("consumer-bottom-nav-primary"),
    ).toBeInTheDocument();

    rerender(
      <>
        <Publisher label="Get tickets" onPress={onPress} enabled={false} />
        <ConsumerBottomNav />
      </>,
    );

    expect(screen.queryByTestId("consumer-bottom-nav-primary")).toBeNull();
  });

  it("publishes its measured height on <html> while mounted, and clears it after", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 71 } as DOMRect);

    const { unmount } = render(<ConsumerBottomNav />);
    expect(
      document.documentElement.style.getPropertyValue(
        "--consumer-bottom-nav-height",
      ),
    ).toBe("71px");

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--consumer-bottom-nav-height",
      ),
    ).toBe("");

    rect.mockRestore();
  });

  it("publishes no height variable at desktop widths", () => {
    setViewportWidth(1280);
    render(<ConsumerBottomNav />);

    expect(
      document.documentElement.style.getPropertyValue(
        "--consumer-bottom-nav-height",
      ),
    ).toBe("");
  });

  it("uses label keys that exist in BOTH message catalogs", () => {
    render(<ConsumerBottomNav />);

    const keys = [
      ...(lastBarProps?.sections[0].items.map((item) => item.label) ?? []),
      lastBarProps?.sections[0].label ?? "",
    ];
    expect(keys).toHaveLength(5);

    for (const key of keys) {
      expect(
        lookup(enMessages as unknown as Record<string, unknown>, key),
        `missing en key ${key}`,
      ).toBeTypeOf("string");
      expect(
        lookup(esMessages as unknown as Record<string, unknown>, key),
        `missing es key ${key}`,
      ).toBeTypeOf("string");
    }
  });
});
