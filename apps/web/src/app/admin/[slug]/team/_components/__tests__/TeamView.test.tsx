import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TeamView } from "../TeamView";

// ─────────────────────────────────────────────────────────────────────────────
// Focused harness for the mobile-card role affordance (mirrors the
// OrdersTable.test.tsx mock pattern). The mocked DataTable renders ONLY
// renderMobileCard per row, so these tests exercise exactly the card-mode
// surface that phones (<600px) see.
// ─────────────────────────────────────────────────────────────────────────────

type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";

interface TestMember {
  humanId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
  joinedAt: string;
}

const testState = vi.hoisted(() => ({
  actorRole: "OWNER" as OrgRole,
  ownerKind: "org" as "org" | "human",
  members: [] as unknown[],
  updateRoleMutateAsync: vi.fn(),
  updateRolePending: false,
  transferOwnershipMutateAsync: vi.fn(),
  transferOwnershipPending: false,
  inviteMemberMutateAsync: vi.fn(),
  createDelegateInviteMutateAsync: vi.fn(),
  listMembersInvalidate: vi.fn(),
  ownerEntitiesInvalidate: vi.fn(),
  ownerEntitiesSetData: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
}));

const ownerMember: TestMember = {
  humanId: "member-owner",
  name: "Olive Owner",
  email: "olive@example.com",
  role: "OWNER",
  joinedAt: "2026-01-01T00:00:00.000Z",
};

const viewerMember: TestMember = {
  humanId: "member-viewer",
  name: "Vic Viewer",
  email: "vic@example.com",
  role: "VIEWER",
  joinedAt: "2026-02-01T00:00:00.000Z",
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "test-org" }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

interface MockSelectProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  testId?: string;
}

interface MockDataTableProps {
  rows: TestMember[];
  renderMobileCard?: (row: TestMember) => ReactNode;
}

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
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
  DataTable: ({ rows, renderMobileCard }: MockDataTableProps) => (
    <div data-testid="team-table">
      {rows.map((row) => (
        <div key={row.humanId} data-testid={`team-card-${row.humanId}`}>
          {renderMobileCard?.(row)}
        </div>
      ))}
    </div>
  ),
  Spinner: () => <span>Loading</span>,
  StyledSelect: ({ value, options, onChange, testId }: MockSelectProps) => (
    <select
      data-testid={testId ?? "styled-select"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({ dateTime: () => "Jan 1, 2026" }),
  useNotify: () => ({
    toast: { success: testState.toastSuccess, danger: testState.toastDanger },
  }),
  useTranslations: () => (key: string) => key,
}));


vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({
    title,
    trailing,
  }: {
    title?: ReactNode;
    trailing?: ReactNode;
  }) => (
    <div data-testid="admin-page-header">
      <h1>{title}</h1>
      {trailing}
    </div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ children }: { children?: ReactNode }) => (
    <div data-testid="admin-page-data">{children}</div>
  ),
}));

vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: () => null,
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="confirm-dialog" /> : null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orgs: {
      listMembers: {
        useQuery: () => ({
          data: { items: testState.members, total: testState.members.length },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      listInvitations: {
        useQuery: () => ({ data: { items: [] }, refetch: vi.fn() }),
      },
      updateMemberRole: {
        useMutation: () => ({
          mutateAsync: testState.updateRoleMutateAsync,
          isPending: testState.updateRolePending,
        }),
      },
      transferOwnership: {
        useMutation: () => ({
          mutateAsync: testState.transferOwnershipMutateAsync,
          isPending: testState.transferOwnershipPending,
        }),
      },
      removeMember: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      inviteMember: {
        useMutation: () => ({
          mutateAsync: testState.inviteMemberMutateAsync,
          isPending: false,
        }),
      },
      revokeInvitation: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    delegates: {
      listDelegates: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      updateDelegateRole: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      removeDelegate: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      createInvite: {
        useMutation: () => ({
          mutateAsync: testState.createDelegateInviteMutateAsync,
          isPending: false,
        }),
      },
    },
    useUtils: () => ({
      orgs: { listMembers: { invalidate: testState.listMembersInvalidate } },
      delegates: { listDelegates: { invalidate: vi.fn() } },
      // The source of the actor's own org role (useCurrentAdminOwner reads it).
      events: {
        listEventOwnerEntities: {
          invalidate: testState.ownerEntitiesInvalidate,
          setData: testState.ownerEntitiesSetData,
        },
      },
    }),
  },
}));

// Mirrors the real helper's trap: without the translator it can only say
// "Something went wrong".
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown, t?: unknown) =>
    typeof t === "function"
      ? `formatted: ${String(err)}`
      : "Something went wrong",
}));

