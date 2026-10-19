import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Render Tamagui primitives as plain DOM so we don't need a TamaguiProvider /
// theme in jsdom (mirrors the platform *MobileCard tests' approach).
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { YStack: Stack, XStack: Stack, Stack };
});

vi.mock("@th/ui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  useTranslations: () => (key: string) => key,
}));

const mockedUseCurrentAdminOwner = vi.fn();

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: (slug: string) => mockedUseCurrentAdminOwner(slug),
}));

const router = { push: vi.fn(), replace: vi.fn() };

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => router,
}));

// The status gate rides the LIGHT getEventTitle query (same key + staleTime
// as the [id] layout / AdminShell rail, so React Query keeps it warm across
// ops-route navigations — no per-navigation spinner).
const getEventTitleUseQuery = vi.fn();

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      getEventTitle: {
        useQuery: (input: unknown, opts: unknown) =>
          getEventTitleUseQuery(input, opts),
      },
    },
  },
}));

import { EventAdminPageShell } from "../EventAdminPageShell";

const baseOwnerEntities = {
  isPending: false,
  isFetching: false,
  refetch: vi.fn(),
};

const orgOwner = (role: string) => ({
  kind: "org",
  orgId: "org-1",
  orgName: "Acme",
  orgSlug: "acme-co",
  role,
  adminSlug: "acme-co",
});

const orgEventMeta = {
  eventId: "evt-1",
  title: "T",
  status: "PUBLISHED",
  slug: null,
  stewardship: "OWNED",
  ownerOrgId: "org-1",
  ownerHumanId: null,
  ownerHumanName: null,
  viewerCanEdit: true,
  viewerCanManage: true,
  viewerCanManagePayouts: true,
};

const resolvedOwner = (owner: unknown) => ({
  currentOwner: owner,
  isLoading: false,
  isError: false,
  ownerEntities: { ...baseOwnerEntities },
});

const renderShell = (
  props: Partial<{
    requireEdit: boolean;
    requireEditOrFinance: boolean;
    requireFinance: boolean;
    requireOrgEvent: boolean;
    forbidCommunity: boolean;
    requirePublished: boolean;
  }> = {},
) =>
  render(
    <EventAdminPageShell slug="acme-co" eventId="evt-1" {...props}>
      {({ canEditEvent, canManageEvent, ownerType, ownerId }) => (
        <div
          data-testid="page-content"
          data-can-edit={String(canEditEvent)}
          data-can-manage={String(canManageEvent)}
          data-owner={`${ownerType}:${ownerId}`}
        />
      )}
    </EventAdminPageShell>,
  );

