import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  filterSections,
  type AccountContext,
  type NavigationSection,
} from "@th/ui";
import {
  ORG_ANY_ROLE,
  ORG_ADMIN_ROLES,
  ORG_NON_SCANNER,
  ORG_SCAN_ROLES,
  ORG_CONTENT_VIEW,
  ORG_FINANCE_ROLES,
  ORG_FINANCE_VIEW,
  ORG_MANAGE_VIEW,
} from "@th/types";

import { registerNavigationGuard } from "@/hooks/navigation-guard";
import { AdminShell } from "../AdminShell";
import {
  AdminPageSectionsProvider,
  useAdminPageSectionsActions,
} from "../admin-page-sections";
import { ADMIN_SECTIONS } from "../admin-nav-sections";

import * as NextNavigation from "next/navigation";

const mockedUseEventOwnerEntities = vi.fn();

vi.mock("@/hooks/useEventOwnerEntities", () => {
  return {
    useEventOwnerEntities: () => mockedUseEventOwnerEntities(),
  };
});

vi.mock("next/navigation", () => {
  const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: vi.fn(() => "/admin/acme-co/orders"),
  };
});

// AdminShell's navbar/drawer slot JSX uses XStack/YStack; render them as
// plain DOM so the harness can mount the slots without a TamaguiProvider /
// theme (mirrors EventAdminPageShell.test.tsx). Everything else in "tamagui"
// stays real for @th/ui's importActual below.
vi.mock("tamagui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("tamagui");
  const PlainStack = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { ...actual, XStack: PlainStack, YStack: PlainStack };
});

vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  const noopToast = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    danger: vi.fn(),
    neutral: vi.fn(),
  };
  return {
    ...actual,
    // `useNotify` reads from a NotificationProvider that the success-branch
    // chrome (AlertsSidebar) requires but our render tree doesn't mount.
    useNotify: () => ({ toast: noopToast }),
    // Plain-DOM Text so the drawer-footer label renders without a theme.
    Text: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
    // AlertsSidebar needs a NotificationProvider; stub it with a marker that
    // records the touch-target override so the trailing-slot tests can assert
    // the mobile 48px dimension without mounting the real sidebar.
    AlertsSidebar: (props: any) => (
      <div
        data-testid="alerts-sidebar"
        data-dimension={props.buttonDimension ?? ""}
      />
    ),
    // Replace AdminLedgerShell with a tiny harness so we can assert the derived props
    AdminLedgerShell: ({
      currentRoute,
      navSections,
      accountContext,
      availableContexts,
      railBack,
      railContextHeader,
      sectionCollapsePersistKey,
      bottomBarCenterAction,
      brand,
      onBrandPress,
      navbarTrailingSlot,
      quickActionFooter,
      contextHrefBuilder,
      onContextSwitch,
      onRouteSelect,
      railIdentityHref,
      railIdentityLabel,
      onRailIdentityPress,
      surfaceRole,
      sectionTabs,
      contextItems,
      children,
    }: any) => (
      <div>
        <div data-testid="current-route">{currentRoute}</div>
        <div data-testid="surface-role">{surfaceRole ?? ""}</div>
        {/* Registers 2/3 must stay unused in admin — see the test below. */}
        <div data-testid="section-tabs-passed">
          {sectionTabs === undefined ? "absent" : "present"}
        </div>
        <div data-testid="context-items-passed">
          {contextItems === undefined ? "absent" : "present"}
        </div>
        <div data-testid="first-item-route">
          {navSections?.[0]?.items?.[0]?.route}
        </div>
        <div data-testid="nav-section-ids">
          {(navSections ?? []).map((s: any) => s.id).join(",")}
        </div>
        <div data-testid="nav-item-summary">
          {(navSections ?? [])
            .flatMap((s: any) => s.items)
            .map(
              (i: any) =>
                `${i.id}${i.disabled ? ":disabled" : ""}${
                  i.active ? ":active" : ""
                }`,
            )
            .join(",")}
        </div>
        {/* Separate from nav-item-summary on purpose: that testid is matched
            as an exact string by other suites, so badges get their own. */}
        <div data-testid="nav-item-badges">
          {(navSections ?? [])
            .flatMap((s: any) => s.items)
            .filter((i: any) => i.badgeCount !== undefined)
            .map((i: any) => `${i.id}=${i.badgeCount}`)
            .join(",")}
        </div>
        {/* Which sections / items still carry an `rbac` gate. This mock does
            NOT filter by role (NavigationShell does); it only shows whether
            the URL-role path is still in force. */}
        <div data-testid="nav-rbac-ids">
          {(navSections ?? [])
            .flatMap((s: any) => [
              ...(s.rbac?.length ? [s.id] : []),
              ...s.items
                .filter((i: any) => i.rbac?.length)
                .map((i: any) => i.id),
            ])
            .join(",")}
        </div>
        {/* Own testid for the same reason: the event rail's volunteers
            children, which drop on a person's event. */}
        <div data-testid="nav-volunteer-children">
          {(navSections ?? [])
            .flatMap((s: any) => s.items)
            .find((i: any) => i.id === "volunteers")
            ?.children?.map((c: any) => c.id)
            .join(",") ?? ""}
        </div>
        {/* Payouts anchor children + their controlled `active`, and a way
            to select one exactly as the rail would (namespaced href). */}
        <div data-testid="nav-payouts-children">
          {(navSections ?? [])
            .flatMap((s: any) => s.items)
            .find((i: any) => i.id === "payouts")
            ?.children?.map(
              (c: any) => `${c.id}=${String(c.active)}@${c.route}`,
            )
            .join(",") ?? ""}
        </div>
        <button
          type="button"
          data-testid="select-payouts-ledger"
          onClick={() => onRouteSelect?.("/admin/acme-co/payouts#ledger")}
        />
        <div data-testid="rail-back-href">{railBack?.href ?? ""}</div>
        <div data-testid="rail-persist-key">
          {sectionCollapsePersistKey ?? ""}
        </div>
        <div data-testid="rail-context-header">{railContextHeader ?? null}</div>
        <div data-testid="bottom-bar-center-action">
          {bottomBarCenterAction?.id ?? ""}
        </div>
        <div data-testid="account-context-id">{accountContext?.id}</div>
        <div data-testid="available-context-labels">
          {(availableContexts ?? []).map((ctx: any) => ctx.label).join(",")}
        </div>
        <div data-testid="brand-slot">{brand ?? null}</div>
        <div data-testid="on-brand-press">{onBrandPress ? "set" : "unset"}</div>
        <div data-testid="trailing-mobile">
          {typeof navbarTrailingSlot === "function"
            ? navbarTrailingSlot("mobile")
            : null}
        </div>
        <div data-testid="trailing-desktop">
          {typeof navbarTrailingSlot === "function"
            ? navbarTrailingSlot("desktop")
            : null}
        </div>
        <div data-testid="quick-action-footer">{quickActionFooter ?? null}</div>
        <div data-testid="context-href-org-b">
          {contextHrefBuilder?.("org-b") ?? ""}
        </div>
        <button
          type="button"
          data-testid="switch-to-org-b"
          onClick={() => onContextSwitch?.("org-b")}
        />
        <div data-testid="rail-identity-href">{railIdentityHref ?? ""}</div>
        <div data-testid="rail-identity-label">{railIdentityLabel ?? ""}</div>
        <button
          type="button"
          data-testid="press-rail-identity"
          onClick={() => onRailIdentityPress?.()}
        />
        {children}
      </div>
    ),
  };
});

const mockedGetEventTitleQuery = vi.fn<unknown[], any>(() => ({
  data: undefined,
}));

// Descriptor hooks run UNCONDITIONALLY on every render (registry contract),
// so the place title query is called — disabled — even on non-place routes.
const mockedGetPlaceTitleQuery = vi.fn<unknown[], any>(() => ({
  data: undefined,
}));