vi.mock("@/config/site", () => ({
  getSiteUrl: () => "https://ithasfire.test",
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner:
      testState.ownerKind === "human"
        ? { kind: "human", humanId: "principal-1", adminSlug: "@principal-1" }
        : {
            kind: "org",
            orgId: "org-1",
            orgName: "Test Org",
            orgSlug: "test-org",
            role: testState.actorRole,
            adminSlug: "test-org",
          },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: () => ({
    searchQuery: "",
    debouncedSearch: "",
    page: 0,
    pageSize: 25,
    handleSearchChange: vi.fn(),
    setPage: vi.fn(),
    setPageSize: vi.fn(),
  }),
}));

vi.mock("@/hooks/useColumnVisibility", () => ({
  useColumnVisibility: () => ({
    isVisible: () => true,
    toggleColumn: vi.fn(),
    showAll: vi.fn(),
    hasHidden: false,
  }),
}));

vi.mock("@/hooks/useTableDensity", () => ({
  useTableDensity: () => ({ density: "comfortable", toggleDensity: vi.fn() }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => true,
}));

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({ children }: { children?: ReactNode }) => (
    <div data-testid="action-bar">{children}</div>
  ),
  AdminTableErrorState: () => <div data-testid="admin-table-error" />,
  ColumnSelector: () => <div data-testid="column-selector" />,
  NoResults: ({ title }: { title?: string }) => <div>{title}</div>,
  Pagination: () => <div data-testid="pagination" />,
  SearchBar: () => <input readOnly />,
  SkeletonEmptyState: () => <div data-testid="skeleton-empty" />,
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="table-container">{children}</div>
  ),
}));

