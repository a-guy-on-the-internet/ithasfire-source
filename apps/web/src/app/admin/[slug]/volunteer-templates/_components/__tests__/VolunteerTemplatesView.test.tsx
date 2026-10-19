import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-013 — catalogue rows in the organizer's template list.
 *
 * Covers the three things that make a platform row safe to show inline:
 * the "From Ithas Fire" tag, Customise INSTEAD of Edit/Archive (every
 * mutating path 404s on a platform row), and the TEMPLATE_NAME_TAKEN
 * recovery — without which a name collision is a dead end.
 */

interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  archived: boolean;
  isPlatform: boolean;
  packId: string | null;
}

interface MockColumn {
  id: string;
  header: ReactNode;
  cell: (row: TemplateRecord) => ReactNode;
}

interface MockRowActions {
  header: ReactNode;
  width: number;
  render: (row: TemplateRecord) => ReactNode;
}

interface MockDataTableProps {
  columns: MockColumn[];
  rows: TemplateRecord[];
  getRowKey: (row: TemplateRecord) => string;
  emptyState?: ReactNode;
  rowActions?: MockRowActions;
}

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const PACK_ID = "88888888-8888-4888-8888-888888888888";
const FORKED_ID = "99999999-9999-4999-8999-999999999999";

const testState = vi.hoisted(() => ({
  owner: null as unknown,
  hasGroup: true,
  templates: [] as unknown[],
  forkMutateAsync: vi.fn(),
}));

const platformRow: TemplateRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Door",
  description: "Check tickets at the door.",
  defaultCapacity: 2,
  archived: false,
  isPlatform: true,
  packId: PACK_ID,
};