const mockedCountOpenQuery = vi.fn<unknown[], any>(() => ({
  data: undefined,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listEventOwnerEntities: {
          invalidate: vi.fn(),
          ensureData: vi.fn(async () => ({ owners: [] })),
        },
      },
    }),
    events: {
      // Title + status come from the single lightweight getEventTitle query
      // (ops routes must not fetch the full getEventForEdit payload).
      getEventTitle: {
        useQuery: (...args: unknown[]) =>
          (mockedGetEventTitleQuery as any)(...args),
      },
    },
    places: {
      // Title + verification for the place rail context header
      // (place-admin-rail-context D5) — light query, never getPlaceForEdit.
      getPlaceTitle: {
        useQuery: (...args: unknown[]) =>
          (mockedGetPlaceTitleQuery as any)(...args),
      },
    },
    features: {
      getFeatureGates: {
        useQuery: () => ({ data: {}, isLoading: false }),
      },
    },
    notifications: {
      countUnread: {
        useQuery: () => ({ data: { count: 0 } }),
      },
    },
    bookingRequests: {
      // Feeds the Bookings rail badge (booking-inbox-placement FR-007).
      // Defaults to "query returned nothing" so every pre-existing test
      // renders a rail with no badge; the badge tests override it.
      countOpen: {
        useQuery: (...args: unknown[]) =>
          (mockedCountOpenQuery as any)(...args),
      },
    },
  },
}));

// The owner-entities branches (loading / error / timeout) render before the
// admin chrome, but the unconditional hooks at the top of AdminShell still
// run. Stub the leaf hooks so the component mounts without pulling in the full
// feature-gate / draft-event trpc surface.
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: {}, isLoading: false }),
}));

vi.mock("@/hooks/useCreateDraftEvent", () => ({
  useCreateDraftEvent: () => ({
    createDraft: vi.fn(),
    modeChoiceDialog: null,
  }),
}));

vi.mock("../CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: () => null,
}));

// The rail context header renders Tamagui primitives (needs a theme); a
// plain-DOM stand-in keeps this suite provider-free while still asserting
// the derived title/status.
vi.mock("../EventRailContextHeader", () => ({
  EventRailContextHeader: ({
    title,
    status,
    viewHref,
  }: {
    title: string | null;
    status?: string;
    viewHref?: string | null;
  }) => (
    <div>
      {title ? <span>{title}</span> : null}
      {status ? <span>{status}</span> : null}
      {/* The gate lives in `event-rail-context`, so what these tests can
          usefully pin is the href it derives — empty string when withheld. */}
      <span data-testid="rail-view-href">{viewHref ?? ""}</span>
    </div>
  ),
}));

// Same plain-DOM stand-in for the place context header (Badge/Tamagui need a
// theme; the suite stays provider-free while asserting the derived
// name/verification).
vi.mock("../PlaceRailContextHeader", () => ({
  PlaceRailContextHeader: ({
    name,
    verification,
  }: {
    name: string | null;
    verification?: string;
  }) => (
    <div>
      {name ? <span>{name}</span> : null}
      {verification ? <span>{verification}</span> : null}
    </div>
  ),
}));

// Success-branch chrome dependencies that reach trpc surfaces unrelated to the
// ownership gate under test. Stub them so the rendered tree stays focused on
// AdminShell's own derivation logic.
vi.mock("@/components/errors/QuotaExceededDialog", () => ({
  QuotaExceededDialog: () => null,
}));

vi.mock("@/components/auth/AdminEmailVerificationGate", () => ({
  AdminEmailVerificationGate: ({ children }: any) => children,
}));

vi.mock("@/components/search/NavbarSearch", () => ({
  NavbarSearch: () => null,
}));

vi.mock("@/components/notifications/NotificationInboxContainer", () => ({
  NotificationInboxContainer: () => null,
}));