describe("TeamView mobile card — role affordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.actorRole = "OWNER";
    testState.ownerKind = "org";
    testState.members = [ownerMember, viewerMember];
  });

  it("gives managers a role select on non-OWNER cards that calls updateMemberRole", () => {
    render(<TeamView />);

    const card = screen.getByTestId(`team-card-${viewerMember.humanId}`);
    const select = within(card).getByTestId(
      `team-role-select-${viewerMember.humanId}`,
    );

    // Same option set as the desktop role column: every role except OWNER.
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(optionValues).toEqual([
      "ADMIN",
      "EDITOR",
      "FINANCE",
      "SCANNER",
      "VIEWER",
    ]);

    fireEvent.change(select, { target: { value: "ADMIN" } });

    expect(testState.updateRoleMutateAsync).toHaveBeenCalledWith({
      orgId: "org-1",
      targetHumanId: viewerMember.humanId,
      newRole: "ADMIN",
    });
  });

  it("keeps the OWNER row read-only (badge, no select) even for managers", () => {
    render(<TeamView />);

    const card = screen.getByTestId(`team-card-${ownerMember.humanId}`);
    expect(
      within(card).queryByTestId(`team-role-select-${ownerMember.humanId}`),
    ).toBeNull();
    expect(within(card).getByTestId("badge").textContent).toBe(
      "admin.roleOwner",
    );
  });

  it("shows non-managers a read-only badge instead of a select", () => {
    testState.actorRole = "EDITOR";
    render(<TeamView />);

    const card = screen.getByTestId(`team-card-${viewerMember.humanId}`);
    expect(
      within(card).queryByTestId(`team-role-select-${viewerMember.humanId}`),
    ).toBeNull();
    expect(within(card).getByTestId("badge").textContent).toBe(
      "admin.roleViewer",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consent flows (security review F3, 2026-09-29): adding someone never grants
// access directly — orgs send a pending invitation, delegates get a link.
// ─────────────────────────────────────────────────────────────────────────────

describe("TeamView — consent-based add flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.actorRole = "OWNER";
    testState.ownerKind = "org";
    testState.members = [ownerMember];
  });

  it("add member always reports an invitation sent (no 'added directly' branch)", async () => {
    testState.inviteMemberMutateAsync.mockResolvedValue({
      invitation: {
        id: "inv-1",
        email: "new@example.com",
        role: "EDITOR",
        status: "PENDING",
        expiresAt: new Date(),
        createdAt: new Date(),
      },
      addedDirectly: false,
    });
    render(<TeamView />);

    fireEvent.click(screen.getByText("admin.addMember"));
    fireEvent.change(screen.getByPlaceholderText("admin.emailPlaceholder"), {
      target: { value: "New@Example.com" },
    });
    fireEvent.click(screen.getByText("admin.addButton"));

    await vi.waitFor(() =>
      expect(testState.toastSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ title: "admin.invitationSent" }),
      ),
    );
    expect(testState.inviteMemberMutateAsync).toHaveBeenCalledWith({
      orgId: "org-1",
      email: "new@example.com",
      role: "VIEWER",
    });
    expect(testState.toastSuccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.memberAdDirectly" }),
    );
  });

  it("add delegate mints an invite link instead of granting access", async () => {
    testState.ownerKind = "human";
    testState.createDelegateInviteMutateAsync.mockResolvedValue({
      token: "v1.abc.def",
      expiresAt: new Date(),
    });
    render(<TeamView />);

    fireEvent.click(screen.getAllByText("admin.addDelegate")[0]!);
    fireEvent.change(screen.getByPlaceholderText("admin.emailPlaceholder"), {
      target: { value: "Assistant@Example.com" },
    });
    fireEvent.click(screen.getByText("admin.delegateInviteCreate"));

    const panel = await screen.findByTestId("delegate-invite-link");
    expect(testState.createDelegateInviteMutateAsync).toHaveBeenCalledWith({
      principalId: "principal-1",
      email: "assistant@example.com",
      role: "VIEWER",
    });
    const link = within(panel).getByLabelText(
      "admin.delegateInviteLinkLabel",
    ) as HTMLInputElement;
    expect(link.value).toBe(
      "https://ithasfire.test/delegate/accept?token=v1.abc.def",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transfer ownership (owner ruling 2026-10-10): only an OWNER changes who holds
// OWNER, and the transfer is one server call that promotes the target and
// demotes the actor together. The page used to promote through
// updateMemberRole and leave two owners behind a "You are now an Admin" toast.
// ─────────────────────────────────────────────────────────────────────────────

describe("TeamView — transfer ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.actorRole = "OWNER";
    testState.ownerKind = "org";
    testState.members = [ownerMember, viewerMember];
    testState.updateRolePending = false;
    testState.transferOwnershipPending = false;
    testState.transferOwnershipMutateAsync.mockReset();
  });

  const transferButton = () =>
    screen.getByText("admin.transfer").closest("button") as HTMLButtonElement;
  const buttonNamed = (label: string) =>
    screen.getByText(label).closest("button") as HTMLButtonElement;

  /** Pick the viewer in the transfer select and open the confirm step. */
  function openTransferConfirm() {
    fireEvent.change(screen.getByTestId("styled-select"), {
      target: { value: viewerMember.humanId },
    });
    fireEvent.click(transferButton());
  }

  it("calls orgs.transferOwnership with the org and the target, never updateMemberRole", async () => {
    testState.transferOwnershipMutateAsync.mockResolvedValue({
      ok: true,
      previousTargetRole: "VIEWER",
    });
    render(<TeamView />);

    openTransferConfirm();
    fireEvent.click(buttonNamed("admin.confirmTransfer"));

    await vi.waitFor(() =>
      expect(testState.transferOwnershipMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testState.transferOwnershipMutateAsync).toHaveBeenCalledWith({
      orgId: "org-1",
      targetHumanId: viewerMember.humanId,
    });
    expect(testState.updateRoleMutateAsync).not.toHaveBeenCalled();
  });

  it("on success toasts, closes the confirm step and refreshes the roster and the actor's role", async () => {
    testState.transferOwnershipMutateAsync.mockResolvedValue({
      ok: true,
      previousTargetRole: "VIEWER",
    });
    render(<TeamView />);

    openTransferConfirm();
    fireEvent.click(buttonNamed("admin.confirmTransfer"));

    await vi.waitFor(() =>
      expect(testState.toastSuccess).toHaveBeenCalledWith({
        title: "admin.ownershipTransferred",
        message: "admin.youAreNowAdmin",
      }),
    );
    expect(testState.toastDanger).not.toHaveBeenCalled();
    expect(testState.listMembersInvalidate).toHaveBeenCalledTimes(1);
    expect(testState.ownerEntitiesInvalidate).toHaveBeenCalledTimes(1);

    // Back to the select step with nothing chosen.
    await vi.waitFor(() =>
      expect(screen.queryByText("admin.confirmTransfer")).toBeNull(),
    );
    expect(transferButton().disabled).toBe(true);
  });

  it("on success writes the actor's ADMIN role into the cached owner entities before the refetch", async () => {
    testState.transferOwnershipMutateAsync.mockResolvedValue({
      ok: true,
      previousTargetRole: "VIEWER",
    });
    render(<TeamView />);

    openTransferConfirm();
    fireEvent.click(buttonNamed("admin.confirmTransfer"));

    await vi.waitFor(() =>
      expect(testState.ownerEntitiesSetData).toHaveBeenCalledTimes(1),
    );
    const [input, updater] = testState.ownerEntitiesSetData.mock.calls[0] as [
      unknown,
      (prev: unknown) => unknown,
    ];
    expect(input).toEqual({});

    const otherOrg = {
      kind: "org",
      orgId: "org-2",
      orgName: "Other Org",
      orgSlug: "other-org",
      role: "OWNER",
      avatarUrl: null,
    };
    const human = {
      kind: "human",
      humanId: "me",
      humanName: "Me",
      humanUsername: null,
      avatarUrl: null,
    };
    const before = {
      owners: [
        { ...otherOrg, orgId: "org-1", orgSlug: "test-org", orgName: "Test Org" },
        otherOrg,
        human,
      ],
    };
    expect(updater(before)).toEqual({
      owners: [
        {
          ...otherOrg,
          orgId: "org-1",
          orgSlug: "test-org",
          orgName: "Test Org",
          role: "ADMIN",
        },
        otherOrg,
        human,
      ],
    });
    // Nothing cached yet: nothing to rewrite.
    expect(updater(undefined)).toBeUndefined();
    // The refetch still runs, after the write, so the server has the last word.
    expect(testState.ownerEntitiesInvalidate).toHaveBeenCalledTimes(1);
    expect(testState.ownerEntitiesSetData.mock.invocationCallOrder[0]).toBeLessThan(
      testState.ownerEntitiesInvalidate.mock.invocationCallOrder[0]!,
    );
  });

  it("drops the transfer section once the refreshed role is ADMIN", () => {
    const { rerender } = render(<TeamView />);
    expect(screen.queryByText("admin.transferOwnership")).not.toBeNull();

    // What the refetched owner entities report after a transfer.
    testState.actorRole = "ADMIN";
    rerender(<TeamView />);

    expect(screen.queryByText("admin.transferOwnership")).toBeNull();
    expect(screen.queryByText("admin.transfer")).toBeNull();
  });

  it("on a refusal shows the formatted reason and keeps the confirm step open for a retry", async () => {
    testState.transferOwnershipMutateAsync.mockRejectedValue(
      new Error("INSUFFICIENT_ROLE"),
    );
    render(<TeamView />);

    openTransferConfirm();
    fireEvent.click(buttonNamed("admin.confirmTransfer"));

    await vi.waitFor(() =>
      expect(testState.toastDanger).toHaveBeenCalledWith({
        title: "admin.transferFailed",
        message: "formatted: Error: INSUFFICIENT_ROLE",
      }),
    );
    expect(testState.toastSuccess).not.toHaveBeenCalled();
    expect(testState.updateRoleMutateAsync).not.toHaveBeenCalled();
    // A refusal leaves the cached role alone; only the refetch may change it.
    expect(testState.ownerEntitiesSetData).not.toHaveBeenCalled();

    // Still on the confirm step, target kept, both buttons usable.
    expect(buttonNamed("admin.confirmTransfer").disabled).toBe(false);
    expect(buttonNamed("admin.cancel").disabled).toBe(false);

    // A refusal means the page is stale, so both sources refetch here too.
    expect(testState.listMembersInvalidate).toHaveBeenCalledTimes(1);
    expect(testState.ownerEntitiesInvalidate).toHaveBeenCalledTimes(1);

    // Retrying sends the same target.
    fireEvent.click(buttonNamed("admin.confirmTransfer"));
    await vi.waitFor(() =>
      expect(testState.transferOwnershipMutateAsync).toHaveBeenCalledTimes(2),
    );
    expect(testState.transferOwnershipMutateAsync).toHaveBeenLastCalledWith({
      orgId: "org-1",
      targetHumanId: viewerMember.humanId,
    });
  });

  it("sends one transfer for a fast double click on Confirm", async () => {
    let finish: (v: unknown) => void = () => {};
    testState.transferOwnershipMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<TeamView />);

    openTransferConfirm();
    const confirm = buttonNamed("admin.confirmTransfer");
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(testState.transferOwnershipMutateAsync).toHaveBeenCalledTimes(1);
    finish({ ok: true, previousTargetRole: "VIEWER" });
    await vi.waitFor(() =>
      expect(testState.toastSuccess).toHaveBeenCalledTimes(1),
    );
  });

  it("disables confirm and cancel while the transfer is pending", () => {
    testState.transferOwnershipPending = true;
    render(<TeamView />);

    openTransferConfirm();

    expect(screen.queryByText("admin.confirmTransfer")).toBeNull();
    expect(buttonNamed("admin.transferring").disabled).toBe(true);
    expect(buttonNamed("admin.cancel").disabled).toBe(true);
  });

  it("does not take its pending state from the role-change mutation", () => {
    testState.updateRolePending = true;
    render(<TeamView />);

    openTransferConfirm();

    expect(buttonNamed("admin.confirmTransfer").disabled).toBe(false);
    expect(buttonNamed("admin.cancel").disabled).toBe(false);
  });
});