const orgRow: TemplateRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Merch",
  description: null,
  defaultCapacity: null,
  archived: false,
  isPlatform: false,
  packId: null,
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "org-admin" }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={rest["data-testid"]}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  DataTable: (props: MockDataTableProps) => (
    <div data-testid="volunteer-templates-table">
      {props.rows.length === 0
        ? props.emptyState
        : props.rows.map((row) => (
            <div key={props.getRowKey(row)} data-testid="template-row">
              {props.columns.map((col) => (
                <div key={col.id} data-testid={`cell-${col.id}`}>
                  {col.cell(row)}
                </div>
              ))}
              {props.rowActions ? (
                <div data-testid="row-actions">
                  {props.rowActions.render(row)}
                </div>
              ) : null}
            </div>
          ))}
    </div>
  ),
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children?: ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
  Modal: Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <h1>{title}</h1>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  ),
  Switch: () => <input type="checkbox" readOnly />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Tooltip: ({ anchor }: { anchor?: ReactNode }) => <>{anchor}</>,
  useFormatters: () => ({ dateTime: () => "" }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      templates: {
        list: {
          useQuery: () => ({
            data: testState.templates,
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        create: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        update: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        archive: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        upsertShifts: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        fork: {
          useMutation: () => ({
            mutateAsync: testState.forkMutateAsync,
            isPending: false,
          }),
        },
        getWithShifts: { useQuery: () => ({ data: null }) },
      },
    },
    volunteerPacks: {
      list: {
        useQuery: () => ({
          data: [],
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
    },
    useUtils: () => ({
      volunteer: {
        templates: {
          list: { invalidate: vi.fn() },
          getWithShifts: { invalidate: vi.fn() },
        },
      },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.owner ?? {
      kind: "org",
      orgId: ORG_ID,
      orgName: "Org",
    },
    isLoading: false,
    ownerEntities: {
      ownersWithSlugs: testState.hasGroup
        ? [{ kind: "org", orgId: ORG_ID }]
        : [{ kind: "human", humanId: "me" }],
    },
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({ canManage: true, canEdit: true }),
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/AdminTableParts", () => ({
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ trailing }: { trailing?: ReactNode }) => (
    <div>{trailing}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { VolunteerTemplatesView } from "../VolunteerTemplatesView";

describe("VolunteerTemplatesView — platform catalogue rows (FR-013)", () => {
  beforeEach(() => {
    testState.templates = [platformRow, orgRow];
    testState.forkMutateAsync.mockReset();
    // Shape mirrors the fork mutation's real return: the created org-owned
    // template record (RoleTemplateWithShiftsRecord) — handleFork seeds the
    // edit dialog from it.
    testState.forkMutateAsync.mockResolvedValue({
      id: FORKED_ID,
      orgId: ORG_ID,
      name: "Door",
      description: "Check tickets at the door.",
      defaultCapacity: 2,
      sortOrder: 0,
      archived: false,
      isPlatform: false,
      packId: PACK_ID,
      shifts: [],
    });
  });

  it("tags a platform row and offers Customise instead of Edit/Archive", () => {
    render(<VolunteerTemplatesView />);

    expect(
      screen.queryByTestId(`volunteer-template-platform-tag-${platformRow.id}`),
    ).not.toBeNull();
    expect(
      screen.queryByTestId(`volunteer-template-customise-${platformRow.id}`),
    ).not.toBeNull();
    // The catalogue row must not offer the affordances the server refuses.
    expect(
      screen.queryByLabelText("admin.volunteerTemplateEditTooltip"),
    ).not.toBeNull(); // the ORG row still has one
    expect(
      screen.getAllByLabelText("admin.volunteerTemplateEditTooltip"),
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText("admin.volunteerTemplateArchiveTooltip"),
    ).toHaveLength(1);
  });

  it("leaves an org-owned row untagged and without a Customise action", () => {
    render(<VolunteerTemplatesView />);

    expect(
      screen.queryByTestId(`volunteer-template-platform-tag-${orgRow.id}`),
    ).toBeNull();
    expect(
      screen.queryByTestId(`volunteer-template-customise-${orgRow.id}`),
    ).toBeNull();
  });

  it("forks without a name on the first Customise", async () => {
    render(<VolunteerTemplatesView />);

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`volunteer-template-customise-${platformRow.id}`),
      );
    });

    expect(testState.forkMutateAsync).toHaveBeenCalledTimes(1);
    expect(testState.forkMutateAsync).toHaveBeenCalledWith({
      orgId: ORG_ID,
      templateId: platformRow.id,
    });
  });

  it("opens the edit dialog on the forked copy after a successful Customise", async () => {
    render(<VolunteerTemplatesView />);

    // No editor before the fork.
    expect(screen.queryByTestId("volunteer-template-name-input")).toBeNull();

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`volunteer-template-customise-${platformRow.id}`),
      );
    });

    // The SAME edit dialog the row's Edit button opens, seeded with the
    // forked record — the organizer lands directly in "make it theirs".
    expect(
      screen.queryByText("admin.volunteerTemplateDialogEditTitle"),
    ).not.toBeNull();
    const nameInput = screen.getByTestId(
      "volunteer-template-name-input",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Door");
  });

  it("recovers from TEMPLATE_NAME_TAKEN by re-submitting with an explicit name", async () => {
    testState.forkMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("TEMPLATE_NAME_TAKEN"), {
        data: { appCode: "TEMPLATE_NAME_TAKEN" },
      }),
    );

    render(<VolunteerTemplatesView />);

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`volunteer-template-customise-${platformRow.id}`),
      );
    });

    const input = screen.getByTestId("volunteer-template-fork-rename-input");
    expect(input).not.toBeNull();

    fireEvent.change(input, { target: { value: "Door (front)" } });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("volunteer-template-fork-rename-submit"),
      );
    });

    expect(testState.forkMutateAsync).toHaveBeenCalledTimes(2);
    expect(testState.forkMutateAsync).toHaveBeenLastCalledWith({
      orgId: ORG_ID,
      templateId: platformRow.id,
      name: "Door (front)",
    });

    // The rename dialog closes and the editor opens on the renamed fork too.
    expect(
      screen.queryByTestId("volunteer-template-fork-rename-input"),
    ).toBeNull();
    expect(
      screen.queryByText("admin.volunteerTemplateDialogEditTitle"),
    ).not.toBeNull();
  });

  it("does not re-submit a name the org is already using", async () => {
    testState.forkMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("TEMPLATE_NAME_TAKEN"), {
        data: { appCode: "TEMPLATE_NAME_TAKEN" },
      }),
    );

    render(<VolunteerTemplatesView />);

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`volunteer-template-customise-${platformRow.id}`),
      );
    });

    // Typing the colliding name back in re-arms the collision — the submit
    // stays disabled rather than replaying a call that cannot succeed.
    fireEvent.change(
      screen.getByTestId("volunteer-template-fork-rename-input"),
      { target: { value: platformRow.name } },
    );

    const submit = screen.getByTestId(
      "volunteer-template-fork-rename-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe("VolunteerTemplatesView — personal workspace", () => {
  beforeEach(() => {
    testState.templates = [];
    testState.owner = { kind: "human", humanId: "me", humanName: "Me" };
    testState.hasGroup = true;
  });

  it("shows the group-scoped notice and a way to choose an account when the person has a group", () => {
    render(<VolunteerTemplatesView />);

    expect(
      screen.getByText("admin.volunteerTemplatesHumanOwnerNotice"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "admin.chooseAccountLink" }),
    ).toHaveAttribute("href", "/admin");
  });

  it("offers no link when the person has no group (/admin would bounce them back)", () => {
    testState.hasGroup = false;
    render(<VolunteerTemplatesView />);

    expect(
      screen.getByText("admin.volunteerTemplatesHumanOwnerNotice"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