vi.mock("@/components/i18n/LanguageSwitcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));

vi.mock("@/components/theme/ThemeToggleButton", () => ({
  ThemeToggleButton: () => <div data-testid="theme-toggle" />,
}));

// BrandLockup pulls next/image + the theme hook; a plain-DOM stand-in keeps
// the suite provider-free while still letting the brand-slot test assert the
// single-anchor (no nested button) contract.
vi.mock("@/components/navigation/BrandLockup", () => ({
  BrandLockup: () => <span data-testid="brand-lockup" />,
}));

describe("AdminShell", () => {
  beforeEach(() => {
    mockedGetEventTitleQuery.mockReset();
    mockedGetEventTitleQuery.mockReturnValue({ data: undefined });
    mockedGetPlaceTitleQuery.mockReset();
    mockedGetPlaceTitleQuery.mockReturnValue({ data: undefined });
    mockedCountOpenQuery.mockReset();
    mockedCountOpenQuery.mockReturnValue({ data: undefined });
    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      "/admin/acme-co/orders",
    );
    mockedUseEventOwnerEntities.mockReset();
    mockedUseEventOwnerEntities.mockReturnValue({
      data: { owners: [] },
      isLoading: false,
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      ownersWithSlugs: [
        {
          kind: "org",
          orgId: "22222222-2222-4222-8222-222222222222",
          orgName: "Acme",
          orgSlug: "acme-co",
          role: "ADMIN",
          adminSlug: "acme-co",
        },
      ],
      preferredAdminSlug: "acme-co",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // User decision 2026-08-27: the side rail is admin's navigation, full stop.
  // Register 2 (section tabs) fought the rail for the same job and register 3
  // (context strip) duplicated the builder header, so AdminShell passes
  // NEITHER — only the topbar (register 1, with the "Admin" surface role) is
  // used. This pins that so nobody re-adds them by accident.
  it("passes no section tabs and no context items to the ledger shell (2026-08-27 decision)", () => {
    renderShell();
    expect(screen.getByTestId("section-tabs-passed").textContent).toBe(
      "absent",
    );
    expect(screen.getByTestId("context-items-passed").textContent).toBe(
      "absent",
    );
    expect(screen.getByTestId("surface-role").textContent).toBe(
      "admin.navRoleAdmin",
    );
  });

  // The action bar is gone (2026-08-30): the shell mounts NOTHING between the
  // ledger shell's content area and the route's own page.
  it("mounts no action bar above the page content", () => {
    renderShell();
    expect(screen.queryByTestId("page-action-bar")).toBeNull();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("derives a stable currentRoute and namespaces nav item hrefs", () => {
    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [{ id: "orders", label: "Orders", route: "orders" }],
      },
    ];
    const accountContext: AccountContext = {
      id: "ctx",
      label: "Acme",
      type: "org",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminShell
          slug="acme-co"
          sections={sections}
          accountContext={accountContext}
        >
          <div>Content</div>
        </AdminShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("current-route").textContent).toBe("orders");
    expect(screen.getByTestId("first-item-route").textContent).toBe(
      "/admin/acme-co/orders",
    );
  });

  // A human workspace reached from a PASTED or BOOKMARKED link arrives
  // percent-encoded, while `adminBasePath` is built from the DECODED route
  // param. That used to miss, and `currentRoute` fell back to the first nav
  // item: the rail highlighted Dashboard while the user was reading Orders,
  // and `useDocumentTitleFallback` titled the tab to match. Observed live at
  // `/admin/%40admin/orders`.
  it("derives currentRoute when a human workspace slug is percent-encoded", () => {
    mockedUseEventOwnerEntities.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {},
      refetch: vi.fn(),
      ownersWithSlugs: [
        {
          kind: "human",
          humanId: "33333333-3333-4333-8333-333333333333",
          humanName: "Steve",
          role: undefined,
          adminSlug: "@steve-1",
        },
      ],
      preferredAdminSlug: "@steve-1",
    });
    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      "/admin/%40steve-1/orders",
    );

    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "dashboard" },
          { id: "orders", label: "Orders", route: "orders" },
        ],
      },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminShell
          slug="@steve-1"
          sections={sections}
          accountContext={{ id: "ctx", label: "Steve", type: "personal" }}
        >
          <div>Content</div>
        </AdminShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("current-route").textContent).toBe("orders");
  });

  describe("workspace switching preserves the current section", () => {
    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "dashboard" },
          { id: "events", label: "Events", route: "events" },
          { id: "orders", label: "Orders", route: "orders" },
        ],
      },
    ];
    const accountContext: AccountContext = {
      id: "ctx",
      label: "Acme",
      type: "org",
    };

    const renderShell = () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      return render(
        <QueryClientProvider client={queryClient}>
          <AdminShell
            slug="acme-co"
            sections={sections}
            accountContext={accountContext}
          >
            <div>Content</div>
          </AdminShell>
        </QueryClientProvider>,
      );
    };

    it("keeps the section in both the anchor href and the click handler", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/orders",
      );
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();

      renderShell();

      // The anchor the switcher renders and the click handler MUST agree,
      // or a plain click and a middle-click disagree.
      expect(screen.getByTestId("context-href-org-b").textContent).toBe(
        "/admin/org-b/orders",
      );
      act(() => {
        fireEvent.click(screen.getByTestId("switch-to-org-b"));
      });
      expect(router.push).toHaveBeenCalledWith("/admin/org-b/orders");
    });

    it("collapses a nested entity route to the section root", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/events/evt_123/edit",
      );
      renderShell();
      expect(screen.getByTestId("context-href-org-b").textContent).toBe(
        "/admin/org-b/events",
      );
    });

    it("falls back to the dashboard for a section the rail does not offer", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/payouts",
      );
      renderShell();
      expect(screen.getByTestId("context-href-org-b").textContent).toBe(
        "/admin/org-b/dashboard",
      );
    });

    describe("rbac is evaluated against the TARGET workspace's role", () => {
      // OWNER of acme-co, SCANNER of org-b. Team is ORG_MANAGE_VIEW, which
      // SCANNER does not hold — org-b's own rail would not offer it, so
      // handing over /admin/org-b/team would drop the user on a page whose
      // roster query answers FORBIDDEN.
      const rbacSections: NavigationSection[] = [
        {
          id: "main",
          label: "Main",
          items: [
            { id: "dashboard", label: "Dashboard", route: "dashboard" },
            { id: "orders", label: "Orders", route: "orders" },
            {
              id: "team",
              label: "Team",
              route: "team",
              rbac: ORG_MANAGE_VIEW,
            },
          ],
        },
      ];

      const renderMixedRoleShell = () => {
        mockedUseEventOwnerEntities.mockReturnValue({
          data: { owners: [] },
          isLoading: false,
          isPending: false,
          isError: false,
          isFetching: false,
          refetch: vi.fn(),
          ownersWithSlugs: [
            {
              kind: "org",
              orgId: "22222222-2222-4222-8222-222222222222",
              orgName: "Acme",
              orgSlug: "acme-co",
              role: "OWNER",
              adminSlug: "acme-co",
            },
            {
              kind: "org",
              orgId: "33333333-3333-4333-8333-333333333333",
              orgName: "Org B",
              orgSlug: "org-b",
              role: "SCANNER",
              adminSlug: "org-b",
            },
          ],
          preferredAdminSlug: "acme-co",
        });

        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        return render(
          <QueryClientProvider client={queryClient}>
            <AdminShell
              slug="acme-co"
              sections={rbacSections}
              accountContext={{ id: "ctx", label: "Acme", type: "org" }}
            >
              <div>Content</div>
            </AdminShell>
          </QueryClientProvider>,
        );
      };

      it("sends a lesser-privileged target to the dashboard, not the gated section", () => {
        vi.mocked(NextNavigation.usePathname).mockReturnValue(
          "/admin/acme-co/team",
        );
        renderMixedRoleShell();
        expect(screen.getByTestId("context-href-org-b").textContent).toBe(
          "/admin/org-b/dashboard",
        );
      });

      it("still preserves a section BOTH roles can see", () => {
        vi.mocked(NextNavigation.usePathname).mockReturnValue(
          "/admin/acme-co/orders",
        );
        renderMixedRoleShell();
        expect(screen.getByTestId("context-href-org-b").textContent).toBe(
          "/admin/org-b/orders",
        );
      });
    });
  });

  // Volunteer Roles reads `volunteer.templates.list` (needs an orgId), so a
  // personal workspace has no version of it: the rail drops it, and a switch
  // INTO a personal workspace must not carry the segment over.
  describe("org-only rail items (Volunteer Roles)", () => {
    const volunteerSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "dashboard" },
          { id: "volunteers", label: "Volunteers", route: "volunteers" },
          {
            id: "volunteer-templates",
            label: "Volunteer Roles",
            route: "volunteer-templates",
          },
        ],
      },
    ];

    const owners = {
      org: {
        kind: "org",
        orgId: "22222222-2222-4222-8222-222222222222",
        orgName: "Acme",
        orgSlug: "acme-co",
        role: "ADMIN",
        adminSlug: "acme-co",
      },
      human: {
        kind: "human",
        humanId: "steve-1",
        humanName: "Steve",
        humanUsername: "steve",
        adminSlug: "@steve",
      },
      // A personal target whose slug is "org-b" so the mock's switch target
      // (`context-href-org-b`) lands on it.
      humanTarget: {
        kind: "human",
        humanId: "steve-2",
        humanName: "Steve B",
        humanUsername: "steve-b",
        adminSlug: "org-b",
      },
    };

    const renderFor = (
      slug: string,
      ownersWithSlugs: unknown[],
      type: "org" | "personal",
    ) => {
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs,
        preferredAdminSlug: slug,
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      return render(
        <QueryClientProvider client={queryClient}>
          <AdminShell
            slug={slug}
            sections={volunteerSections}
            accountContext={{ id: slug, label: slug, type }}
          >
            <div>Content</div>
          </AdminShell>
        </QueryClientProvider>,
      );
    };

    it("personal workspace rail keeps Volunteers and drops Volunteer Roles", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/%40steve/dashboard",
      );
      renderFor("@steve", [owners.human], "personal");
      const ids = (
        screen.getByTestId("nav-item-summary").textContent ?? ""
      )
        .split(",")
        .map((entry) => entry.split(":")[0]);
      expect(ids).toContain("volunteers");
      expect(ids).not.toContain("volunteer-templates");
    });

    it("org workspace rail keeps both", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/dashboard",
      );
      renderFor("acme-co", [owners.org], "org");
      const ids = (
        screen.getByTestId("nav-item-summary").textContent ?? ""
      )
        .split(",")
        .map((entry) => entry.split(":")[0]);
      expect(ids).toContain("volunteers");
      expect(ids).toContain("volunteer-templates");
    });

    it("switching from an org's Volunteer Roles to a personal workspace lands on the dashboard", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/volunteer-templates",
      );
      renderFor("acme-co", [owners.org, owners.humanTarget], "org");
      expect(screen.getByTestId("context-href-org-b").textContent).toBe(
        "/admin/org-b/dashboard",
      );
    });

    it("still carries Volunteers into a personal workspace", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/volunteers",
      );
      renderFor("acme-co", [owners.org, owners.humanTarget], "org");
      expect(screen.getByTestId("context-href-org-b").textContent).toBe(
        "/admin/org-b/volunteers",
      );
    });
  });

  it("points the rail identity block at the workspace dashboard", () => {
    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [{ id: "orders", label: "Orders", route: "orders" }],
      },
    ];
    const accountContext: AccountContext = {
      id: "ctx",
      label: "Acme",
      type: "org",
    };
    const router = NextNavigation.useRouter();
    vi.mocked(router.push).mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminShell
          slug="acme-co"
          sections={sections}
          accountContext={accountContext}
        >
          <div>Content</div>
        </AdminShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("rail-identity-href").textContent).toBe(
      "/admin/acme-co/dashboard",
    );
    // The accessible name comes from the i18n catalog. This harness mounts no
    // LocaleProvider, so `t` echoes the key — assert the key is wired (the
    // catalog's own text + placeholder parity is covered by
    // src/i18n/__tests__/catalog-parity.test.ts).
    expect(screen.getByTestId("rail-identity-label").textContent).toBe(
      "admin.asGoToWorkspaceDashboard",
    );

    act(() => {
      fireEvent.click(screen.getByTestId("press-rail-identity"));
    });
    expect(router.push).toHaveBeenCalledWith("/admin/acme-co/dashboard");
  });

  it("prefers the human owner name over the raw admin slug for personal workspaces", () => {
    mockedUseEventOwnerEntities.mockReturnValue({
      data: { owners: [] },
      isLoading: false,
      isPending: false,
      isError: false,
      ownersWithSlugs: [
        {
          kind: "human",
          humanId: "steve-1",
          humanName: "Steve McQueen",
          humanUsername: "steve-mcqueen",
          adminSlug: "@steve-mcqueen-957d5e38",
        },
      ],
      preferredAdminSlug: "@steve-mcqueen-957d5e38",
    });

    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      "/admin/%40steve-mcqueen-957d5e38/dashboard",
    );

    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [{ id: "dashboard", label: "Dashboard", route: "dashboard" }],
      },
    ];
    const accountContext: AccountContext = {
      id: "admin:@steve-mcqueen-957d5e38",
      label: "steve-mcqueen-957d5e38",
      type: "personal",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminShell
          slug="@steve-mcqueen-957d5e38"
          sections={sections}
          accountContext={accountContext}
        >
          <div>Content</div>
        </AdminShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("account-context-id").textContent).toBe(
      "@steve-mcqueen-957d5e38",
    );
    expect(screen.getByTestId("available-context-labels").textContent).toBe(
      "Steve McQueen",
    );
  });

  const renderShell = () => {
    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [{ id: "orders", label: "Orders", route: "orders" }],
      },
    ];
    const accountContext: AccountContext = {
      id: "ctx",
      label: "Acme",
      type: "org",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    return render(
      <QueryClientProvider client={queryClient}>
        <AdminShell
          slug="acme-co"
          sections={sections}
          accountContext={accountContext}
        >
          <div>Content</div>
        </AdminShell>
      </QueryClientProvider>,
    );
  };

  // ── Bookings rail badge (booking-inbox-placement FR-007) ────────────────
  describe("Bookings rail badge", () => {
    const renderWithBookings = () => {
      const sections: NavigationSection[] = [
        {
          id: "main",
          label: "Main",
          items: [
            { id: "orders", label: "Orders", route: "orders" },
            { id: "bookings", label: "admin.navBookings", route: "bookings" },
          ],
        },
      ];
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      return render(
        <QueryClientProvider client={queryClient}>
          <AdminShell
            slug="acme-co"
            sections={sections}
            accountContext={{ id: "ctx", label: "Acme", type: "org" }}
          >
            <div>Content</div>
          </AdminShell>
        </QueryClientProvider>,
      );
    };

    it("sums the org-as-act inbox and every venue inbox onto the Bookings item", () => {
      // The spec's seeded shape: 2 org-as-act opens, venues with 3 and 0.
      mockedCountOpenQuery.mockReturnValue({
        data: {
          performerInbox: 2,
          venues: [
            { placeId: "p1", placeName: "The Basement", openCount: 3 },
            { placeId: "p2", placeName: "Blue Room", openCount: 0 },
          ],
          ownedPlacesTruncated: false,
        },
      });

      renderWithBookings();

      expect(screen.getByTestId("nav-item-badges").textContent).toBe(
        "bookings=5",
      );
    });

    it("renders NO badge when nothing is open (0 must not render an empty badge)", () => {
      mockedCountOpenQuery.mockReturnValue({
        data: {
          performerInbox: 0,
          venues: [{ placeId: "p1", placeName: "The Basement", openCount: 0 }],
          ownedPlacesTruncated: false,
        },
      });

      renderWithBookings();

      expect(screen.getByTestId("nav-item-badges").textContent).toBe("");
    });

    it("renders the rail without a badge when the count fails, and never toasts", () => {
      // A failed count leaves the query with no data. The no-toast half of
      // the contract is the query OPTIONS — `meta.silent` + `retry: false` —
      // so assert on those rather than on the absence of a toast element,
      // which would pass vacuously in a shell that renders no toaster.
      mockedCountOpenQuery.mockReturnValue({
        data: undefined,
        isError: true,
      });

      renderWithBookings();

      expect(screen.getByTestId("nav-item-badges").textContent).toBe("");
      const options = mockedCountOpenQuery.mock.calls[0]?.[1] as any;
      expect(options.meta).toEqual({ silent: true });
      expect(options.retry).toBe(false);
    });

    it("queries countOpen with the HUMAN selector in a human admin context, and badges the venue sum only", () => {
      // A person can own venues directly; their requests render on the
      // personal Bookings page, so the rail badges them. The wire's
      // `performerInbox` is the person's act-side inbox, which lives in
      // account settings — NOT on that page — so it is left out of the badge.
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs: [
          {
            kind: "human",
            humanId: "11111111-1111-4111-8111-111111111111",
            humanName: "Steve",
            adminSlug: "acme-co",
          },
        ],
        preferredAdminSlug: "acme-co",
      });
      mockedCountOpenQuery.mockReturnValue({
        data: {
          performerInbox: 2,
          venues: [
            { placeId: "p1", placeName: "Red Rocks", openCount: 3 },
            { placeId: "p2", placeName: "Blue Room", openCount: 1 },
          ],
          ownedPlacesTruncated: false,
        },
      });

      renderWithBookings();

      const [input, options] = mockedCountOpenQuery.mock.calls[0] as any[];
      expect(input).toEqual({ owner: { kind: "human" } });
      expect(options.enabled).toBe(true);
      expect(screen.getByTestId("nav-item-badges").textContent).toBe(
        "bookings=4",
      );
    });

    it("does not query countOpen when the slug resolves to NO owner", () => {
      // Neither an org id nor a human actor to count for — the query must
      // stay off rather than fire the human selector against a stranger's
      // slug.
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs: [],
        preferredAdminSlug: null,
      });
      mockedCountOpenQuery.mockReturnValue({ data: undefined });

      renderWithBookings();

      const options = mockedCountOpenQuery.mock.calls[0]?.[1] as any;
      expect(options.enabled).toBe(false);
      expect(screen.queryByTestId("nav-item-badges")?.textContent ?? "").toBe(
        "",
      );
    });

    it("sends the org id shorthand for an org admin context", () => {
      mockedCountOpenQuery.mockReturnValue({ data: undefined });

      renderWithBookings();

      const [input, options] = mockedCountOpenQuery.mock.calls[0] as any[];
      expect(input).toEqual({ orgId: expect.any(String) });
      expect(input.orgId).not.toBe("");
      expect(options.enabled).toBe(true);
    });
  });

  describe("mobile top bar rework (PART 1)", () => {
    it("renders the brand as ONE home anchor and passes no onBrandPress (no link-in-button nesting)", () => {
      renderShell();

      expect(screen.getByTestId("on-brand-press").textContent).toBe("unset");

      const brandSlot = screen.getByTestId("brand-slot");
      const anchor = brandSlot.querySelector("a[href='/']");
      expect(anchor).not.toBeNull();
      expect(anchor).toHaveAttribute("aria-label");
      // ONE element: never a link inside a button (or vice versa).
      expect(brandSlot.querySelectorAll("button")).toHaveLength(0);
      expect(brandSlot.querySelectorAll("a")).toHaveLength(1);
    });

    it("mobile trailing slot carries ONLY the 48px notifications control", () => {
      renderShell();

      const mobile = screen.getByTestId("trailing-mobile");
      const bell = within(mobile).getByTestId("alerts-sidebar");
      expect(bell).toHaveAttribute("data-dimension", "48");
      expect(within(mobile).queryByTestId("theme-toggle")).toBeNull();
      expect(within(mobile).queryByTestId("language-switcher")).toBeNull();
    });

    it("desktop trailing slot keeps notifications + theme + language", () => {
      renderShell();

      const desktop = screen.getByTestId("trailing-desktop");
      expect(within(desktop).getByTestId("alerts-sidebar")).toHaveAttribute(
        "data-dimension",
        "",
      );
      expect(within(desktop).getByTestId("theme-toggle")).toBeInTheDocument();
      expect(
        within(desktop).getByTestId("language-switcher"),
      ).toBeInTheDocument();
    });

    it("moves theme + language into the drawer footer as a labelled block", () => {
      renderShell();

      const footer = screen.getByTestId("quick-action-footer");
      expect(within(footer).getByTestId("theme-toggle")).toBeInTheDocument();
      expect(
        within(footer).getByTestId("language-switcher"),
      ).toBeInTheDocument();
      // Visible block label (uppercase-tracked via style; copy resolves from
      // the web catalog at runtime — jsdom falls back to the raw key).
      expect(footer.textContent).toMatch(/preferences/i);
    });
  });

  // ── Mobile bottom-bar SCAN center action (one-bottom-bar redesign) ──────
  describe("SCAN bottom-bar center action", () => {
    it("offers SCAN on the workspace rail for a scan-capable role (ADMIN)", () => {
      // Default beforeEach fixture: org workspace, role ADMIN (in
      // ORG_SCAN_ROLES), non-event pathname.
      renderShell();

      expect(screen.getByTestId("bottom-bar-center-action").textContent).toBe(
        "scan",
      );
    });

    it("drops SCAN inside a nested rail context (event route)", () => {
      // The bar shows event nav there and the builder owns its own header —
      // the `railContext || !canScan` gate must yield undefined.
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/events/33333333-3333-4333-8333-333333333333/attendees",
      );
      renderShell();

      expect(screen.getByTestId("bottom-bar-center-action").textContent).toBe(
        "",
      );
    });

    it("drops SCAN inside the place rail context too (FR-203)", () => {
      // Place context rides the same `railContext || !canScan` gate — the
      // bar shows place nav there, never the raised scan square.
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/places/44444444-4444-4444-8444-444444444444/settings",
      );
      renderShell();

      expect(screen.getByTestId("bottom-bar-center-action").textContent).toBe(
        "",
      );
    });
  });

  it("renders the error card with a Retry button when the owner query errors", () => {
    mockedUseEventOwnerEntities.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
      ownersWithSlugs: undefined,
      preferredAdminSlug: null,
    });

    renderShell();

    // Anchor on the copy-independent contract of the error card: the `alert`
    // role and a Retry button. We avoid asserting the title text because, in
    // jsdom, `useTranslations` falls back to the shared @th/locale catalog
    // (which doesn't carry these admin keys) — so a text assertion would be
    // coupled to catalog-membership trivia and would break the day someone adds
    // the keys upstream, not to any real behaviour of this component.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Admin chrome must NOT render in the error branch.
    expect(screen.queryByTestId("current-route")).toBeNull();
  });

  it("Retry calls refetch", () => {
    const refetch = vi.fn();
    mockedUseEventOwnerEntities.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: true,
      isFetching: false,
      refetch,
      ownersWithSlugs: undefined,
      preferredAdminSlug: null,
    });

    renderShell();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(refetch).toHaveBeenCalled();
  });

  it("renders the error card after the 15s load timeout when the query never resolves", () => {
    vi.useFakeTimers();

    mockedUseEventOwnerEntities.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      ownersWithSlugs: undefined,
      preferredAdminSlug: null,
    });

    renderShell();

    // Before the timeout we're in the loading branch: assert the ABSENCE of the
    // error card's contract (no alert, no Retry button) rather than matching
    // catalog-dependent loading copy.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();

    // After the 15s safety-net timeout trips, the error card replaces it. The
    // loading branch is selected by `data: undefined` (not `isPending`), so a
    // query that never resolves falls through to this timeout path.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  describe("event-context rail swap (FR-202/FR-203)", () => {
    const EVENT_ID = "33333333-3333-4333-8333-333333333333";

    /**
     * A complete, strict-shaped `getEventTitle` answer for the URL org's own
     * event (the output schema is `.strict()`; a partial fixture leaves the
     * owner fields undefined, which no real response does).
     */
    const ownedOrgMeta = {
      eventId: EVENT_ID,
      title: "Warehouse Show",
      status: "DRAFT",
      slug: null,
      stewardship: "OWNED",
      ownerOrgId: "22222222-2222-4222-8222-222222222222",
      ownerHumanId: null,
      ownerHumanName: null,
      viewerCanEdit: true,
      viewerCanManage: true,
      viewerCanManagePayouts: true,
    };

    const renderOnEventRoute = (subRoute = "attendees") => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        `/admin/acme-co/events/${EVENT_ID}/${subRoute}`,
      );
      return renderShell();
    };

    it("swaps to Build + Manage sections with a back slot and per-event persist key", () => {
      renderOnEventRoute();

      expect(screen.getByTestId("nav-section-ids").textContent).toBe(
        "event-build,event-manage",
      );
      expect(screen.getByTestId("rail-back-href").textContent).toBe(
        "/admin/acme-co/events",
      );
      expect(screen.getByTestId("rail-persist-key").textContent).toBe(
        `acme-co:event:${EVENT_ID}`,
      );
      // Build anchors carry the ?section= deep link into the edit surface.
      expect(screen.getByTestId("first-item-route").textContent).toBe(
        `/admin/acme-co/events/${EVENT_ID}/edit?section=essentials`,
      );
    });

    it("disables comps + suggestions until the event is PUBLISHED", () => {
      renderOnEventRoute();

      const summary = screen.getByTestId("nav-item-summary").textContent ?? "";
      expect(summary).toContain("comp-tickets:disabled");
      expect(summary).toContain("suggestions:disabled");
      expect(summary).toContain("attendees");
      expect(summary).not.toContain("attendees:disabled");
    });

    it("enables comps + suggestions and shows the status chip once PUBLISHED", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
        },
      });
      renderOnEventRoute();

      const summary = screen.getByTestId("nav-item-summary").textContent ?? "";
      expect(summary).not.toContain("comp-tickets:disabled");
      expect(summary).not.toContain("suggestions:disabled");
      expect(
        within(screen.getByTestId("rail-context-header")).getByText(
          "PUBLISHED",
        ),
      ).toBeInTheDocument();
    });

    it("keeps the chip hidden and gated items dark for read-only roles even though the title query carries status", () => {
      // VIEWER can resolve the slug (any-role) but reads nothing gated — the
      // status rides the title query that runs for everyone, so the role gate
      // must live on the VALUE, not the query enablement.
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs: [
          {
            kind: "org",
            orgId: "22222222-2222-4222-8222-222222222222",
            orgName: "Acme",
            orgSlug: "acme-co",
            role: "VIEWER",
            adminSlug: "acme-co",
          },
        ],
        preferredAdminSlug: "acme-co",
      });
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
        },
      });
      renderOnEventRoute();

      const header = screen.getByTestId("rail-context-header");
      expect(within(header).getByText("Warehouse Show")).toBeInTheDocument();
      expect(within(header).queryByText("PUBLISHED")).toBeNull();
    });

    // "View event" moved OUT of the builder header and into the rail
    // (2026-08-30), so it covers the builder and all five ops surfaces from
    // one place. These pin the gate on the href the rail derives.
    it("derives a View event href once the event is PUBLISHED with a slug", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
          slug: "acme-co/us/general/warehouse-show",
        },
      });
      renderOnEventRoute();

      expect(screen.getByTestId("rail-view-href")).toHaveTextContent(
        "/events/acme-co/us/general/warehouse-show",
      );
    });

    it("withholds View event while the event is unpublished", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "DRAFT",
          slug: "acme-co/us/general/warehouse-show",
        },
      });
      renderOnEventRoute();

      expect(screen.getByTestId("rail-view-href")).toHaveTextContent("");
    });

    it("withholds View event when PUBLISHED but no slug has been assigned", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
          slug: null,
        },
      });
      renderOnEventRoute();

      expect(screen.getByTestId("rail-view-href")).toHaveTextContent("");
    });

    it("resolves status for FINANCE so the comps ledger item can enable post-publish", () => {
      // FINANCE reaches the comp-tickets ledger now (its read contract is
      // ORG_EDIT_OR_FINANCE_ROLES) — with the old editor-only status gate the
      // widened rail rbac showed FINANCE a permanently "post-pub"-disabled
      // item on a live event.
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs: [
          {
            kind: "org",
            orgId: "22222222-2222-4222-8222-222222222222",
            orgName: "Acme",
            orgSlug: "acme-co",
            role: "FINANCE",
            adminSlug: "acme-co",
          },
        ],
        preferredAdminSlug: "acme-co",
      });
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
        },
      });
      renderOnEventRoute();

      const summary = screen.getByTestId("nav-item-summary").textContent ?? "";
      expect(summary).not.toContain("comp-tickets:disabled");
      expect(
        within(screen.getByTestId("rail-context-header")).getByText(
          "PUBLISHED",
        ),
      ).toBeInTheDocument();
    });

    // Roles / signups / badges / rewards throw EVENT_NOT_ORG_OWNED on a
    // person's event, for everyone; the rail learns the owner from the same
    // getEventTitle answer the route shell's `requireOrgEvent` gates on.
    it("drops the volunteer children on a person-owned event, keeps setup", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "House Show",
          status: "PUBLISHED",
          ownerOrgId: null,
          ownerHumanId: "44444444-4444-4444-8444-444444444444",
        },
      });
      renderOnEventRoute("volunteers");

      expect(screen.getByTestId("nav-item-summary").textContent).toContain(
        "volunteers",
      );
      expect(screen.getByTestId("nav-volunteer-children").textContent).toBe("");
    });

    it("keeps the volunteer children on an org event and while the owner is unknown", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          eventId: EVENT_ID,
          title: "Warehouse Show",
          status: "PUBLISHED",
          ownerOrgId: "11111111-1111-4111-8111-111111111111",
          ownerHumanId: null,
        },
      });
      const view = renderOnEventRoute("volunteers");
      expect(screen.getByTestId("nav-volunteer-children").textContent).toBe(
        "volunteers-roles,volunteers-signups,volunteers-badges,volunteers-rewards",
      );
      view.unmount();

      mockedGetEventTitleQuery.mockReturnValue({ data: undefined });
      renderOnEventRoute("volunteers");
      expect(
        screen.getByTestId("nav-volunteer-children").textContent,
      ).toContain("volunteers-roles");
    });

    // An ownerless COMMUNITY listing (2026-10-07): the rail's rights come
    // from getEventTitle's answer about the EVENT, not the URL org's role. The
    // default workspace here is an org ADMIN; the server answers a community
    // moderator with edit only. Acceptance bar: no item whose page the server
    // refuses.
    //
    // This file's NavigationShell mock does NOT filter by role: these cases
    // show the builder's output (which items exist, and `nav-rbac-ids` for
    // whether they still carry `rbac`). That the URL-role filter can no longer
    // act on an ownerless rail is proven with the real `filterSections` in
    // event-nav-sections.test.tsx.
    const communityModeratorMeta = {
      eventId: EVENT_ID,
      title: "Open Mic",
      status: "PUBLISHED",
      slug: null,
      stewardship: "COMMUNITY",
      ownerOrgId: null,
      ownerHumanId: null,
      ownerHumanName: null,
      viewerCanEdit: true,
      viewerCanManage: false,
      viewerCanManagePayouts: false,
    };

    it("shows a moderator who is ADMIN of the URL org only the surfaces a COMMUNITY listing serves", () => {
      mockedGetEventTitleQuery.mockReturnValue({ data: communityModeratorMeta });
      renderOnEventRoute("suggestions");

      expect(screen.getByTestId("nav-item-summary").textContent).toBe(
        "build-essentials,build-details,build-lineup,suggestions",
      );
      // Status still resolves (event-derived edit right), so suggestions is
      // live on a published listing and the chip shows.
      expect(
        within(screen.getByTestId("rail-context-header")).getByText(
          "PUBLISHED",
        ),
      ).toBeInTheDocument();
    });

    it("drops comp-tickets off /edit for a COMMUNITY listing (stewardship from the title query)", () => {
      mockedGetEventTitleQuery.mockReturnValue({ data: communityModeratorMeta });
      renderOnEventRoute("attendees");

      expect(screen.getByTestId("nav-item-summary").textContent).not.toContain(
        "comp-tickets",
      );
    });

    it("shows a URL-org VIEWER who moderates the same listing rail (the event's answer, not the URL's)", () => {
      mockedUseEventOwnerEntities.mockReturnValue({
        data: { owners: [] },
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
        ownersWithSlugs: [
          {
            kind: "org",
            orgId: "22222222-2222-4222-8222-222222222222",
            orgName: "Acme",
            orgSlug: "acme-co",
            role: "VIEWER",
            adminSlug: "acme-co",
          },
        ],
        preferredAdminSlug: "acme-co",
      });
      mockedGetEventTitleQuery.mockReturnValue({ data: communityModeratorMeta });
      renderOnEventRoute("suggestions");

      expect(screen.getByTestId("nav-item-summary").textContent).toBe(
        "build-essentials,build-details,build-lineup,suggestions",
      );
    });

    // Regression guard for OWNED events: the server's `viewerCanEdit: false`
    // must NOT switch an owned event onto event-derived rights. The rail
    // stays on the URL-role path: full rail, every gate still an `rbac`.
    const FULL_OWNED_RAIL =
      "build-essentials,build-details,build-tickets,build-lineup,build-splits,build-settings,attendees,volunteers,comp-tickets,suggestions,feedback";
    const OWNED_RBAC_IDS =
      "event-build,attendees,volunteers,comp-tickets,suggestions,feedback";

    it("keeps the URL-role path for an OWNED org event, even when the server says no edit", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: { ...ownedOrgMeta, status: "PUBLISHED", viewerCanEdit: false },
      });
      renderOnEventRoute("attendees");

      expect(screen.getByTestId("nav-item-summary").textContent).toBe(
        FULL_OWNED_RAIL,
      );
      expect(screen.getByTestId("nav-rbac-ids").textContent).toBe(
        OWNED_RBAC_IDS,
      );
    });

    it("keeps the URL-role path for a personal event (the delegate branch)", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: {
          ...ownedOrgMeta,
          status: "PUBLISHED",
          ownerOrgId: null,
          ownerHumanId: "44444444-4444-4444-8444-444444444444",
          ownerHumanName: "Pat",
          viewerCanEdit: false,
          viewerCanManage: false,
          viewerCanManagePayouts: false,
        },
      });
      renderOnEventRoute("attendees");

      expect(screen.getByTestId("nav-item-summary").textContent).toBe(
        FULL_OWNED_RAIL,
      );
      expect(screen.getByTestId("nav-rbac-ids").textContent).toBe(
        OWNED_RBAC_IDS,
      );
    });

    it("strips rbac from an ownerless COMMUNITY rail (the event decides, not the URL role)", () => {
      mockedGetEventTitleQuery.mockReturnValue({ data: communityModeratorMeta });
      renderOnEventRoute("suggestions");

      expect(screen.getByTestId("nav-rbac-ids").textContent).toBe("");
    });

    it("shows the event title from getEventTitle in the rail context header", () => {
      mockedGetEventTitleQuery.mockReturnValue({
        data: { ...ownedOrgMeta, title: "Warehouse Show" },
      });
      renderOnEventRoute("edit");

      expect(
        within(screen.getByTestId("rail-context-header")).getByText(
          "Warehouse Show",
        ),
      ).toBeInTheDocument();
    });

    it("prefetches the event's surfaces when the event rail mounts (rail clicks feel like tabs)", () => {
      const router = NextNavigation.useRouter() as unknown as {
        prefetch: ReturnType<typeof vi.fn>;
      };
      router.prefetch.mockClear();

      renderOnEventRoute();

      const base = `/admin/acme-co/events/${EVENT_ID}`;
      for (const segment of [
        "edit",
        "attendees",
        "volunteers",
        "comp-tickets",
        "suggestions",
        "feedback",
      ]) {
        expect(router.prefetch).toHaveBeenCalledWith(`${base}/${segment}`);
      }
    });

    it("keeps the workspace rail on the events list and the create flow (FR-301)", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/events/new",
      );
      renderShell();

      expect(screen.getByTestId("nav-section-ids").textContent).toBe("main");
      expect(screen.getByTestId("rail-back-href").textContent).toBe("");
      expect(screen.getByTestId("rail-persist-key").textContent).toBe(
        "acme-co",
      );
    });
  });

  describe("place-context rail swap (place-admin-rail-context FR-202/FR-203)", () => {
    const PLACE_ID = "44444444-4444-4444-8444-444444444444";

    const renderOnPlaceRoute = (subRoute = "edit") => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        `/admin/acme-co/places/${PLACE_ID}/${subRoute}`,
      );
      return renderShell();
    };

    it("swaps to Venue + Operate sections with a back slot and per-place persist key", () => {
      renderOnPlaceRoute();

      expect(screen.getByTestId("nav-section-ids").textContent).toBe(
        "place-venue,place-operate",
      );
      expect(screen.getByTestId("rail-back-href").textContent).toBe(
        "/admin/acme-co/places",
      );
      expect(screen.getByTestId("rail-persist-key").textContent).toBe(
        `acme-co:place:${PLACE_ID}`,
      );
      expect(screen.getByTestId("first-item-route").textContent).toBe(
        `/admin/acme-co/places/${PLACE_ID}/settings`,
      );
    });

    it("keeps the place title query disabled off place routes and enabled on them", () => {
      // Registry contract: usePlaceRailContext runs on EVERY render, so its
      // query must self-disable while unmatched.
      renderShell(); // default pathname: /admin/acme-co/orders
      const offRouteOptions = mockedGetPlaceTitleQuery.mock
        .calls[0]?.[1] as any;
      expect(offRouteOptions.enabled).toBe(false);

      mockedGetPlaceTitleQuery.mockClear();
      renderOnPlaceRoute();
      const onRouteCall = mockedGetPlaceTitleQuery.mock.calls[0] as any[];
      expect(onRouteCall[0]).toEqual({ placeId: PLACE_ID });
      expect(onRouteCall[1].enabled).toBe(true);
    });

    it("shows the place name + verification chip from getPlaceTitle in the rail context header", () => {
      mockedGetPlaceTitleQuery.mockReturnValue({
        data: {
          id: PLACE_ID,
          name: "The Basement",
          slug: "the-basement",
          status: "ACTIVE",
          verification: "VERIFIED",
        },
      });
      renderOnPlaceRoute("bookings");

      const header = screen.getByTestId("rail-context-header");
      expect(within(header).getByText("The Basement")).toBeInTheDocument();
      expect(within(header).getByText("VERIFIED")).toBeInTheDocument();
    });

    it("prefetches the six place surfaces when the place rail mounts", () => {
      const router = NextNavigation.useRouter() as unknown as {
        prefetch: ReturnType<typeof vi.fn>;
      };
      router.prefetch.mockClear();

      renderOnPlaceRoute();

      // Load-bearing count: the FULL set of place-scoped prefetches, in
      // order — a seventh surface (or a dropped one) must fail here, not
      // ride green on membership checks. `edit`/`verify` are redirectors to
      // `settings` now (FR-401) and must NOT be warmed.
      const base = `/admin/acme-co/places/${PLACE_ID}`;
      const placePrefetches = router.prefetch.mock.calls
        .map((call) => call[0] as string)
        .filter((href) => href.startsWith(`${base}/`));
      expect(placePrefetches).toEqual([
        `${base}/settings`,
        `${base}/page`,
        `${base}/layout`,
        `${base}/calendar`,
        `${base}/bookings`,
        `${base}/volunteers`,
      ]);
    });

    it("keeps the workspace rail on the places list and /places/new", () => {
      for (const pathname of [
        "/admin/acme-co/places",
        "/admin/acme-co/places/new",
      ]) {
        vi.mocked(NextNavigation.usePathname).mockReturnValue(pathname);
        const view = renderShell();

        expect(screen.getByTestId("nav-section-ids").textContent).toBe("main");
        expect(screen.getByTestId("rail-back-href").textContent).toBe("");
        expect(screen.getByTestId("rail-persist-key").textContent).toBe(
          "acme-co",
        );

        view.unmount();
      }
    });
  });
});

