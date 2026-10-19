import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type SessionStatus = "authenticated" | "unauthenticated" | "loading";

const { useSessionMock, signOutMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn<[], { data: unknown; status: SessionStatus }>(() => ({
    data: null,
    status: "unauthenticated" as const,
  })),
  signOutMock: vi.fn(() => undefined),
}));

const { pushMock } = vi.hoisted(() => {
  const push = vi.fn();
  return { pushMock: push };
});

const { showSignInOverlayMock } = vi.hoisted(() => ({
  showSignInOverlayMock: vi.fn(),
}));

const STYLE_PROPS = new Set([
  "alignItems",
  "justifyContent",
  "gap",
  "width",
  "height",
  "borderRadius",
  "backgroundColor",
  "flexDirection",
]);

function sanitizeProps(
  props: Record<string, unknown>,
  incomingStyle?: Record<string, unknown>,
) {
  const sanitized = { ...props } as Record<string, unknown>;
  const style: Record<string, unknown> = { ...(incomingStyle ?? {}) };

  for (const key of Object.keys(props)) {
    if (STYLE_PROPS.has(key)) {
      style[key] = props[key];
      delete sanitized[key];
    }
  }

  return { sanitized, style };
}

vi.mock("tamagui", () => {
  const passthrough = forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement>
  >(({ children, style: incomingStyle, ...rest }, ref) => {
    const { sanitized, style } = sanitizeProps(
      rest as Record<string, unknown>,
      (incomingStyle ?? undefined) as Record<string, unknown> | undefined,
    );
    return (
      <div
        ref={ref}
        {...(sanitized as HTMLAttributes<HTMLDivElement>)}
        style={Object.keys(style).length ? (style as CSSProperties) : undefined}
      >
        {children}
      </div>
    );
  });
  passthrough.displayName = "MockTamaguiComponent";

  const styled = () => passthrough;
  const useMedia = () => ({ sm: false });
  // AppNavbar branches its chrome on the active theme (`useThemeName()?.startsWith("ember")`).
  // "stub" is the shipped default (warm paper, light), so this exercises the light branch.
  // Without it every test here throws "No 'useThemeName' export is defined on the 'tamagui' mock".
  const useThemeName = () => "stub";

  const Separator = (props: HTMLAttributes<HTMLHRElement>) => <hr {...props} />;

  return {
    XStack: passthrough,
    YStack: passthrough,
    Anchor: passthrough,
    Separator,
    styled,
    useMedia,
    useThemeName,
  } satisfies Record<string, unknown>;
});

