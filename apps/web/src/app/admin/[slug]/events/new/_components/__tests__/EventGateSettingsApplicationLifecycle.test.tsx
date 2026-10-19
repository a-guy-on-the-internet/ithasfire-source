/**
 * EventGateSettings — the APPLICATION gate's lifecycle controls (spec Phase
 * 2): application window (opensAt/closesAt), submission cap, auto-approve.
 *
 * The pins:
 *   • the whole block renders ONLY under the APPLICATION gate;
 *   • stored values hydrate the inputs;
 *   • the cap is `inputMode=numeric` with a digit sanitizer — NEVER
 *     `type=number` (the RNW caret-reversal trap);
 *   • a closesAt at/before opensAt blocks save client-side (the server's
 *     superRefine is the real gate; this just avoids a doomed round trip);
 *   • save sends ONLY the lifecycle slice — no `defaults`/`introText`, so
 *     the question builder's slice of the same row is never clobbered.
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
  const Modal = Object.assign(ModalRoot, {
    Panel: Passthrough,
    Header: () => null,
    Body: Passthrough,
    Footer: Passthrough,
  });
  return {
    Text,
    Modal,
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
    // Mirrors the real TextInput's controlled contract, and passes
    // inputMode through so the numeric-keyboard pin is assertable.
    TextInput: ({
      testId,
      value,
      onChangeText,
      inputMode,
      maxLength,
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      inputMode?: string;
      maxLength?: number;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        value: value ?? "",
        inputMode,
        maxLength,
        onChange: (e: { currentTarget: { value: string } }) =>
          onChangeText?.(e.currentTarget.value),
      }),
    Switch: ({
      checked,
      onCheckedChange,
      label,
    }: {
      checked?: boolean;
      onCheckedChange?: (next: boolean) => void;
      label?: string;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          "data-testid": "application-auto-approve",
          onClick: () => onCheckedChange?.(!checked),
        },
        label,
      ),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// The URL workspace is a DELEGATE's own. The template owner comes from the
// `templateOwner` prop (the EVENT's owner), never this hook — if the gate ever
// consults it again, the owner test below fails.
vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: {
      kind: "human",
      humanId: "99999999-9999-4999-8999-999999999999",
    },
    isLoading: false,
  }),
}));

// The picker is its own dialog with its own queries; it is exercised by
// ApplicationTemplateDialogs.test.tsx (which pins that `owner` reaches the
// list query), not here. This stub records the `owner` it was handed.
const pickerOwner = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../ApplicationTemplatePickerDialog", () => ({
  ApplicationTemplatePickerDialog: ({ owner }: { owner: unknown }) => {
    pickerOwner.current = owner;
    return null;
  },
}));

// The invite panel has its own queries and its own tests
// (EventInviteSettings.test.tsx); it is out of scope here.
vi.mock("../EventInviteSettings", () => ({
  EventInviteSettings: () => null,
}));

// `NativeDateTimeInput` is a Tamagui `styled("input")`; the tamagui mock
// above collapses styled() to a div, which has no value setter. Render a
// real <input type="datetime-local"> so the window fields are drivable —
// this is the SAME native element the component renders in the browser.
vi.mock("../_form-bits", () => ({
  NativeDateTimeInput: (props: Record<string, unknown>) => (
    <input
      type={props.type as string}
      value={props.value as string}
      min={props.min as string | undefined}
      aria-label={props["aria-label"] as string | undefined}
      aria-invalid={props["aria-invalid"] as boolean | undefined}
      aria-describedby={props["aria-describedby"] as string | undefined}
      data-testid={props["data-testid"] as string | undefined}
      onChange={props.onChange as (e: unknown) => void}
    />
  ),
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { waitlists: false }, isLoading: false }),
}));

const testMocks = vi.hoisted(() => ({
  formUseQuery: vi.fn(),
  upsertFormMutateAsync: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getApplicationForm: { invalidate: testMocks.invalidate } },
    }),
    events: {
      updateAccessControls: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      getApplicationForm: { useQuery: testMocks.formUseQuery },
      upsertApplicationForm: {
        useMutation: () => ({ mutateAsync: testMocks.upsertFormMutateAsync }),
      },
    },
  },
}));

import { EventGateSettings } from "../EventGateSettings";
import type { TemplateOwnerRef } from "../TicketTypeTemplateControls";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function formResult(
  overrides: {
    opensAt?: Date | null;
    closesAt?: Date | null;
    maxSubmissions?: number | null;
    autoApprove?: boolean;
  } | null = {},
) {
  return {
    data: overrides
      ? {
          form: {
            id: "form-1",
            eventId: EVENT_ID,
            introText: null,
            defaults: {
              includeName: true,
              includeReason: true,
              includeSocialLinks: false,
            },
            opensAt: overrides.opensAt ?? null,
            closesAt: overrides.closesAt ?? null,
            maxSubmissions: overrides.maxSubmissions ?? null,
            autoApprove: overrides.autoApprove ?? false,
            updatedAt: new Date(),
          },
          questions: [],
        }
      : { form: null, questions: [] },
    isLoading: false,
  };
}

const EVENT_OWNER: TemplateOwnerRef = {
  ownerScope: "ORGANIZATION",
  ownerId: "22222222-2222-4222-8222-222222222222",
};

const renderSettings = (
  gateType: "NONE" | "APPLICATION" = "APPLICATION",
  templateOwner: TemplateOwnerRef = EVENT_OWNER,
) =>
  render(
    <EventGateSettings
      eventId={EVENT_ID}
      slug="dev-qa-collective"
      templateOwner={templateOwner}
      initialGateType={gateType}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  pickerOwner.current = undefined;
  testMocks.formUseQuery.mockReturnValue(formResult());
  testMocks.upsertFormMutateAsync.mockResolvedValue({});
});

describe("EventGateSettings — application lifecycle block", () => {
  it("renders only under the APPLICATION gate", () => {
    const { unmount } = renderSettings("NONE");
    expect(
      screen.queryByTestId("application-lifecycle-settings"),
    ).not.toBeInTheDocument();
    unmount();

    renderSettings("APPLICATION");
    expect(
      screen.getByTestId("application-lifecycle-settings"),
    ).toBeInTheDocument();
  });

  it("uses inputMode=numeric for the cap, NEVER type=number (RNW caret-reversal trap)", () => {
    renderSettings();

    const cap = screen.getByTestId("application-max-submissions");
    expect(cap).toHaveAttribute("inputmode", "numeric");
    expect(cap).not.toHaveAttribute("type", "number");
  });

  it("sanitizes non-digits and leading zeros out of the cap", () => {
    renderSettings();

    const cap = screen.getByTestId("application-max-submissions");
    fireEvent.change(cap, { target: { value: "1e2x5" } });
    expect(cap).toHaveValue("125");

    // A leading zero would otherwise persist into a sub-1 cap the server
    // rejects (maxSubmissions >= 1).
    fireEvent.change(cap, { target: { value: "0" } });
    expect(cap).toHaveValue("");
  });

  it("hydrates the controls from the stored form", () => {
    testMocks.formUseQuery.mockReturnValue(
      formResult({ maxSubmissions: 40, autoApprove: true }),
    );
    renderSettings();

    expect(screen.getByTestId("application-max-submissions")).toHaveValue("40");
    expect(screen.getByTestId("application-auto-approve")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("flags an out-of-range stored cap instead of silently coercing it", () => {
    // The typing sanitizer can't produce 0, but a legacy/out-of-band row
    // can — and the old code silently saved 0 as UNCAPPED, i.e. the exact
    // opposite of "accept nobody".
    testMocks.formUseQuery.mockReturnValue(formResult({ maxSubmissions: 0 }));
    renderSettings();

    expect(screen.getByTestId("application-max-submissions")).toHaveValue("0");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.gsAppMaxSubmissionsError",
    );
    expect(
      screen.getByTestId("application-settings-save-btn"),
    ).toBeDisabled();

    fireEvent.click(screen.getByTestId("application-settings-save-btn"));
    expect(testMocks.upsertFormMutateAsync).not.toHaveBeenCalled();
  });

  it("clears the cap error once the value is valid or blank", () => {
    testMocks.formUseQuery.mockReturnValue(formResult({ maxSubmissions: 0 }));
    renderSettings();

    expect(screen.queryByRole("alert")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("application-max-submissions"), {
      target: { value: "5" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("application-settings-save-btn"),
    ).not.toBeDisabled();
  });

  it("blocks save and shows an error when closesAt is at or before opensAt", () => {
    renderSettings();

    fireEvent.change(screen.getByTestId("application-opens-at"), {
      target: { value: "2026-09-05T10:00" },
    });
    fireEvent.change(screen.getByTestId("application-closes-at"), {
      target: { value: "2026-09-01T10:00" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.gsAppWindowError",
    );
    expect(
      screen.getByTestId("application-settings-save-btn"),
    ).toBeDisabled();

    fireEvent.click(screen.getByTestId("application-settings-save-btn"));
    expect(testMocks.upsertFormMutateAsync).not.toHaveBeenCalled();
  });

  it("saves ONLY the lifecycle slice — no defaults/introText to clobber the question builder", async () => {
    renderSettings();

    fireEvent.change(screen.getByTestId("application-max-submissions"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("application-auto-approve"));
    fireEvent.click(screen.getByTestId("application-settings-save-btn"));

    await waitFor(() =>
      expect(testMocks.upsertFormMutateAsync).toHaveBeenCalledTimes(1),
    );
    const payload = testMocks.upsertFormMutateAsync.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toStrictEqual({
      eventId: EVENT_ID,
      opensAt: null,
      closesAt: null,
      maxSubmissions: 25,
      autoApprove: true,
    });
    // Absent keys are what make the upsert non-destructive.
    expect(Object.keys(payload)).not.toContain("defaults");
    expect(Object.keys(payload)).not.toContain("introText");
  });

  /**
   * Spec Phase 4: choosing the APPLICATION gate offers "Start from a template"
   * ALONGSIDE the blank-form CTA. Both live in the same cluster, so this also
   * pins that the blank path did not get replaced by the template path.
   */
  it("offers Start-from-a-template BESIDE the blank form CTA under the APPLICATION gate", () => {
    renderSettings("APPLICATION");

    expect(
      screen.getByTestId("gate-start-from-template-btn"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("gate-edit-application-form-btn"),
    ).toBeInTheDocument();
  });

  it.each<[string, TemplateOwnerRef]>([
    [
      "a principal human",
      {
        ownerScope: "HUMAN",
        ownerId: "33333333-3333-4333-8333-333333333333",
      },
    ],
    ["an org", EVENT_OWNER],
  ])(
    "a delegate on an event owned by %s picks from THAT library, not the URL workspace's",
    (_label, eventOwner) => {
      renderSettings("APPLICATION", eventOwner);

      fireEvent.click(screen.getByTestId("gate-start-from-template-btn"));

      expect(pickerOwner.current).toEqual(eventOwner);
    },
  );

  it("does not offer the template CTA outside the APPLICATION gate", () => {
    renderSettings("NONE");

    expect(
      screen.queryByTestId("gate-start-from-template-btn"),
    ).not.toBeInTheDocument();
  });

  it("sends real Dates for a filled window and nulls for a cleared one", async () => {
    testMocks.formUseQuery.mockReturnValue(
      formResult({
        opensAt: new Date("2026-09-01T10:00:00Z"),
        closesAt: new Date("2026-09-08T10:00:00Z"),
        maxSubmissions: 10,
      }),
    );
    renderSettings();

    // Clear the cap; keep the (hydrated, valid) window.
    fireEvent.change(screen.getByTestId("application-max-submissions"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("application-settings-save-btn"));

    await waitFor(() =>
      expect(testMocks.upsertFormMutateAsync).toHaveBeenCalledTimes(1),
    );
    const payload = testMocks.upsertFormMutateAsync.mock.calls[0]![0] as {
      opensAt: Date | null;
      closesAt: Date | null;
      maxSubmissions: number | null;
    };
    expect(payload.opensAt).toBeInstanceOf(Date);
    expect(payload.closesAt).toBeInstanceOf(Date);
    // Explicit null = clear (vs. an absent key, which means "leave alone").
    expect(payload.maxSubmissions).toBeNull();
  });
});
