/**
 * The two Phase-4 template dialogs on the event builder:
 *
 *   • ApplicationTemplatePickerDialog — "Start from a template". Pins that the
 *     platform catalogue and the owner's library render as SEPARATE groups,
 *     that apply is gated on a selection, that the fork-on-use call carries a
 *     fresh idempotency key, and — the important one — that
 *     APPLICATION_SUBMISSIONS_EXIST surfaces as an INLINE explanation rather
 *     than a generic toast, because retrying can never fix it.
 *
 *   • SaveApplicationFormTemplateDialog — "Save as template". Pins that
 *     TEMPLATE_NAME_TAKEN lands next to the field (so the user can rename in
 *     place) instead of a toast, and that the dialog says out loud that it
 *     snapshots the SAVED form.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-") || key === "id" || key === "role") {
        domProps[key] = value;
      }
    }
    return React.createElement("span", domProps, children);
  };
  return {
    Text,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled,
          "data-testid": rest["data-testid"],
        },
        children,
      ),
    TextInput: ({
      testId,
      value,
      onChangeText,
      maxLength,
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      maxLength?: number;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        value: value ?? "",
        maxLength,
        onChange: (e: { currentTarget: { value: string } }) =>
          onChangeText?.(e.currentTarget.value),
      }),
    useNotify: () => ({ toast: testMocks.toast }),
    // `t(key, values)` returns the key so assertions are locale-free; the
    // catalog itself is gated by the i18n parity tests.
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../EventEditorSheet", async () => {
  const React = await import("react");
  return {
    EventEditorSheet: ({
      children,
      footer,
      title,
    }: {
      children?: ReactNode;
      footer?: ReactNode;
      title?: string;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "editor-sheet", "aria-label": title },
        children,
        footer,
      ),
  };
});

vi.mock("@/components/volunteering/PlatformTemplateTag", async () => {
  const React = await import("react");
  return {
    PlatformTemplateTag: () =>
      React.createElement(
        "span",
        { "data-testid": "platform-tag" },
        "From Ithas Fire",
      ),
  };
});

vi.mock("nanoid", () => ({ nanoid: () => "fixed-client-key" }));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  applyMutateAsync: vi.fn(),
  saveMutateAsync: vi.fn(),
  listInvalidate: vi.fn(),
  appCode: vi.fn<[unknown], string | null>(() => null),
  toast: { success: vi.fn(), danger: vi.fn() },
  applyPending: false,
  savePending: false,
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (e: unknown) => testMocks.appCode(e),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      applicationFormTemplates: {
        list: { invalidate: testMocks.listInvalidate },
      },
    }),
    applicationFormTemplates: {
      list: { useQuery: testMocks.listUseQuery },
      applyToEvent: {
        useMutation: () => ({
          mutateAsync: testMocks.applyMutateAsync,
          isPending: testMocks.applyPending,
        }),
      },
      saveFromEvent: {
        useMutation: () => ({
          mutateAsync: testMocks.saveMutateAsync,
          isPending: testMocks.savePending,
        }),
      },
    },
  },
}));

import { ApplicationTemplatePickerDialog } from "../ApplicationTemplatePickerDialog";
import { SaveApplicationFormTemplateDialog } from "../SaveApplicationFormTemplateDialog";

const OWNER = {
  ownerScope: "ORGANIZATION" as const,
  ownerId: "22222222-2222-4222-8222-222222222222",
};
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const PLATFORM_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Performer / artist application",
  description: "For open calls",
  isPlatform: true,
  questions: [
    { label: "Act name", isRequired: true },
    { label: "Genre", isRequired: false },
  ],
};

const OWN_ROW = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Our open call",
  description: null,
  isPlatform: false,
  questions: [{ label: "Act name", isRequired: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.applyPending = false;
  testMocks.savePending = false;
  testMocks.appCode.mockReturnValue(null);
  testMocks.listUseQuery.mockReturnValue({
    data: { items: [OWN_ROW], platform: [PLATFORM_ROW] },
    isLoading: false,
  });
  testMocks.applyMutateAsync.mockResolvedValue({
    formId: "77777777-7777-4777-8777-777777777777",
    createdQuestionIds: ["q1", "q2"],
    created: ["Act name", "Genre"],
  });
  testMocks.saveMutateAsync.mockResolvedValue({
    templateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Our open call",
    questionCount: 2,
  });
});

function renderPicker(overrides: Partial<{ onApplied: () => void }> = {}) {
  return render(
    <ApplicationTemplatePickerDialog
      owner={OWNER}
      eventId={EVENT_ID}
      onApplied={overrides.onApplied ?? vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("ApplicationTemplatePickerDialog", () => {
  // The builder hands in the EVENT's owner; this pins that it — and nothing
  // else — scopes the library query.
  it("lists the library of exactly the owner it was handed", () => {
    renderPicker();

    expect(testMocks.listUseQuery).toHaveBeenCalledWith(
      { ownerScope: OWNER.ownerScope, ownerId: OWNER.ownerId },
      expect.anything(),
    );
  });

  it("groups the platform catalogue separately from the owner's library", () => {
    renderPicker();

    expect(screen.getByText("admin.aftPlatformHeading")).toBeInTheDocument();
    expect(screen.getByText("admin.aftOwnHeading")).toBeInTheDocument();
    expect(screen.getByTestId("platform-tag")).toBeInTheDocument();
    expect(
      screen.getByTestId(`application-template-row-${PLATFORM_ROW.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`application-template-row-${OWN_ROW.id}`),
    ).toBeInTheDocument();
  });

  it("keeps Apply disabled until a template is selected", () => {
    renderPicker();

    const apply = screen.getByTestId("application-template-picker-apply");
    expect(apply).toBeDisabled();

    fireEvent.click(
      screen.getByTestId(`application-template-row-${PLATFORM_ROW.id}`),
    );
    expect(apply).not.toBeDisabled();
  });

  it("marks the selected row via aria-checked (it is a radiogroup)", () => {
    renderPicker();

    const row = screen.getByTestId(
      `application-template-row-${PLATFORM_ROW.id}`,
    );
    expect(row).toHaveAttribute("aria-checked", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-checked", "true");
  });

  it("applies the selected template with an idempotency key and reports back", async () => {
    const onApplied = vi.fn();
    renderPicker({ onApplied });

    fireEvent.click(
      screen.getByTestId(`application-template-row-${PLATFORM_ROW.id}`),
    );
    fireEvent.click(screen.getByTestId("application-template-picker-apply"));

    await waitFor(() =>
      expect(testMocks.applyMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testMocks.applyMutateAsync).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      templateId: PLATFORM_ROW.id,
      clientKey: "fixed-client-key",
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(testMocks.toast.success).toHaveBeenCalled();
  });

  it("shows APPLICATION_SUBMISSIONS_EXIST INLINE, not as a toast", async () => {
    testMocks.appCode.mockReturnValue("APPLICATION_SUBMISSIONS_EXIST");
    testMocks.applyMutateAsync.mockRejectedValue(new Error("nope"));
    const onApplied = vi.fn();
    renderPicker({ onApplied });

    fireEvent.click(
      screen.getByTestId(`application-template-row-${OWN_ROW.id}`),
    );
    fireEvent.click(screen.getByTestId("application-template-picker-apply"));

    await waitFor(() =>
      expect(screen.getByTestId("application-template-blocked")).toHaveTextContent(
        "admin.aftBlockedBySubmissions",
      ),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Retrying cannot fix it, so it must NOT be a transient toast, and the
    // dialog must not report success.
    expect(testMocks.toast.danger).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("falls back to a danger toast for any other failure", async () => {
    testMocks.appCode.mockReturnValue("INTERNAL");
    testMocks.applyMutateAsync.mockRejectedValue(new Error("boom"));
    renderPicker();

    fireEvent.click(
      screen.getByTestId(`application-template-row-${OWN_ROW.id}`),
    );
    fireEvent.click(screen.getByTestId("application-template-picker-apply"));

    await waitFor(() => expect(testMocks.toast.danger).toHaveBeenCalled());
    expect(
      screen.queryByTestId("application-template-blocked"),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state when neither the catalogue nor the library has rows", () => {
    testMocks.listUseQuery.mockReturnValue({
      data: { items: [], platform: [] },
      isLoading: false,
    });
    renderPicker();

    expect(
      screen.getByTestId("application-template-picker-empty"),
    ).toBeInTheDocument();
  });

  it("says the template APPENDS — nothing is replaced", () => {
    renderPicker();
    expect(screen.getByText("admin.aftAppendNote")).toBeInTheDocument();
  });
});

function renderSave(questionCount = 2) {
  return render(
    <SaveApplicationFormTemplateDialog
      owner={OWNER}
      eventId={EVENT_ID}
      questionCount={questionCount}
      onClose={vi.fn()}
    />,
  );
}

describe("SaveApplicationFormTemplateDialog", () => {
  it("keeps Save disabled until a name is typed", () => {
    renderSave();

    const save = screen.getByTestId("application-template-save-submit");
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByTestId("application-template-name"), {
      target: { value: "Our open call" },
    });
    expect(save).not.toBeDisabled();
  });

  it("sends the destination scope, a trimmed name and a null blank description", async () => {
    renderSave();

    fireEvent.change(screen.getByTestId("application-template-name"), {
      target: { value: "  Our open call  " },
    });
    fireEvent.click(screen.getByTestId("application-template-save-submit"));

    await waitFor(() =>
      expect(testMocks.saveMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testMocks.saveMutateAsync).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      ownerScope: "ORGANIZATION",
      ownerId: OWNER.ownerId,
      name: "Our open call",
      description: null,
      clientKey: "fixed-client-key",
    });
    expect(testMocks.listInvalidate).toHaveBeenCalled();
  });

  it("renders TEMPLATE_NAME_TAKEN INLINE so the user can rename in place", async () => {
    testMocks.appCode.mockReturnValue("TEMPLATE_NAME_TAKEN");
    testMocks.saveMutateAsync.mockRejectedValue(new Error("taken"));
    renderSave();

    fireEvent.change(screen.getByTestId("application-template-name"), {
      target: { value: "Taken" },
    });
    fireEvent.click(screen.getByTestId("application-template-save-submit"));

    await waitFor(() =>
      expect(
        screen.getByTestId("application-template-name-error"),
      ).toHaveTextContent("admin.aftNameTaken"),
    );
    expect(testMocks.toast.danger).not.toHaveBeenCalled();

    // Typing clears it — the field is usable again immediately.
    fireEvent.change(screen.getByTestId("application-template-name"), {
      target: { value: "Different" },
    });
    expect(
      screen.queryByTestId("application-template-name-error"),
    ).not.toBeInTheDocument();
  });

  it("warns that it snapshots the SAVED form, not the open builder", () => {
    renderSave(3);
    expect(
      screen.getByTestId("application-template-save-note"),
    ).toHaveTextContent("admin.aftSaveFromSavedNote");
  });
});