vi.mock("@th/ui", () => {
  const sanitize = sanitizeProps;

  const Button = ({
    children,
    style: incomingStyle,
    asChild,
    ...rest
  }: HTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => {
    const { sanitized, style } = sanitize(
      rest as Record<string, unknown>,
      (incomingStyle ?? undefined) as Record<string, unknown> | undefined,
    );
    delete sanitized.variant;
    delete sanitized.size;
    delete sanitized.icon;
    delete sanitized.testIdBase;
    delete sanitized.asChild;
    const onPress = sanitized.onPress as (() => void) | undefined;
    delete sanitized.onPress;

    if (asChild) {
      return <>{children}</>;
    }

    return (
      <button
        type="button"
        onClick={onPress}
        {...(sanitized as HTMLAttributes<HTMLButtonElement>)}
        style={Object.keys(style).length ? (style as CSSProperties) : undefined}
      >
        {children}
      </button>
    );
  };

  const Navbar = ({
    brand,
    title,
    leadingAccessory,
    trailingAccessory,
    searchAccessory,
  }: {
    brand?: ReactNode;
    title?: ReactNode;
    leadingAccessory?: ReactNode;
    trailingAccessory?: ReactNode;
    searchAccessory?: ReactNode;
  }) => (
    <nav aria-label="Main navigation">
      <div>{brand}</div>
      <div>{title}</div>
      {searchAccessory}
      {leadingAccessory}
      {trailingAccessory}
    </nav>
  );

  const NavbarShell = ({
    brand,
    title,
    leadingAccessory,
    trailingAccessory,
    searchAccessory,
    drawerContent,
    drawerFooter,
    children,
    testIdBase,
  }: {
    brand?: ReactNode;
    title?: ReactNode;
    leadingAccessory?: ReactNode;
    trailingAccessory?: ReactNode;
    searchAccessory?: ReactNode;
    drawerContent?: (closeDrawer: () => void) => ReactNode;
    drawerFooter?: ReactNode;
    children?: ReactNode;
    testIdBase?: string;
  }) => (
    <div data-testid={testIdBase ? `${testIdBase}-shell` : undefined}>
      {brand}
      <div>{title}</div>
      {leadingAccessory}
      {searchAccessory}
      {trailingAccessory}
      {drawerFooter}
      {drawerContent?.(() => undefined)}
      {children}
    </div>
  );

  const AlertsSidebar = ({
    buttonLabel = "Notifications",
  }: {
    buttonLabel?: string;
  }) => (
    <button type="button" aria-label={buttonLabel}>
      {buttonLabel}
    </button>
  );

  const NavbarMenuButton = () => <button type="button">menu</button>;

  const NavigationDrawer = ({ children }: { children?: ReactNode }) => (
    <aside>{children}</aside>
  );

  const Text = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );

  const NextLinkAnchor = forwardRef<
    HTMLAnchorElement,
    HTMLAttributes<HTMLAnchorElement>
  >(({ children, ...rest }, ref) => (
    <a ref={ref} {...rest}>
      {children}
    </a>
  ));

  const Popover = ({
    anchor,
    children,
  }: {
    anchor: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <div>{anchor}</div>
      <div>{children}</div>
    </div>
  );

  const UnifiedSearchAutocomplete = (props: Record<string, unknown>) => {
    const { testIdBase = "unified-search" } = props as { testIdBase?: string };
    return <div data-testid={testIdBase} />;
  };

  // Return the last segment of the i18n key, splitting camelCase into spaces,
  // so "common.openNotifications" → "open Notifications".
  const useTranslations = () => (key: string) => {
    const segment = key.includes(".") ? key.split(".").pop()! : key;
    return segment.replace(/([A-Z])/g, " $1").trim();
  };

  return {
    AlertsSidebar,
    Button,
    Navbar,
    NavbarShell,
    NavbarMenuButton,
    NavigationDrawer,
    Popover,
    Text,
    UnifiedSearchAutocomplete,
    NextLinkAnchor,
    useTranslations,
    // MobileNavMenu (mounted by AppNavbar) reads the active locale.
    useLocale: () => "en",
    // …and, once its sheet is OPEN, the token bag and the hit-target floor.
    // Nothing here opens it today, so these are never read — but without them
    // the first test that clicks the burger dies on `tokens.zIndex.drawer`
    // rather than on whatever it meant to assert. Values mirror
    // packages/ui/src/ui/tamagui/tokens/{space,z-index,border,density}.ts; the
    // sheet's own coverage lives in MobileNavMenu.test.tsx.
    tokens: {
      space: { $3: 12, $4: 16 },
      zIndex: { drawer: 1350 },
      border: { hair: 1, structure: 2 },
    },
    HIT_MIN: 44,
  } satisfies Record<string, unknown>;
});

vi.mock("@floating-ui/react", () => {
  const autoUpdate = () => () => undefined;
  const offset = () => undefined;
  const flip = () => undefined;
  const shift = () => undefined;
  const size = () => undefined;

  const useFloating = () => {
    const refs = {
      setReference: () => undefined,
      setFloating: () => undefined,
    };

    return {
      context: {},
      refs,
      floatingStyles: {},
    };
  };

  const useClick = () => ({});
  const useDismiss = () => ({});
  const useRole = () => ({});
  const useTransitionStyles = () => ({ isMounted: true, styles: {} });
  const useInteractions = () => ({
    getReferenceProps: (props: Record<string, unknown>) => props,
    getFloatingProps: (props?: Record<string, unknown>) => props ?? {},
  });

  return {
    autoUpdate,
    offset,
    flip,
    shift,
    size,
    useFloating,
    useClick,
    useDismiss,
    useRole,
    useTransitionStyles,
    useInteractions,
    FloatingPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
    FloatingFocusManager: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  } satisfies Record<string, unknown>;
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => useSessionMock(),
    signOut: () => signOutMock(),
  },
}));