describe("EventAdminPageShell", () => {
  beforeEach(() => {
    mockedUseCurrentAdminOwner.mockReset();
    getEventTitleUseQuery.mockReset();
    // The shell now waits for the event meta (it decides whose event this is),
    // so the default is a resolved meta for the URL org's own event.
    getEventTitleUseQuery.mockReturnValue({
      data: orgEventMeta,
      isError: false,
    });
    router.push.mockReset();
    router.replace.mockReset();
  });

  it("renders the loading state and not the content while the owner query is pending", () => {
    mockedUseCurrentAdminOwner.mockReturnValue({
      currentOwner: null,
      isLoading: true,
      isError: false,
      ownerEntities: { ...baseOwnerEntities, isPending: true },
    });

    renderShell();

    // The loading branch renders a Spinner (copy-independent contract) and
    // not the page content. We avoid asserting the loading copy because, in
    // jsdom, it resolves against the shared @th/locale catalog rather than
    // apps/web's.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("renders the error state with a Retry button that refetches", () => {
    const refetch = vi.fn();
    mockedUseCurrentAdminOwner.mockReturnValue({
      currentOwner: null,
      isLoading: false,
      isError: true,
      ownerEntities: { ...baseOwnerEntities, refetch },
    });

    renderShell();

    // Anchor on the error branch's contract: a Retry button that calls
    // refetch. (Title copy is catalog-dependent in jsdom.)
    const retryButton = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("renders the no-access state when resolved with no matching owner", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(null));

    renderShell();

    // Terminal state: no content, and its single button routes to /admin.
    const backButton = screen.getByRole("button");
    expect(screen.queryByTestId("page-content")).toBeNull();
    fireEvent.click(backButton);
    expect(router.push).toHaveBeenCalledWith("/admin");
  });

  it("renders the content with owner context when an org admin resolves", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));

    renderShell();

    const content = screen.getByTestId("page-content");
    expect(content).toHaveAttribute("data-can-edit", "true");
    expect(content).toHaveAttribute("data-owner", "org:org-1");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("resolves canEditEvent=false for read-only org roles without gates", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );

    renderShell();

    expect(screen.getByTestId("page-content")).toHaveAttribute(
      "data-can-edit",
      "false",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  // Admin-level actions (unpublish / cancel / regenerate a published slug)
  // follow the events list's `canManage`: ORG_ADMIN_ROLES, or the human's own
  // workspace. An EDITOR edits but is not offered the takedown actions.
  it.each([
    ["OWNER", "true"],
    ["ADMIN", "true"],
    ["EDITOR", "false"],
    ["FINANCE", "false"],
    ["VIEWER", "false"],
  ])("an org %s on its own event gets canManageEvent=%s", (role, expected) => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner(role)));

    renderShell();

    expect(screen.getByTestId("page-content")).toHaveAttribute(
      "data-can-manage",
      expected,
    );
  });

  it("redirects read-only roles to the events list when requireEdit is set (FR-203)", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("VIEWER")),
    );

    renderShell({ requireEdit: true });

    expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
    expect(screen.queryByTestId("page-content")).toBeNull();
    // Redirecting shows the spinner, never a broken/forbidden page.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  // Attendees: the door list is edit-OR-finance, matching the role set
  // `searchEventAttendees` enforces. FINANCE gets in despite canEditEvent
  // being false; VIEWER and SCANNER do not.
  it("admits FINANCE under requireEditOrFinance", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );

    renderShell({ requireEditOrFinance: true });

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "SCANNER"] as const)(
    "redirects %s away from requireEditOrFinance surfaces",
    (role) => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner(role)));

      renderShell({ requireEditOrFinance: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    },
  );

  // Volunteer rewards: finance only. EDITOR can author the event but must not
  // reach reward config — as a tab the client just never rendered it, so the
  // route gate is the only thing enforcing this client-side now.
  it("admits FINANCE under requireFinance", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );

    renderShell({ requireFinance: true });

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("redirects EDITOR away from requireFinance surfaces", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("EDITOR")),
    );

    renderShell({ requireFinance: true });

    expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  // Volunteer rewards: the ledger is finance-gated, but the page first reads
  // the event's ask and roles through edit-gated procedures. `requireEdit` +
  // `requireFinance` together admit only a role holding both.
  describe("requireEdit + requireFinance (volunteer rewards)", () => {
    it.each(["OWNER", "ADMIN"] as const)("admits %s", (role) => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner(role)));

      renderShell({ requireEdit: true, requireFinance: true });

      expect(screen.getByTestId("page-content")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it.each(["EDITOR", "FINANCE", "VIEWER", "SCANNER"] as const)(
      "redirects %s to the events list",
      (role) => {
        mockedUseCurrentAdminOwner.mockReturnValue(
          resolvedOwner(orgOwner(role)),
        );

        renderShell({ requireEdit: true, requireFinance: true });

        expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
        expect(screen.queryByTestId("page-content")).toBeNull();
      },
    );
  });

  // The volunteer roles / signups / badges / rewards reads throw
  // EVENT_NOT_ORG_OWNED for a person's event whoever asks, the owner
  // included, so no role gate can express it.
  describe("requireOrgEvent", () => {
    const ownerHuman = {
      kind: "human",
      humanId: "me",
      humanName: "Me",
      humanUsername: "me",
      avatarUrl: null,
      adminSlug: "@me",
    };
    const personalEventMeta = {
      ...orgEventMeta,
      ownerOrgId: null,
      ownerHumanId: "me",
      ownerHumanName: "Me",
    };

    it("admits an org event", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(
        resolvedOwner(orgOwner("EDITOR")),
      );

      renderShell({ requireEdit: true, requireOrgEvent: true });

      expect(screen.getByTestId("page-content")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("sends the OWNER of a personal event to the events list", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(ownerHuman));
      getEventTitleUseQuery.mockReturnValue({
        data: personalEventMeta,
        isError: false,
      });

      renderShell({ requireEdit: true, requireOrgEvent: true });

      // (The harness mounts every shell under slug "acme-co".)
      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("leaves a personal event alone when the page does not require an org event", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(ownerHuman));
      getEventTitleUseQuery.mockReturnValue({
        data: personalEventMeta,
        isError: false,
      });

      renderShell({ requireEdit: true });

      expect(screen.getByTestId("page-content")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("holds the spinner, without redirecting, while the meta is loading", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(ownerHuman));
      getEventTitleUseQuery.mockReturnValue({
        data: undefined,
        isError: false,
      });

      renderShell({ requireOrgEvent: true });

      expect(router.replace).not.toHaveBeenCalled();
      expect(screen.queryByTestId("page-content")).toBeNull();
      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });
  });

  it("redirects read-only roles under requirePublished (the meta query is the warm, deduped one)", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );

    renderShell({ requireEdit: true, requirePublished: true });

    expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
    // Always enabled now: the shell must know whose event this is before it
    // trusts the URL workspace. Same key + staleTime as the [id] layout's, so
    // React Query serves it from the fetch the layout already made.
    expect(getEventTitleUseQuery).toHaveBeenCalledWith(
      { eventId: "evt-1" },
      { enabled: true, staleTime: 60_000 },
    );
  });

  it("redirects to the edit route when requirePublished and the event is DRAFT (FR-203)", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
    getEventTitleUseQuery.mockReturnValue({
      data: { ...orgEventMeta, status: "DRAFT" },
      isError: false,
    });

    renderShell({ requireEdit: true, requirePublished: true });

    expect(router.replace).toHaveBeenCalledWith(
      "/admin/acme-co/events/evt-1/edit",
    );
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("renders the content when requirePublished and the event is PUBLISHED", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("OWNER")));
    getEventTitleUseQuery.mockReturnValue({
      data: { ...orgEventMeta, status: "PUBLISHED" },
      isError: false,
    });

    renderShell({ requireEdit: true, requirePublished: true });

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    // Same query key + staleTime as the [id] layout's getEventTitle, so
    // React Query dedupes and the gate resolves from warm cache.
    expect(getEventTitleUseQuery).toHaveBeenCalledWith(
      { eventId: "evt-1" },
      { enabled: true, staleTime: 60_000 },
    );
  });

  it("holds a spinner (no content, no redirect) while the status gate resolves", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
    getEventTitleUseQuery.mockReturnValue({
      data: undefined,
      isError: false,
    });

    renderShell({ requireEdit: true, requirePublished: true });

    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("page-content")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // ── requireEditOrFinance + requirePublished (the comps ledger) ─────────
  // The published gate must key off the SAME widened role set the caller
  // chose — historically it was hard-coupled to edit rights, which bounced
  // FINANCE off a surface whose read contract (ORG_EDIT_OR_FINANCE_ROLES)
  // admits them.

  it("admits FINANCE under requireEditOrFinance + requirePublished when PUBLISHED", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );
    getEventTitleUseQuery.mockReturnValue({
      data: { ...orgEventMeta, status: "PUBLISHED" },
      isError: false,
    });

    renderShell({ requireEditOrFinance: true, requirePublished: true });

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    // The status gate actually RAN for FINANCE (it used to stay disabled and
    // redirect before status mattered).
    expect(getEventTitleUseQuery).toHaveBeenCalledWith(
      { eventId: "evt-1" },
      { enabled: true, staleTime: 60_000 },
    );
  });

  it("sends FINANCE to the events list (not the edit route) when the event is DRAFT", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(
      resolvedOwner(orgOwner("FINANCE")),
    );
    getEventTitleUseQuery.mockReturnValue({
      data: { ...orgEventMeta, status: "DRAFT" },
      isError: false,
    });

    renderShell({ requireEditOrFinance: true, requirePublished: true });

    // FINANCE can't act on the edit surface — the events list is the only
    // sensible terminal for them.
    expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it.each(["VIEWER", "SCANNER"] as const)(
    "still redirects %s away from requireEditOrFinance + requirePublished surfaces",
    (role) => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner(role)));

      renderShell({ requireEditOrFinance: true, requirePublished: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    },
  );

  // The event meta says whose event this is and what the server lets this
  // viewer do. When it FAILS the shell shows the retry card — it no longer
  // redirects or falls back to the URL workspace's rights / picker scope.
  it.each([
    ["an edit+published route", { requireEdit: true, requirePublished: true }],
    ["the plain edit route", {}],
  ] as const)(
    "renders the retry card (no content, no redirect) when the event meta fails — %s",
    (_label, props) => {
      const refetch = vi.fn();
      mockedUseCurrentAdminOwner.mockReturnValue(
        resolvedOwner(orgOwner("ADMIN")),
      );
      getEventTitleUseQuery.mockReturnValue({
        data: undefined,
        isError: true,
        isFetching: false,
        refetch,
      });

      renderShell(props);

      expect(screen.queryByTestId("page-content")).toBeNull();
      expect(router.replace).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("admin.eventBuilderRetry"));
      expect(refetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the page mounted when a BACKGROUND refetch fails but cached meta exists", () => {
    mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
    getEventTitleUseQuery.mockReturnValue({
      data: orgEventMeta,
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
    });

    renderShell();

    expect(screen.getByTestId("page-content")).toHaveAttribute(
      "data-can-edit",
      "true",
    );
    expect(screen.queryByText("admin.eventBuilderRetry")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // ── A delegate managing the principal's personal event ─────────────────
  // (owner ruling 2026-09-28). `/admin/@<delegate>/events/<the principal's
  // event>/...` resolves `currentOwner` to the DELEGATE's own workspace; the
  // shell must defer to the server about rights and hand pickers the EVENT's
  // owner, and say whose event it is.
  describe("an event owned by someone other than the URL workspace", () => {
    const me = {
      kind: "human",
      humanId: "me",
      humanName: "Me",
      humanUsername: "me",
      avatarUrl: null,
      adminSlug: "@me",
    };
    const principalMeta = (viewerCanEdit: boolean, viewerCanManage = false) => ({
      ...orgEventMeta,
      ownerOrgId: null,
      ownerHumanId: "principal",
      ownerHumanName: "Pat",
      viewerCanEdit,
      viewerCanManage,
      viewerCanManagePayouts: false,
    });

    it("an edit-role delegate gets the edit UI, the principal's pickers and the banner", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: principalMeta(true),
        isError: false,
      });

      renderShell();

      const content = screen.getByTestId("page-content");
      expect(content).toHaveAttribute("data-can-edit", "true");
      expect(content).toHaveAttribute("data-owner", "human:principal");
      // (The Tamagui mock drops props, so assert the banner by its copy key.)
      expect(
        screen.getByText("admin.ebManagingPrincipalEvent"),
      ).toBeInTheDocument();
    });

    it("a VIEWER delegate gets no edit UI even though the URL is their own workspace", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: principalMeta(false),
        isError: false,
      });

      renderShell();

      expect(screen.getByTestId("page-content")).toHaveAttribute(
        "data-can-edit",
        "false",
      );
    });

    it("a VIEWER delegate is sent away from an edit-gated route", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: principalMeta(false),
        isError: false,
      });

      renderShell({ requireEdit: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    it("holds a spinner until the meta says whose event it is (no flash of an edit UI)", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({ data: undefined, isError: false });

      renderShell();

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    // The URL workspace is the delegate's OWN human workspace, whose hook
    // answer is `canManage: true` — only the server can tell an ADMIN
    // delegate from an EDITOR one.
    it("an EDITOR delegate edits but gets no admin-level actions (the server's answer, not the workspace's)", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: principalMeta(true, false),
        isError: false,
      });

      renderShell();

      const content = screen.getByTestId("page-content");
      expect(content).toHaveAttribute("data-can-edit", "true");
      expect(content).toHaveAttribute("data-can-manage", "false");
    });

    it("an ADMIN delegate gets the admin-level actions", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: principalMeta(true, true),
        isError: false,
      });

      renderShell();

      expect(screen.getByTestId("page-content")).toHaveAttribute(
        "data-can-manage",
        "true",
      );
    });

    it("the human's own event (no delegation) gets the admin-level actions", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        // Own event: the workspace answer applies, whatever the meta says.
        data: { ...principalMeta(true, false), ownerHumanId: "me" },
        isError: false,
      });

      renderShell();

      expect(screen.getByTestId("page-content")).toHaveAttribute(
        "data-can-manage",
        "true",
      );
    });

    it("the workspace's own event shows no banner", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(me));
      getEventTitleUseQuery.mockReturnValue({
        data: { ...principalMeta(true), ownerHumanId: "me" },
        isError: false,
      });

      renderShell();

      expect(screen.getByTestId("page-content")).toHaveAttribute(
        "data-owner",
        "human:me",
      );
      expect(screen.queryByText("admin.ebManagingPrincipalEvent")).toBeNull();
    });
  });

  // An ownerless COMMUNITY listing is no workspace's: the URL org's role says
  // nothing about it. A community moderator who is ADMIN of the URL's org
  // used to pass every gate on that role, for pages the server refused.
  describe("an ownerless event (COMMUNITY listing)", () => {
    const communityMeta = (viewerCanEdit: boolean) => ({
      ...orgEventMeta,
      stewardship: "COMMUNITY",
      ownerOrgId: null,
      ownerHumanId: null,
      ownerHumanName: null,
      viewerCanEdit,
      viewerCanManage: false,
      viewerCanManagePayouts: false,
    });

    it("a moderator who is ADMIN of the URL org edits, but gets no admin-level actions", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({
        data: communityMeta(true),
        isError: false,
      });

      renderShell({ requireEdit: true });

      const content = screen.getByTestId("page-content");
      expect(content).toHaveAttribute("data-can-edit", "true");
      // The URL org ADMIN's workspace answer would say true; the server says
      // a COMMUNITY listing is never managed from the builder.
      expect(content).toHaveAttribute("data-can-manage", "false");
      // Not a delegate: no "managing someone's event" banner.
      expect(screen.queryByText("admin.ebManagingPrincipalEvent")).toBeNull();
    });

    it("the server's 'no edit' outranks an ADMIN URL role on an edit-gated route", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({
        data: communityMeta(false),
        isError: false,
      });

      renderShell({ requireEdit: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    it("a finance-gated route sends the moderator away (a listing carries no payouts)", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({
        data: communityMeta(true),
        isError: false,
      });

      renderShell({ requireEdit: true, requireFinance: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    it("a VIEWER of the URL org who moderates still edits the listing (the event's answer, not the URL's)", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(
        resolvedOwner(orgOwner("VIEWER")),
      );
      getEventTitleUseQuery.mockReturnValue({
        data: communityMeta(true),
        isError: false,
      });

      renderShell({ requireEdit: true });

      expect(screen.getByTestId("page-content")).toHaveAttribute(
        "data-can-edit",
        "true",
      );
      expect(router.replace).not.toHaveBeenCalled();
    });

    // comp-tickets / attendees / volunteers setup / feedback serve nothing on
    // a COMMUNITY listing; the rail hides them and `forbidCommunity` covers a
    // typed URL.
    it("forbidCommunity sends a COMMUNITY listing to the events list", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({
        data: communityMeta(true),
        isError: false,
      });

      renderShell({ requireEdit: true, forbidCommunity: true });

      expect(router.replace).toHaveBeenCalledWith("/admin/acme-co/events");
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    it("forbidCommunity leaves an OWNED event alone", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({
        data: { ...orgEventMeta, stewardship: "OWNED" },
        isError: false,
      });

      renderShell({ requireEdit: true, forbidCommunity: true });

      expect(screen.getByTestId("page-content")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("forbidCommunity does not redirect before the meta loads", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({ data: undefined, isError: false });

      renderShell({ requireEdit: true, forbidCommunity: true });

      expect(router.replace).not.toHaveBeenCalled();
      expect(screen.queryByTestId("page-content")).toBeNull();
    });

    it("before the meta loads, the URL role decides exactly as before (no early redirect)", () => {
      mockedUseCurrentAdminOwner.mockReturnValue(resolvedOwner(orgOwner("ADMIN")));
      getEventTitleUseQuery.mockReturnValue({ data: undefined, isError: false });

      renderShell({ requireEdit: true });

      expect(router.replace).not.toHaveBeenCalled();
    });
  });
});
