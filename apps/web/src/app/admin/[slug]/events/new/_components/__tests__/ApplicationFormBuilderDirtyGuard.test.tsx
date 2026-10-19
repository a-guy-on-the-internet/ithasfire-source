/**
 * ApplicationFormBuilder — the two guards that stand between the organizer
 * and silent data loss.
 *
 * 1. DIRTY GUARD. Applying a template RE-HYDRATES the builder from the
 *    server. Without a guard, an organizer who added a question and trashed a
 *    persisted one would apply a template and watch their addition vanish and
 *    the deletion silently revert. Pressing "Start from a template" while
 *    dirty must therefore CONFIRM first, and must not open the picker until
 *    they say so.
 *
 * 2. OPTIONS PRE-CHECK. The save loop posts one question at a time, so a
 *    choice question with no options would commit everything above it and
 *    then throw OPTIONS_REQUIRED — a partial save. It must be caught before
 *    the first write.
 *
 * 3. TEMPLATE OWNER. Both template dialogs work in the EVENT owner's library
 *    (the `templateOwner` prop), never the URL workspace's — a delegate on a
 *    principal's event must not list or save into their own library.
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
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const ModalRoot = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: ReactNode;
  }) => (open ? React.createElement("div", null, children) : null);
  return {
    Text,
    Modal: Object.assign(ModalRoot, {
      Panel: Passthrough,
      Header: ({ title }: { title?: string }) =>
        React.createElement("h1", null, title),
      Body: Passthrough,
      Footer: Passthrough,
    }),
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
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    Switch: () => React.createElement("input", { type: "checkbox", readOnly: true }),
    // `placeholder` MUST pass through: the label/option fields inside the
    // shared FormBuilder carry no testId, so placeholder is how this spec
    // reaches them.
    TextInput: ({
      testId,
      value,
      onChangeText,
      placeholder,
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      placeholder?: string;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        value: value ?? "",
        placeholder,
        onChange: (e: { currentTarget: { value: string } }) =>
          onChangeText?.(e.currentTarget.value),
      }),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../EventEditorSheet", async () => {
  const React = await import("react");
  return {
    EventEditorSheet: ({
      children,
      footer,
      open,
    }: {
      children?: ReactNode;
      footer?: ReactNode;
      open?: boolean;
    }) =>
      open
        ? React.createElement(
            "div",
            { "data-testid": "editor-sheet" },
            children,
            footer,
          )
        : null,
  };
});

vi.mock("@/components/data-table/ConfirmDialog", async () => {
  const React = await import("react");
  return {
    ConfirmDialog: ({
      open,
      onConfirm,
      onCancel,
      title,
    }: {
      open?: boolean;
      onConfirm?: () => void;
      onCancel?: () => void;
      title?: string;
    }) =>
      open
        ? React.createElement(
            "div",
            { "data-testid": "discard-confirm" },
            React.createElement("span", null, title),
            React.createElement(
              "button",
              {
                type: "button",
                "data-testid": "discard-confirm-yes",
                onClick: () => onConfirm?.(),
              },
              "yes",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                "data-testid": "discard-confirm-no",
                onClick: () => onCancel?.(),
              },
              "no",
            ),
          )
        : null,
  };
});

// The picker + save dialogs have their own tests (which pin that `owner`
// reaches the list query / save mutation); here they are presence markers
// that record the `owner` they were handed.
vi.mock("../ApplicationTemplatePickerDialog", async () => {
  const React = await import("react");
  return {
    ApplicationTemplatePickerDialog: ({ owner }: { owner: unknown }) => {
      dialogOwners.picker = owner;
      return React.createElement("div", { "data-testid": "picker-open" });
    },
  };
});
vi.mock("../SaveApplicationFormTemplateDialog", async () => {
  const React = await import("react");
  return {
    SaveApplicationFormTemplateDialog: ({ owner }: { owner: unknown }) => {
      dialogOwners.save = owner;
      return React.createElement("div", { "data-testid": "save-tpl-open" });
    },
  };
});

const dialogOwners = vi.hoisted(() => ({
  picker: undefined as unknown,
  save: undefined as unknown,
}));

// The URL workspace is a DELEGATE's own. The builder must not consult it for
// the template owner — if it ever does, the owner test below fails.
vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: {
      kind: "human",
      humanId: "99999999-9999-4999-8999-999999999999",
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

const testMocks = vi.hoisted(() => ({
  formUseQuery: vi.fn(),
  formFetch: vi.fn(),
  invalidate: vi.fn(),
  upsertForm: vi.fn(),
  upsertQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        getApplicationForm: {
          invalidate: testMocks.invalidate,
          fetch: testMocks.formFetch,
        },
      },
    }),
    events: {
      getApplicationForm: { useQuery: testMocks.formUseQuery },
      upsertApplicationForm: {
        useMutation: () => ({ mutateAsync: testMocks.upsertForm }),
      },
      upsertApplicationQuestion: {
        useMutation: () => ({ mutateAsync: testMocks.upsertQuestion }),
      },
      deleteApplicationQuestion: {
        useMutation: () => ({ mutateAsync: testMocks.deleteQuestion }),
      },
    },
  },
}));

import { ApplicationFormBuilder } from "../ApplicationFormBuilder";
import type { TemplateOwnerRef } from "../TicketTypeTemplateControls";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const FORM_ID = "77777777-7777-4777-8777-777777777777";
const EVENT_OWNER: TemplateOwnerRef = {
  ownerScope: "ORGANIZATION",
  ownerId: "22222222-2222-4222-8222-222222222222",
};

function formData(
  questions: Array<{
    id: string;
    type: string;
    label: string;
    description: string | null;
    options: unknown;
    isRequired: boolean;
    order: number;
  }>,
) {
  return {
    form: { id: FORM_ID, eventId: EVENT_ID, introText: null },
    questions,
  };
}

const PERSISTED = [
  {
    id: "q-1",
    type: "SHORT_TEXT",
    label: "Act name",
    description: null,
    options: null,
    isRequired: true,
    order: 0,
  },
  {
    id: "q-2",
    type: "SHORT_TEXT",
    label: "Genre",
    description: null,
    options: null,
    isRequired: false,
    order: 1,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  dialogOwners.picker = undefined;
  dialogOwners.save = undefined;
  testMocks.formUseQuery.mockReturnValue({
    data: formData(PERSISTED),
    isLoading: false,
  });
  testMocks.formFetch.mockResolvedValue(formData(PERSISTED));
  testMocks.upsertForm.mockResolvedValue({ formId: FORM_ID });
  testMocks.upsertQuestion.mockResolvedValue({});
  testMocks.deleteQuestion.mockResolvedValue({});
});

function renderBuilder(templateOwner: TemplateOwnerRef = EVENT_OWNER) {
  return render(
    <ApplicationFormBuilder
      eventId={EVENT_ID}
      open
      onClose={vi.fn()}
      templateOwner={templateOwner}
    />,
  );
}

/** Trash the first persisted question — queues a pendingDelete. */
function removeFirstQuestion() {
  const removeButtons = screen.getAllByRole("button", {
    name: /admin\.afRemoveQuestion/,
  });
  fireEvent.click(removeButtons[0]!);
}