vi.mock("next/image", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { src, alt, priority, fill, ...rest } = props as {
      src: string;
      alt?: string;
      priority?: boolean;
      fill?: boolean;
    };
    return <img src={src} alt={alt ?? ""} {...rest} />;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  // MobileNavMenu marks the current route on its rows; the logo's home
  // follows the page's language.
  usePathname: () => mockPathname,
}));
let mockPathname = "/";

const { mockGetMyProfileQuery } = vi.hoisted(() => ({
  mockGetMyProfileQuery: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      search: { autocomplete: { invalidate: vi.fn() } },
    }),
    entityPages: {
      getMyProfile: {
        useQuery: (...args: unknown[]) => mockGetMyProfileQuery(...args),
      },
    },
    events: {
      listEventOwnerEntities: {
        useQuery: () => ({ data: { owners: [] } }),
      },
    },
    notifications: {
      countUnread: {
        useQuery: () => ({ data: undefined }),
      },
    },
    search: {
      autocomplete: {
        useQuery: () => ({ data: undefined }),
      },
    },
    platform: {
      checkStaffAccess: {
        useQuery: () => ({ data: undefined }),
      },
    },
    // Drives the account menu's Playing section (performer mode).
    performers: {
      getMyStatus: {
        useQuery: () => ({ data: undefined }),
      },
    },
    // Drives the account menu's next-night block.
    humans: {
      getMyNextNight: {
        useQuery: () => ({ data: undefined }),
      },
    },
  },
}));

vi.mock("@/config/maps", () => ({
  isMapEnabled: true,
  isGoogleMapsEnabled: true,
}));

vi.mock("@/lib/auth/urls", () => ({
  getSignInUrl: () => "/sign-in",
  getAfterSignOutUrl: () => "/after-sign-out",
}));

// Gates default to {} (all off) — AppNavbar only reads `gates?.resale` to
// decide the Sell-tickets nav entry, and off is the fail-closed default.
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: {}, isLoading: false }),
}));