describe("ADMIN_SECTIONS layout config", () => {
  it("exposes exactly the 20 known route ids across 6 groups", () => {
    // 20 since Payments merged into Payouts (2026-10-05): `/payments` is a
    // redirect now, not a rail item.
    expect(ADMIN_SECTIONS.map((section) => section.id)).toEqual([
      "programming",
      "sales",
      "audience",
      "door-crew",
      "presence",
      "workspace",
    ]);

    const itemIds = ADMIN_SECTIONS.flatMap((section) =>
      section.items.map((item) => item.id),
    );
    expect(itemIds).toHaveLength(20);
    expect([...itemIds].sort()).toEqual(
      [
        "search",
        "events",
        "places",
        "bookings",
        "application-form-templates",
        "orders",
        "promos",
        "memberships",
        "payouts",
        "audiences",
        "announcements",
        "scan",
        "sell",
        "scanner-setup",
        "card-readers",
        "volunteers",
        "volunteer-templates",
        "embeds",
        "team",
        "settings",
      ].sort(),
    );

    // The dashboard is deliberately absent from the nav — the rail identity
    // block (and the drawer's account header on mobile) is the one way home,
    // so listing it here too put two links to the same href inside one
    // navigation landmark. AdminShell's fallback route id is now the explicit
    // ADMIN_DASHBOARD_ROUTE constant rather than `sections[0].items[0].route`.
    expect(
      ADMIN_SECTIONS.flatMap((section) =>
        section.items.map((item) => item.route),
      ),
    ).not.toContain("dashboard");

    // Settings has NO children, and must not regain any.
    //
    // It used to pin two (`settings-general`, `settings-contact`). Settings is
    // one route per section now and renders its own grouped nav
    // (`@/components/settings` SettingsNav) inside the page, so those two were a
    // stale 2-of-8 subset of a rail rendering right beside them — and they gave
    // `/admin/x/settings` and `/admin/x/settings/general` the appearance of two
    // separate destinations for one view. This assertion is inverted rather than
    // deleted so a future change cannot quietly re-add a third settings rail.
    const settings = ADMIN_SECTIONS.flatMap((section) => section.items).find(
      (item) => item.id === "settings",
    );
    expect(settings).toBeDefined();
    expect(settings?.children).toBeUndefined();

    // Its eight section routes yield a two-segment `currentRoute`
    // (e.g. "settings/contact"), which the rail's default EXACT match never
    // equals — without this opt-in the Settings entry is unlit on seven of the
    // eight URLs.
    expect(settings?.activeMatch).toBe("prefix");
  });

  it("pins each item's rbac and featureFlag (nav-visibility contract)", () => {
    // The regroup must never mutate per-item visibility. A drift here silently
    // widens (or hides) nav affordances — update this table ONLY alongside a
    // deliberate authz-matrix change.
    const visibility = Object.fromEntries(
      ADMIN_SECTIONS.flatMap((section) => section.items).map((item) => [
        item.id,
        { rbac: item.rbac, featureFlag: item.featureFlag },
      ]),
    );

    expect(visibility).toEqual({
      search: { rbac: ORG_ANY_ROLE, featureFlag: undefined },
      events: { rbac: ORG_NON_SCANNER, featureFlag: undefined },
      places: { rbac: ORG_NON_SCANNER, featureFlag: undefined },
      bookings: { rbac: ORG_NON_SCANNER, featureFlag: undefined },
      orders: { rbac: ORG_NON_SCANNER, featureFlag: undefined },
      promos: { rbac: ORG_FINANCE_VIEW, featureFlag: "promos" },
      // Deliberately NO featureFlag: memberships are open to any payee
      // (spec 2026-08-05 removed the unlock gate).
      memberships: { rbac: ORG_FINANCE_VIEW, featureFlag: undefined },
      // The organiser's statement + Stripe setup (Payments merged in). The
      // use cases re-check `canFinanceOrg` server-side.
      // Not ORG_FINANCE_VIEW: VIEWER is refused every read on the page.
      payouts: { rbac: ORG_FINANCE_ROLES, featureFlag: undefined },
      audiences: { rbac: ORG_CONTENT_VIEW, featureFlag: "broadcasts" },
      announcements: { rbac: ORG_CONTENT_VIEW, featureFlag: "broadcasts" },
      scan: { rbac: ORG_SCAN_ROLES, featureFlag: undefined },
      // The box office is ORG_SCAN_ROLES, same as scanning: whoever works a
      // door takes money at it. Every sell procedure re-checks server-side.
      sell: { rbac: ORG_SCAN_ROLES, featureFlag: undefined },
      "scanner-setup": { rbac: ORG_ADMIN_ROLES, featureFlag: undefined },
      "card-readers": { rbac: ORG_ADMIN_ROLES, featureFlag: undefined },
      // Any role: the page opens on the hours report (`orgSummary`,
      // ORG_ANY_ROLE); its edit-gated Asks tab is gated inside the page.
      volunteers: { rbac: ORG_ANY_ROLE, featureFlag: undefined },
      // Any role: `listRoleTemplates` admits every member; writes sit behind
      // the page's own `canManage`.
      "volunteer-templates": { rbac: ORG_ANY_ROLE, featureFlag: undefined },
      "application-form-templates": {
        rbac: ORG_CONTENT_VIEW,
        featureFlag: undefined,
      },
      embeds: { rbac: ORG_CONTENT_VIEW, featureFlag: undefined },
      team: { rbac: ORG_MANAGE_VIEW, featureFlag: undefined },
      settings: { rbac: ORG_MANAGE_VIEW, featureFlag: undefined },
    });
  });

  // FINANCE used to be hidden from the hours report the server serves it, and
  // FINANCE / SCANNER from a templates list the server serves them.
  it.each([
    "OWNER",
    "ADMIN",
    "EDITOR",
    "VIEWER",
    "FINANCE",
    "SCANNER",
  ] as const)(
    "shows %s both workspace volunteer pages (their reads admit any role)",
    (role) => {
      const visibleIds = filterSections(ADMIN_SECTIONS, [role], []).flatMap(
        (section) => section.items.map((item) => item.id),
      );
      expect(visibleIds).toContain("volunteers");
      expect(visibleIds).toContain("volunteer-templates");
    },
  );

  it("drops the audience section entirely when broadcasts is off, keeps sales without promos", () => {
    const withoutFlags = filterSections(ADMIN_SECTIONS, ["OWNER"], []);

    expect(withoutFlags.map((section) => section.id)).not.toContain("audience");
    // `promos` is flag-gated too, but sales survives via its other items.
    // `memberships` has no flag by design (open to any payee), so it stays.
    const sales = withoutFlags.find((section) => section.id === "sales");
    expect(sales?.items.map((item) => item.id)).toEqual([
      "orders",
      "memberships",
      "payouts",
    ]);

    // With both flags on, every group is present.
    const withFlags = filterSections(
      ADMIN_SECTIONS,
      ["OWNER"],
      ["broadcasts", "promos"],
    );
    expect(withFlags.map((section) => section.id)).toEqual(
      ADMIN_SECTIONS.map((section) => section.id),
    );
  });

  // ── In-page anchors: Payouts children (Payments merged in, 2026-10-05) ───
  describe("Payouts anchor children", () => {
    const accountContext: AccountContext = {
      id: "ctx",
      label: "Acme",
      type: "org",
    };

    /** Stands in for PayoutsView: registers a jump handler, reports a section. */
    const FakePayoutsPage = ({
      jump,
      report,
    }: {
      jump: (id: string) => boolean;
      report: string | null;
    }) => {
      const actions = useAdminPageSectionsActions();
      React.useEffect(() => actions?.register("payouts", jump), [actions, jump]);
      React.useEffect(() => {
        if (report) actions?.setActiveSection("payouts", report);
      }, [actions, report]);
      return null;
    };

    const renderWith = (page: React.ReactNode) =>
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AdminPageSectionsProvider>
            <AdminShell
              slug="acme-co"
              sections={ADMIN_SECTIONS}
              accountContext={accountContext}
            >
              {page}
            </AdminShell>
          </AdminPageSectionsProvider>
        </QueryClientProvider>,
      );

    it("off the Payouts page every child is pinned inactive, so the group stays closed", () => {
      renderWith(null);
      expect(screen.getByTestId("nav-payouts-children").textContent).toBe(
        [
          "payouts-balance=false@/admin/acme-co/payouts#balance",
          "payouts-ledger=false@/admin/acme-co/payouts#ledger",
          "payouts-schedule=false@/admin/acme-co/payouts#schedule",
          "payouts-stripe=false@/admin/acme-co/payouts#stripe",
        ].join(","),
      );
    });

    it("on the Payouts page exactly the scroll-spy's section is active", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/payouts",
      );
      renderWith(<FakePayoutsPage jump={() => true} report="ledger" />);
      const summary = screen.getByTestId("nav-payouts-children").textContent!;
      expect(summary).toContain("payouts-ledger=true");
      expect(summary.match(/=true/g)).toHaveLength(1);
    });

    it("a stale report from another route never lights a child", () => {
      // The page reported, then the user navigated away (pathname changed
      // before the unmount cleanup ran): route mismatch wins.
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/orders",
      );
      renderWith(<FakePayoutsPage jump={() => true} report="ledger" />);
      expect(
        screen.getByTestId("nav-payouts-children").textContent,
      ).not.toContain("=true");
    });

    it("selecting a child while the page is mounted scrolls in place — no navigation", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/payouts",
      );
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();
      const jump = vi.fn(() => true);
      renderWith(<FakePayoutsPage jump={jump} report={null} />);

      fireEvent.click(screen.getByTestId("select-payouts-ledger"));
      expect(jump).toHaveBeenCalledWith("ledger");
      expect(router.push).not.toHaveBeenCalled();
    });

    it("selecting a child from elsewhere navigates to the fragment URL", () => {
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();
      renderWith(null);

      fireEvent.click(screen.getByTestId("select-payouts-ledger"));
      expect(router.push).toHaveBeenCalledWith("/admin/acme-co/payouts#ledger");
    });

    it("a page that declines the section (handler returns false) falls through to the router", () => {
      vi.mocked(NextNavigation.usePathname).mockReturnValue(
        "/admin/acme-co/payouts",
      );
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();
      renderWith(<FakePayoutsPage jump={() => false} report={null} />);

      fireEvent.click(screen.getByTestId("select-payouts-ledger"));
      expect(router.push).toHaveBeenCalledWith("/admin/acme-co/payouts#ledger");
    });

    // The bottom bar and drawer are buttons, so the page's unsaved-changes
    // guard only sees their navigation through `guardedNavigate`.
    it("a route select is held by the page's navigation guard until it lets go", () => {
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();
      let held: (() => void) | null = null;
      const unregister = registerNavigationGuard((go) => {
        held = go;
      });
      try {
        renderWith(null);
        fireEvent.click(screen.getByTestId("select-payouts-ledger"));
        expect(router.push).not.toHaveBeenCalled();
        expect(held).not.toBeNull();
        held!();
        expect(router.push).toHaveBeenCalledWith(
          "/admin/acme-co/payouts#ledger",
        );
      } finally {
        unregister();
      }
    });

    it("a route select navigates at once when no guard is registered", () => {
      const router = NextNavigation.useRouter();
      vi.mocked(router.push).mockClear();
      renderWith(null);
      fireEvent.click(screen.getByTestId("select-payouts-ledger"));
      expect(router.push).toHaveBeenCalledWith("/admin/acme-co/payouts#ledger");
    });
  });
});