describe("ApplicationFormBuilder — dirty guard on Start-from-a-template", () => {
  it("opens the picker straight away when nothing is unsaved", () => {
    renderBuilder();

    fireEvent.click(screen.getByTestId("application-template-start-btn"));

    expect(screen.getByTestId("picker-open")).toBeInTheDocument();
    expect(screen.queryByTestId("discard-confirm")).not.toBeInTheDocument();
  });

  it("CONFIRMS instead of opening the picker when a delete is queued", () => {
    renderBuilder();
    removeFirstQuestion();

    fireEvent.click(screen.getByTestId("application-template-start-btn"));

    expect(screen.getByTestId("discard-confirm")).toBeInTheDocument();
    // The picker must NOT be open — this is the whole point.
    expect(screen.queryByTestId("picker-open")).not.toBeInTheDocument();
  });

  it("CONFIRMS when a new question has been added", () => {
    renderBuilder();

    fireEvent.click(screen.getByTestId("app-add-question-btn"));
    fireEvent.click(screen.getByTestId("app-question-type-short_text"));
    // The new card opens expanded; give it a label so it counts as real work.
    const labelInputs = screen.getAllByPlaceholderText(
      "admin.afLabelPlaceholder",
    );
    fireEvent.change(labelInputs[labelInputs.length - 1]!, {
      target: { value: "Links" },
    });

    fireEvent.click(screen.getByTestId("application-template-start-btn"));

    expect(screen.getByTestId("discard-confirm")).toBeInTheDocument();
    expect(screen.queryByTestId("picker-open")).not.toBeInTheDocument();
  });

  it("cancelling leaves the local work intact and the picker closed", () => {
    renderBuilder();
    removeFirstQuestion();

    fireEvent.click(screen.getByTestId("application-template-start-btn"));
    fireEvent.click(screen.getByTestId("discard-confirm-no"));

    expect(screen.queryByTestId("picker-open")).not.toBeInTheDocument();
    // Still only one card on screen — the removal was not reverted behind
    // their back either.
    expect(screen.getAllByTestId("app-question-card")).toHaveLength(1);
  });

  it("confirming re-reads from the server and THEN opens the picker", async () => {
    renderBuilder();
    removeFirstQuestion();

    fireEvent.click(screen.getByTestId("application-template-start-btn"));
    fireEvent.click(screen.getByTestId("discard-confirm-yes"));

    await waitFor(() =>
      expect(screen.getByTestId("picker-open")).toBeInTheDocument(),
    );
    expect(testMocks.formFetch).toHaveBeenCalledWith({ eventId: EVENT_ID });
    // Re-hydrated: both persisted questions are back, so the apply lands on
    // exactly what is stored.
    expect(screen.getAllByTestId("app-question-card")).toHaveLength(2);
  });

  it("a blank draft card is NOT unsaved work (the save handler skips it)", () => {
    renderBuilder();

    fireEvent.click(screen.getByTestId("app-add-question-btn"));
    fireEvent.click(screen.getByTestId("app-question-type-long_text"));

    fireEvent.click(screen.getByTestId("application-template-start-btn"));

    expect(screen.getByTestId("picker-open")).toBeInTheDocument();
    expect(screen.queryByTestId("discard-confirm")).not.toBeInTheDocument();
  });
});

