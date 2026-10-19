/**
 * The org-workspace application-form template library (spec Phase 4).
 *
 * The pins that matter:
 *   • the owner's own rows AND the platform catalogue both appear, own first;
 *   • a platform row is READ-ONLY — no Edit, no Archive (the server refuses
 *     both, so offering them would only ever 404);
 *   • archiving goes through a confirm and sends an idempotency key;
 *   • the create dialog persists the WHOLE questions array in one call, with
 *     label-less draft cards dropped.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  introText: string | null;
  isPlatform: boolean;
  questions: Array<{
    type: string;
    label: string;
    description: string | null;
    options: Array<{ id: string; label: string }> | null;
    isRequired: boolean;
  }>;
}

interface MockColumn {
  id: string;
  header: ReactNode;
  cell: (row: TemplateRecord) => ReactNode;
}

interface MockDataTableProps {
  columns: MockColumn[];
  rows: TemplateRecord[];
  getRowKey: (row: TemplateRecord) => string;
  emptyState?: ReactNode;
  rowActions?: { render: (row: TemplateRecord) => ReactNode };
}

const ORG_ID = "22222222-2222-4222-8222-222222222222";

const testState = vi.hoisted(() => ({
  items: [] as TemplateRecord[],
  platform: [] as TemplateRecord[],
  archiveMutateAsync: vi.fn(),
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  invalidate: vi.fn(),
  appCode: vi.fn<[unknown], string | null>(() => null),
  canEdit: true,
}));

const platformRow: TemplateRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Performer / artist application",
  description: "For open calls",
  introText: "Tell us about your act.",
  isPlatform: true,
  questions: [
    {
      type: "SHORT_TEXT",
      label: "Act name",
      description: null,
      options: null,
      isRequired: true,
    },
  ],
};

const ownRow: TemplateRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Our open call",
  description: null,
  introText: null,
  isPlatform: false,
  questions: [],
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "org-admin" }),
}));

vi.mock("nanoid", () => ({ nanoid: () => "fixed-client-key" }));

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
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
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
    <div data-testid="application-templates-table">
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
  Text: ({ children, ...rest }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === "role" || key === "data-testid") safe[key] = value;
    }
    return <span {...safe}>{children}</span>;
  },
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
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    applicationFormTemplates: {
      list: {
        useQuery: () => ({
          data: { items: testState.items, platform: testState.platform },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      create: {
        useMutation: () => ({
          mutateAsync: testState.createMutateAsync,
          isPending: false,
        }),
      },
      update: {
        useMutation: () => ({
          mutateAsync: testState.updateMutateAsync,
          isPending: false,
        }),
      },
      archive: {
        useMutation: () => ({
          mutateAsync: testState.archiveMutateAsync,
          isPending: false,
        }),
      },
    },
    useUtils: () => ({
      applicationFormTemplates: {
        list: { invalidate: testState.invalidate },
      },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (e: unknown) => testState.appCode(e),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: testState.canEdit,
    canManage: testState.canEdit,
    canFinance: false,
  }),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: { kind: "org", orgId: ORG_ID, orgName: "Org" },
    isLoading: false,
  }),
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open?: boolean;
    onConfirm?: () => void;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="confirm-archive"
        onClick={() => onConfirm?.()}
      >
        confirm
      </button>
    ) : null,
}));

vi.mock("@/components/AdminTableParts", () => ({
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/volunteering/PlatformTemplateTag", () => ({
  PlatformTemplateTag: () => <span data-testid="platform-tag">platform</span>,
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ trailing }: { trailing?: ReactNode }) => (
    <div>{trailing}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ children }: { children?: ReactNode }) => (
    <div data-testid="page-loading">{children}</div>
  ),
}));

// The shared builder is exercised by its own tests; here it is a controlled
// stand-in so the dialog's SAVE payload is what gets asserted.
vi.mock("@/components/form-builder/FormBuilder", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/form-builder/FormBuilder")
  >("@/components/form-builder/FormBuilder");
  const React = await import("react");
  return {
    ...actual,
    FormBuilder: ({
      questions,
      onQuestionsChange,
    }: {
      questions: Array<{ key: string; label: string }>;
      onQuestionsChange: (next: unknown[]) => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "form-builder-stub" },
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-add-question",
            onClick: () =>
              onQuestionsChange([
                ...questions,
                {
                  key: "stub-1",
                  type: "SHORT_TEXT",
                  label: "Act name",
                  description: "",
                  options: [],
                  isRequired: true,
                },
                // A label-less draft card, which must NOT reach the server.
                {
                  key: "stub-2",
                  type: "SHORT_TEXT",
                  label: "",
                  description: "",
                  options: [],
                  isRequired: false,
                },
              ]),
          },
          `count:${questions.length}`,
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-add-choice-question",
            onClick: () =>
              onQuestionsChange([
                ...questions,
                {
                  key: "stub-choice",
                  type: "SINGLE_CHOICE",
                  label: "Set length",
                  description: "",
                  // No usable options — the exact shape the server refuses.
                  options: [{ value: "" }],
                  isRequired: false,
                },
              ]),
          },
          "add-choice",
        ),
      ),
  };
});

import { ApplicationFormTemplatesView } from "../ApplicationFormTemplatesView";

beforeEach(() => {
  vi.clearAllMocks();
  testState.items = [ownRow];
  testState.platform = [platformRow];
  testState.appCode.mockReturnValue(null);
  testState.canEdit = true;
  testState.archiveMutateAsync.mockResolvedValue({ ok: true });
  testState.createMutateAsync.mockResolvedValue({
    templateId: "new",
    name: "New",
  });
  testState.updateMutateAsync.mockResolvedValue({
    templateId: ownRow.id,
    name: "Renamed",
  });
});

describe("ApplicationFormTemplatesView", () => {
  it("lists the owner's rows AND the platform catalogue, own first", () => {
    render(<ApplicationFormTemplatesView />);

    const names = screen
      .getAllByTestId("cell-name")
      .map((cell) => cell.textContent ?? "");
    expect(names[0]).toContain("Our open call");
    expect(names[1]).toContain("Performer / artist application");
    expect(screen.getByTestId("platform-tag")).toBeInTheDocument();
  });

  it("offers NO edit or archive on a platform row (the server refuses both)", () => {
    render(<ApplicationFormTemplatesView />);

    expect(
      screen.queryByTestId(`application-template-edit-${platformRow.id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`application-template-archive-${platformRow.id}`),
    ).not.toBeInTheDocument();
    // …and it says why, rather than showing an empty action cell.
    expect(screen.getByText("admin.aftReadOnly")).toBeInTheDocument();
  });

  it("offers edit + archive on the owner's own row", () => {
    render(<ApplicationFormTemplatesView />);

    expect(
      screen.getByTestId(`application-template-edit-${ownRow.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`application-template-archive-${ownRow.id}`),
    ).toBeInTheDocument();
  });

  it("archives behind a confirm and sends an idempotency key", async () => {
    render(<ApplicationFormTemplatesView />);

    fireEvent.click(
      screen.getByTestId(`application-template-archive-${ownRow.id}`),
    );
    fireEvent.click(screen.getByTestId("confirm-archive"));

    await waitFor(() =>
      expect(testState.archiveMutateAsync).toHaveBeenCalledWith({
        templateId: ownRow.id,
        clientKey: "fixed-client-key",
      }),
    );
    expect(testState.invalidate).toHaveBeenCalled();
  });

  it("creates a template with the WHOLE question array, dropping label-less drafts", async () => {
    render(<ApplicationFormTemplatesView />);

    fireEvent.click(screen.getByTestId("application-templates-new-btn"));
    fireEvent.change(
      screen.getByTestId("application-template-dialog-name"),
      { target: { value: "Vendor form" } },
    );
    fireEvent.click(screen.getByTestId("stub-add-question"));
    fireEvent.click(screen.getByTestId("application-template-dialog-save"));

    await waitFor(() =>
      expect(testState.createMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testState.createMutateAsync).toHaveBeenCalledWith({
      ownerScope: "ORGANIZATION",
      ownerId: ORG_ID,
      name: "Vendor form",
      description: null,
      introText: null,
      questions: [
        {
          type: "SHORT_TEXT",
          label: "Act name",
          description: null,
          isRequired: true,
        },
      ],
      clientKey: "fixed-client-key",
    });
  });

  it("routes an EDIT through update (never create) with the template id", async () => {
    render(<ApplicationFormTemplatesView />);

    fireEvent.click(
      screen.getByTestId(`application-template-edit-${ownRow.id}`),
    );
    fireEvent.change(
      screen.getByTestId("application-template-dialog-name"),
      { target: { value: "Renamed" } },
    );
    fireEvent.click(screen.getByTestId("application-template-dialog-save"));

    await waitFor(() =>
      expect(testState.updateMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testState.updateMutateAsync.mock.calls[0]![0]).toMatchObject({
      templateId: ownRow.id,
      name: "Renamed",
    });
    expect(testState.createMutateAsync).not.toHaveBeenCalled();
  });

  it("shows TEMPLATE_NAME_TAKEN inline instead of a toast", async () => {
    testState.appCode.mockReturnValue("TEMPLATE_NAME_TAKEN");
    testState.createMutateAsync.mockRejectedValue(new Error("taken"));
    render(<ApplicationFormTemplatesView />);

    fireEvent.click(screen.getByTestId("application-templates-new-btn"));
    fireEvent.change(
      screen.getByTestId("application-template-dialog-name"),
      { target: { value: "Taken" } },
    );
    fireEvent.click(screen.getByTestId("application-template-dialog-save"));

    await waitFor(() =>
      expect(
        screen.getByTestId("application-template-dialog-name-error"),
      ).toBeInTheDocument(),
    );
  });

  /**
   * The nav entry is ORG_CONTENT_VIEW, which includes VIEWER — so this page
   * IS reachable by a role the server refuses every write from. A disabled
   * button still advertises a capability; a VIEWER pressing one only ever
   * earned a generic INSUFFICIENT_ROLE toast. Everything write-shaped is
   * HIDDEN, the same treatment platform rows already get.
   */
  describe("read-only role (VIEWER)", () => {
    it("hides the New template CTA", () => {
      testState.canEdit = false;
      render(<ApplicationFormTemplatesView />);

      expect(
        screen.queryByTestId("application-templates-new-btn"),
      ).not.toBeInTheDocument();
    });

    it("hides per-row Edit and Archive on the owner's OWN rows", () => {
      testState.canEdit = false;
      render(<ApplicationFormTemplatesView />);

      expect(
        screen.queryByTestId(`application-template-edit-${ownRow.id}`),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(`application-template-archive-${ownRow.id}`),
      ).not.toBeInTheDocument();
      // No actions column at all — not a column of empty cells.
      expect(screen.queryByTestId("row-actions")).not.toBeInTheDocument();
    });

    it("hides the empty-state Create CTA too", () => {
      testState.canEdit = false;
      testState.items = [];
      testState.platform = [];
      render(<ApplicationFormTemplatesView />);

      expect(screen.getByText("admin.aftEmptyTitle")).toBeInTheDocument();
      expect(
        screen.queryByTestId("application-templates-create-first-btn"),
      ).not.toBeInTheDocument();
    });

    it("still LISTS the templates — reading is the point of the page", () => {
      testState.canEdit = false;
      render(<ApplicationFormTemplatesView />);

      expect(screen.getAllByTestId("cell-name")).toHaveLength(2);
    });
  });

  it("shows an empty state (with a create CTA for an editor) when nothing exists", () => {
    testState.items = [];
    testState.platform = [];
    render(<ApplicationFormTemplatesView />);

    expect(screen.getByText("admin.aftEmptyTitle")).toBeInTheDocument();
    expect(
      screen.getByTestId("application-templates-create-first-btn"),
    ).toBeInTheDocument();
  });

  it("blocks the save and names the question when a choice has no options", async () => {
    render(<ApplicationFormTemplatesView />);

    fireEvent.click(screen.getByTestId("application-templates-new-btn"));
    fireEvent.change(screen.getByTestId("application-template-dialog-name"), {
      target: { value: "Vendor form" },
    });
    fireEvent.click(screen.getByTestId("stub-add-choice-question"));
    fireEvent.click(screen.getByTestId("application-template-dialog-save"));

    await waitFor(() =>
      expect(
        screen.getByTestId("application-template-dialog-questions-error"),
      ).toHaveTextContent("admin.afOptionsRequiredError"),
    );
    // Nothing posted — the server would have refused the WHOLE array with a
    // code that names no question.
    expect(testState.createMutateAsync).not.toHaveBeenCalled();
  });
});