// Mock the hook wholesale rather than stubbing @/trpc piecemeal — the
// hook's own TESTING NOTE mandates this shape (see AdminShell.test.tsx
// precedent; `modeChoiceDialog: null` is required).
vi.mock("@/hooks/useCreateDraftEvent", () => ({
  useCreateDraftEvent: () => ({
    createDraft: vi.fn(),
    modeChoiceDialog: null,
  }),
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({
    showSignInOverlay: showSignInOverlayMock,
    showSignUpOverlay: vi.fn(),
    showOverlayPanel: vi.fn(),
    hideOverlay: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCurrentUrl", () => ({
  useCurrentUrl: () => "http://localhost/mock",
}));

vi.mock("@/components/i18n/LanguageSwitcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));

// The theme toggle reads mode + toggle from AppThemeProvider's context, which
// isn't mounted in these unit renders — provide a light-mode default.
vi.mock("@/components/theme/AppThemeProvider", () => ({
  useAppTheme: () => ({ mode: "light", appearance: "stub", toggle: vi.fn() }),
}));

vi.mock("@/components/notifications/NotificationInboxContainer", () => ({
  NotificationInboxContainer: () => <div data-testid="notification-inbox" />,
}));

import { APP_NAVBAR_CSS, AppNavbar } from "../AppNavbar";
import { MOBILE_BREAKPOINT } from "@/hooks/useIsMobile";
import { PUBLIC_NAV_BREAKPOINT } from "@/hooks/useIsPublicNavCompact";
import { SESSION_RECHECK_DELAY_MS } from "@/hooks/useSessionVerdict";

/**
 * matchMedia stub at a fixed desktop width. The bar's own tiers are CSS now
 * (see "viewport tiers"), but children such as MobileNavMenu still ask
 * matchMedia; `max-width` queries answer against this width and anything else
 * (prefers-reduced-motion) stays false.
 */
let viewportWidth = 1280;

describe("AppNavbar", () => {
  beforeAll(() => {
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

  // Tests below overwrite `listEventOwnerEntities.useQuery`; capture the
  // default once and restore it so later tests don't inherit an override.
  let defaultOwnerEntitiesQuery: unknown;
  beforeAll(async () => {
    const { trpc } = await import("@/trpc");
    defaultOwnerEntitiesQuery = trpc.events.listEventOwnerEntities.useQuery;
  });
  afterEach(async () => {
    const { trpc } = await import("@/trpc");
    (trpc.events.listEventOwnerEntities.useQuery as any) =
      defaultOwnerEntitiesQuery;
  });

  beforeEach(() => {
    viewportWidth = 1280;
    pushMock.mockClear();
    showSignInOverlayMock.mockClear();
    useSessionMock.mockReset();
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
    signOutMock.mockClear();
    mockGetMyProfileQuery.mockReturnValue({ data: null });
    mockPathname = "/";
  });

  const renderNavbar = () => render(<AppNavbar />);

  it("sends the logo home in the page's language: /es from an /es page (spanish-seo FR-006)", () => {
    mockPathname = "/es/contacto";
    renderNavbar();
    expect(screen.getByRole("link", { name: /go to home/i })).toHaveAttribute(
      "href",
      "/es",
    );
  });

  it("sends the logo to / from an English page", () => {
    mockPathname = "/events/category/music";
    renderNavbar();
    expect(screen.getByRole("link", { name: /go to home/i })).toHaveAttribute(
      "href",
      "/",
    );
  });

  /** Convenience: mark the session as authenticated so signed-in UI renders. */
  const signIn = () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "user_1", name: "Me", email: "me@test.com" } },
      status: "authenticated" as const,
    });
    mockGetMyProfileQuery.mockReturnValue({
      data: { humanId: "human_1", displayName: "Me", avatarUrl: null },
    });
  };

  it("exposes a notifications trigger when signed in", () => {
    signIn();
    renderNavbar();

    expect(
      screen.getByRole("button", { name: /open notifications/i }),
    ).toBeInTheDocument();
  });

  it("renders the create event action when signed in", async () => {
    const { trpc } = await import("@/trpc");
    // Create-event is gated on a resolved admin slug — provide an owner
    // entity so `adminSlug` resolves (mirrors the manage-events tests).
    (trpc.events.listEventOwnerEntities.useQuery as any) = () => ({
      data: {
        owners: [
          {
            kind: "org",
            orgId: "org_1",
            orgSlug: "acme",
            orgName: "Acme",
            role: "OWNER",
          },
        ],
      },
    });

    signIn();
    renderNavbar();

    const createBtn = await screen.findByTestId("navbar-profile-create-event");
    expect(createBtn).toBeInTheDocument();
    // Create-event is an imperative action (tRPC draft → navigate), so the
    // menu renders a button, not a link.
    expect(createBtn.tagName).toBe("BUTTON");
  });

  it("routes the hub to the person and lists the org", async () => {
    const { trpc } = await import("@/trpc");
    // Our tRPC mock exports plain functions, not vi.fn() mocks.
    // Override it for this test to return a non-empty owners list.
    (trpc.events.listEventOwnerEntities.useQuery as any) = () => ({
      data: {
        owners: [
          {
            kind: "org",
            orgId: "org_1",
            orgSlug: "acme",
            orgName: "Acme",
            role: "OWNER",
          },
          {
            kind: "human",
            humanId: "human_1",
            humanUsername: "test",
            role: "owner",
          },
        ],
      },
    });

    const { render, screen } = await import("@testing-library/react");
    const { AppNavbar } = await import("../AppNavbar");

    signIn();
    render(<AppNavbar />);

    // "Your hub" is the person's own admin view, even when an org exists…
    const hub = await screen.findByTestId("navbar-profile-dashboard");
    expect(hub).toHaveAttribute("href", "/admin/@test");
    // …and the org gets its own row.
    const orgRow = await screen.findByTestId("navbar-profile-org-acme");
    expect(orgRow).toHaveAttribute("href", "/admin/acme");
    expect(screen.queryByTestId("navbar-profile-events")).toBeNull();
  });

  it("routes the hub to /admin/@<username> (canonical)", async () => {
    const { trpc } = await import("@/trpc");

    (trpc.events.listEventOwnerEntities.useQuery as any) = () => ({
      data: {
        owners: [
          {
            kind: "human",
            humanId: "human_1",
            humanUsername: "test",
            humanName: "Me",
            role: "owner",
          },
        ],
      },
    });

    const { render, screen } = await import("@testing-library/react");
    const { AppNavbar } = await import("../AppNavbar");

    signIn();
    render(<AppNavbar />);

    const hub = await screen.findByTestId("navbar-profile-dashboard");
    // Ensure the href contains `@` directly, not encoded as `%40`.
    expect(hub).toHaveAttribute("href", "/admin/@test");
    expect(hub.getAttribute("href")).not.toContain("%40");
    expect(hub.getAttribute("href")).not.toContain("%25");
    // Identity header comes from the same human owner entity.
    const identity = await screen.findByTestId("navbar-profile-identity");
    expect(identity.textContent).toContain("Me");
    expect(identity.textContent).toContain("@test");
  });

  it.each([
    ["performer mode on", { data: { human: { enabled: true }, orgs: [] } }, true],
    ["performer mode off", { data: { human: { enabled: false }, orgs: [] } }, false],
    ["status loading", { data: undefined, isLoading: true }, false],
    ["status errored", { data: undefined, isError: true }, false],
  ] as const)(
    "shows My lineups only with performer mode on (%s)",
    async (_label, result, shown) => {
      const { trpc } = await import("@/trpc");
      const original = trpc.performers.getMyStatus.useQuery;
      (trpc.performers.getMyStatus.useQuery as any) = () => result;
      try {
        signIn();
        renderNavbar();
        await screen.findByTestId("navbar-profile-panel");
        if (shown) {
          expect(
            await screen.findByTestId("navbar-profile-lineups"),
          ).toHaveAttribute("href", "/my-lineups");
        } else {
          expect(screen.queryByTestId("navbar-profile-lineups")).toBeNull();
        }
      } finally {
        (trpc.performers.getMyStatus.useQuery as any) = original;
      }
    },
  );

  const NIGHT = {
    eventId: "11111111-1111-4111-8111-111111111111",
    slug: "late-set",
    title: "Late Set",
    startsAt: new Date("2026-10-11T01:00:00.000Z"),
    timezone: "America/Chicago",
    placeLabel: "Minneapolis, MN",
  };

  it.each([
    [
      "ticket with an own order",
      { data: { ...NIGHT, kind: "ticket", ticketCount: 2, orderId: "ord_1" } },
      "/my-tickets/ord_1",
    ],
    [
      "ticket held only by transfer",
      { data: { ...NIGHT, kind: "ticket", ticketCount: 1 } },
      "/my-tickets",
    ],
    [
      "lineup that also holds tickets",
      { data: { ...NIGHT, kind: "lineup", ticketCount: 1, orderId: "ord_1" } },
      "/events/late-set",
    ],
    ["rsvp", { data: { ...NIGHT, kind: "rsvp" } }, "/events/late-set"],
    [
      "rsvp on an event without a slug",
      { data: { ...NIGHT, slug: null, kind: "rsvp" } },
      `/events/${NIGHT.eventId}`,
    ],
    [
      "refetch failed after an earlier success",
      { data: { ...NIGHT, kind: "rsvp" }, isError: true },
      null,
    ],
    ["no next night", { data: null }, null],
    ["query loading", { data: undefined, isLoading: true }, null],
    ["query errored", { data: undefined, isError: true }, null],
  ] as const)(
    "points the next-night button where its label says (%s)",
    async (_label, result, href) => {
      const { trpc } = await import("@/trpc");
      const original = trpc.humans.getMyNextNight.useQuery;
      (trpc.humans.getMyNextNight.useQuery as any) = () => result;
      try {
        signIn();
        renderNavbar();
        await screen.findByTestId("navbar-profile-panel");
        if (href) {
          expect(
            await screen.findByTestId("navbar-profile-next-night-open"),
          ).toHaveAttribute("href", href);
        } else {
          expect(screen.queryByTestId("navbar-profile-next-night")).toBeNull();
        }
      } finally {
        (trpc.humans.getMyNextNight.useQuery as any) = original;
      }
    },
  );

  it.each([
    ["signed in", true],
    ["signed out", false],
  ] as const)(
    "asks for the next night only when signed in (%s)",
    async (_label, signedIn) => {
      const { trpc } = await import("@/trpc");
      const original = trpc.humans.getMyNextNight.useQuery;
      const seen: Array<{ enabled?: boolean }> = [];
      (trpc.humans.getMyNextNight.useQuery as any) = (
        _input: unknown,
        opts: { enabled?: boolean },
      ) => {
        seen.push(opts);
        return { data: undefined };
      };
      try {
        if (signedIn) signIn();
        renderNavbar();
        await waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(seen.at(-1)?.enabled).toBe(signedIn);
      } finally {
        (trpc.humans.getMyNextNight.useQuery as any) = original;
      }
    },
  );

  it("opens the account popover when clicking the profile trigger", async () => {
    const user = userEvent.setup();

    const { render, screen } = await import("@testing-library/react");
    const { AppNavbar } = await import("../AppNavbar");

    signIn();
    render(<AppNavbar />);

    const trigger = await screen.findByTestId("navbar-profile-trigger");
    await user.click(trigger);

    expect(
      await screen.findByTestId("navbar-profile-panel"),
    ).toBeInTheDocument();
  });

  /**
   * THREE session states, not two. The bar used to render SIGN IN the instant
   * `data?.user` was falsy, which is also what a `/get-session` whose request
   * beat a freshly-set cookie looks like — so a user who had just typed their
   * password was told to sign in. `useSessionVerdict` holds an `unknown`
   * window open across one re-check, and for that window the bar must assert
   * NEITHER thing: no SIGN IN, no account popover.
   *
   * It is not blank, though. The CTA's footprint is reserved (`visibility:
   * hidden`), so the bar does not jump when the answer turns out to be
   * "signed out" — which is why this asserts on the accessible role (absent)
   * and the reservation test id (present) rather than on the DOM alone.
   */
  it("asserts neither sign-in nor an account while the session is unknown", () => {
    renderNavbar();

    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("navbar-account")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /open notifications/i }),
    ).not.toBeInTheDocument();
    // …but the space it will take is already held.
    expect(screen.getByTestId("navbar-account-reserved")).toBeInTheDocument();
  });

  it("opens the sign-in overlay for the account button when signed out", async () => {
    const user = userEvent.setup();
    renderNavbar();

    // The CTA only appears once the verdict SETTLES on signed-out, which takes
    // one re-check. The mocked session has no `refetch`, so the hook's
    // backstop deadline is what closes the window here.
    const signIn = await screen.findByRole(
      "button",
      { name: /sign in/i },
      { timeout: SESSION_RECHECK_DELAY_MS + 2_000 },
    );
    await user.click(signIn);

    expect(showSignInOverlayMock).toHaveBeenCalledWith({
      redirect: "http://localhost/mock",
    });
  });

  it("hides create event actions when signed out", () => {
    renderNavbar();

    expect(
      screen.queryByRole("button", { name: /create event/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the search affordance in the navbar", () => {
    renderNavbar();

    // NavbarSearch renders a spotlight trigger (testIdBase + "-trigger").
    expect(screen.getByTestId("navbar-search-trigger")).toBeInTheDocument();
  });

  /**
   * TWO stages, not one — see the block comment on `APP_NAVBAR_CSS` in
   * AppNavbar. 900 is the design system folder's number for the public nav
   * (`MobileNavSheet.prompt.md`) and moves the SET-ONCE preferences into the
   * sheet. 600 is the bar's own space budget and is the only place the
   * saved-heart, My Tickets and the search trigger come out. Folding them into
   * one breakpoint is the regression these tests exist to catch: at 900 it
   * duplicates the theme toggle in the bar AND the sheet, at 600 it strands
   * notifications across 300px of viewport where nothing else carries them.
   *
   * The tiers are CSS now (so the server HTML is already right at every width
   * and nothing shifts on hydration), and jsdom does not evaluate media
   * queries. So these tests check the two halves of the contract separately:
   * which tier wrapper each control sits in (`shownAt`), and that the
   * stylesheet hides each tier at exactly the hooks' thresholds.
   */
  describe("viewport tiers", () => {
    const TIERS: Record<string, (width: number) => boolean> = {
      "th-appnav-wide": (w) => w >= PUBLIC_NAV_BREAKPOINT,
      "th-appnav-roomy": (w) => w >= MOBILE_BREAKPOINT,
      "th-appnav-compact": (w) => w < PUBLIC_NAV_BREAKPOINT,
    };

    /** Would `el` be displayed at `width`, given the tier wrappers above it? */
    const shownAt = (el: HTMLElement | null, width: number) => {
      if (!el) return false;
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        for (const [tier, visible] of Object.entries(TIERS)) {
          if (node.classList.contains(tier) && !visible(width)) return false;
        }
      }
      return true;
    };
    const byId = (id: string) => screen.queryByTestId(id);

    it("hides each tier at exactly the hooks' thresholds", () => {
      const css = APP_NAVBAR_CSS.replace(/\s+/g, " ");
      expect(css).toContain(
        "@media (min-width: 900px) { .th-appnav-slot.th-appnav-compact { display: none; } }",
      );
      // `.98`, not `899px`: a fractional window (zoom) must not fall between
      // the two queries and show every tier at once.
      expect(css).toContain(
        "@media (max-width: 899.98px) { .th-appnav-slot.th-appnav-wide { display: none; } }",
      );
      // The search SLOT goes too, not just the trigger inside it — and only
      // that slot, by the id Navbar derives from `testIdBase`.
      expect(css).toContain(
        '@media (max-width: 599.98px) { .th-appnav-slot.th-appnav-roomy { display: none; } [data-qa="web-navbar-search"] { display: none !important; } }',
      );
    });

    /**
     * Without the base rule every wrapper is a block box: the controls stack
     * vertically inside the ActionGroup and its `$2` gap applies to wrappers,
     * not controls. `display: contents` is what keeps the bar unchanged.
     */
    it("makes every tier wrapper layout-transparent", () => {
      expect(APP_NAVBAR_CSS).toMatch(
        /^\s*\.th-appnav-slot \{ display: contents; \}/,
      );
    });

    it("ships the stylesheet in the rendered markup, so first paint has it", () => {
      const { container } = renderNavbar();
      const styles = Array.from(container.querySelectorAll("style")).map(
        (el) => el.innerHTML,
      );
      expect(styles).toContain(APP_NAVBAR_CSS);
    });

    it("mounts every control once, whatever the width", () => {
      signIn();
      renderNavbar();

      for (const id of [
        "navbar-theme-toggle",
        "language-switcher",
        "navbar-saved",
        "navbar-my-tickets",
        "navbar-menu",
        "navbar-search-trigger",
      ]) {
        expect(screen.getAllByTestId(id)).toHaveLength(1);
      }
      expect(
        screen.getAllByRole("button", { name: /open notifications/i }),
      ).toHaveLength(1);
    });

    it("keeps the whole bar and no burger at 1280", () => {
      signIn();
      renderNavbar();

      expect(shownAt(byId("navbar-theme-toggle"), 1280)).toBe(true);
      expect(shownAt(byId("language-switcher"), 1280)).toBe(true);
      expect(shownAt(byId("navbar-saved"), 1280)).toBe(true);
      expect(shownAt(byId("navbar-my-tickets"), 1280)).toBe(true);
      expect(shownAt(byId("navbar-search-trigger"), 1280)).toBe(true);
      expect(shownAt(byId("navbar-menu"), 1280)).toBe(false);
    });

    it("at 760 shows the burger and moves preferences into the sheet", () => {
      signIn();
      renderNavbar();

      expect(shownAt(byId("navbar-menu"), 760)).toBe(true);
      // Set once — they belong to the sheet's Preferences group now, and must
      // not also sit in the bar.
      expect(shownAt(byId("navbar-theme-toggle"), 760)).toBe(false);
      expect(shownAt(byId("language-switcher"), 760)).toBe(false);
    });

    it("at 760 still carries the controls nothing else does", () => {
      signIn();
      renderNavbar();

      // Neither the bottom bar nor the profile menu carries these; dropping
      // them at 900 rather than 600 would make them unreachable.
      expect(shownAt(byId("navbar-saved"), 760)).toBe(true);
      expect(shownAt(byId("navbar-my-tickets"), 760)).toBe(true);
      expect(
        shownAt(screen.getByRole("button", { name: /notifications/i }), 760),
      ).toBe(true);
    });

    it("at 760 the burger reaches a signed-OUT visitor too", () => {
      renderNavbar();

      expect(shownAt(byId("navbar-menu"), 760)).toBe(true);
    });

    it("at 375 drops to the narrow bar", () => {
      signIn();
      renderNavbar();

      expect(shownAt(byId("navbar-menu"), 375)).toBe(true);
      expect(shownAt(byId("navbar-saved"), 375)).toBe(false);
      expect(shownAt(byId("navbar-my-tickets"), 375)).toBe(false);
      expect(shownAt(byId("navbar-search-trigger"), 375)).toBe(false);
      expect(shownAt(byId("navbar-theme-toggle"), 375)).toBe(false);
      expect(shownAt(byId("language-switcher"), 375)).toBe(false);
    });

    /**
     * The narrow bar used to drop the bell along with everything else, which
     * left notifications unreachable below 600 — the bottom bar does not carry
     * them, and AlertsSidebar is uncontrolled so no menu row can open it. The
     * unread BADGE is the whole point of the affordance, so the bell stays.
     */
    it("keeps notifications reachable at 375", () => {
      signIn();
      renderNavbar();

      expect(
        shownAt(
          screen.getByRole("button", { name: /open notifications/i }),
          375,
        ),
      ).toBe(true);
    });

    it("shows no bell to a signed-out visitor at 375", () => {
      renderNavbar();

      expect(
        screen.queryByRole("button", { name: /open notifications/i }),
      ).not.toBeInTheDocument();
    });

    /**
     * Saved events have no account-menu row of their own: My Tickets
     * (/my-tickets) shows tickets and hearted events together, and the popover
     * renders at EVERY width — one instance, outside every tier wrapper.
     */
    it.each([1280, 760, 375])(
      "routes to My Tickets, with no separate Saved row, from the account menu at %ipx",
      async (w) => {
        signIn();
        renderNavbar();

        const tickets = await screen.findByTestId("navbar-profile-tickets");
        expect(tickets).toHaveAttribute("href", "/my-tickets");
        expect(shownAt(tickets, w)).toBe(true);
        expect(screen.queryByTestId("navbar-profile-saved")).toBeNull();
      },
    );

    it("puts the burger on the 900 boundary, not the 600 one", () => {
      renderNavbar();
      expect(shownAt(byId("navbar-menu"), 899)).toBe(true);
      expect(shownAt(byId("navbar-menu"), 900)).toBe(false);
      expect(shownAt(byId("navbar-menu"), 599)).toBe(true);
    });
  });
});