describe("ApplicationFormBuilder — templates follow the EVENT's owner", () => {
  const PRINCIPAL: TemplateOwnerRef = {
    ownerScope: "HUMAN",
    ownerId: "33333333-3333-4333-8333-333333333333",
  };
  it.each([
    ["a principal human", PRINCIPAL],
    ["an org", EVENT_OWNER],
  ])(
    "a delegate on an event owned by %s lists and saves in THAT library",
    (_label, eventOwner) => {
      renderBuilder(eventOwner);

      fireEvent.click(screen.getByTestId("application-template-start-btn"));
      expect(screen.getByTestId("picker-open")).toBeInTheDocument();
      expect(dialogOwners.picker).toEqual(eventOwner);

      fireEvent.click(screen.getByTestId("application-template-save-btn"));
      expect(screen.getByTestId("save-tpl-open")).toBeInTheDocument();
      expect(dialogOwners.save).toEqual(eventOwner);
    },
  );
});

describe("ApplicationFormBuilder — options pre-check", () => {
  it("blocks the save BEFORE any write when a choice question has no options", async () => {
    renderBuilder();

    fireEvent.click(screen.getByTestId("app-add-question-btn"));
    fireEvent.click(screen.getByTestId("app-question-type-single_choice"));
    const labelInputs = screen.getAllByPlaceholderText(
      "admin.afLabelPlaceholder",
    );
    fireEvent.change(labelInputs[labelInputs.length - 1]!, {
      target: { value: "Set length" },
    });

    fireEvent.click(screen.getByTestId("app-form-save-btn"));

    await waitFor(() =>
      expect(
        screen.getByTestId("application-form-save-error"),
      ).toHaveTextContent("admin.afOptionsRequiredError"),
    );
    // NOTHING was written — the partial-save trap is the reason this check
    // runs before the first mutation, not inside the loop.
    expect(testMocks.upsertQuestion).not.toHaveBeenCalled();
    expect(testMocks.deleteQuestion).not.toHaveBeenCalled();
    expect(testMocks.upsertForm).not.toHaveBeenCalled();
  });

  it("saves normally when every choice question has an option", async () => {
    renderBuilder();

    fireEvent.click(screen.getByTestId("app-add-question-btn"));
    fireEvent.click(screen.getByTestId("app-question-type-single_choice"));
    const labelInputs = screen.getAllByPlaceholderText(
      "admin.afLabelPlaceholder",
    );
    fireEvent.change(labelInputs[labelInputs.length - 1]!, {
      target: { value: "Set length" },
    });
    const optionInputs = screen.getAllByPlaceholderText(
      /admin\.afOptionPlaceholder/,
    );
    fireEvent.change(optionInputs[optionInputs.length - 1]!, {
      target: { value: "30 min" },
    });

    fireEvent.click(screen.getByTestId("app-form-save-btn"));

    await waitFor(() =>
      expect(testMocks.upsertQuestion).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByTestId("application-form-save-error"),
    ).not.toBeInTheDocument();
    // Only the NEW question is posted — unchanged persisted rows are not
    // re-sent (the signature check).
    expect(testMocks.upsertQuestion.mock.calls[0]![0]).toMatchObject({
      label: "Set length",
      options: [{ value: "30 min" }],
      order: 2,
    });
  });
});
