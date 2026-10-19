import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The platform standard volunteer waiver is resolved from the template list
// by discriminator (kind VOLUNTEER + isDefault), not by a hardcoded id.
const PLATFORM_ID = "platform-standard-id";

const mockTemplatesQuery = vi.fn();
const mockAssignMutateAsync = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastDanger = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return { YStack: passthrough, XStack: passthrough, styled: () => passthrough };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onPress?.()}
    >
      {children}
    </button>
  ),
  StyledSelect: ({
    value,
    options,
    onChange,
    disabled,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
    testId?: string;
  }) => (
    <select
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: mockToastSuccess, danger: mockToastDanger },
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    waivers: {
      listTemplates: { useQuery: () => mockTemplatesQuery() },
    },
    volunteer: {
      asks: {
        assignWaiver: {
          useMutation: () => ({
            mutateAsync: mockAssignMutateAsync,
            isPending: false,
          }),
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { AskWaiverSection } from "../AskWaiverSection";

const templates = [
  {
    id: PLATFORM_ID,
    name: "Standard Volunteer Waiver",
    body: "std",
    isDefault: true,
    kind: "VOLUNTEER" as const,
  },
  {
    id: "attendee-default-id",
    name: "General Event Waiver",
    body: "general",
    isDefault: true,
    kind: "ATTENDEE" as const,
  },
  {
    id: "tpl-1",
    name: "Org Custom",
    body: "custom body",
    isDefault: false,
    kind: "ATTENDEE" as const,
  },
];

function templatesResult(data: unknown, opts: { isError?: boolean } = {}) {
  return {
    data,
    isLoading: false,
    isError: opts.isError ?? false,
    error: null,
  };
}

function baseProps() {
  return {
    askId: "ask-1",
    subjectType: "ORG" as const,
    orgId: "org-1",
    humanId: null,
    initialWaiverTemplateId: null,
    waiverRequired: false,
    onAssigned: vi.fn(),
  };
}

describe("AskWaiverSection", () => {
  beforeEach(() => {
    mockTemplatesQuery.mockReset();
    mockAssignMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastDanger.mockReset();
    mockTemplatesQuery.mockReturnValue(templatesResult({ templates }));
    mockAssignMutateAsync.mockResolvedValue({ ask: { id: "ask-1" } });
  });

  it("resolves the standard waiver by discriminator, not the attendee default", async () => {
    // Both the volunteer standard AND the attendee "General Event Waiver"
    // carry isDefault — the one-click must pick kind=VOLUNTEER (the exact
    // double-isDefault footgun the kind column exists to fix).
    render(<AskWaiverSection {...baseProps()} />);

    fireEvent.click(screen.getByTestId("ask-waiver-use-standard"));

    await waitFor(() =>
      expect(mockAssignMutateAsync).toHaveBeenCalledWith({
        askId: "ask-1",
        waiverTemplateId: PLATFORM_ID,
      }),
    );
  });

  it("disables the one-click button when no volunteer default is in the list", () => {
    mockTemplatesQuery.mockReturnValue(
      templatesResult({
        templates: templates.filter((tpl) => tpl.kind !== "VOLUNTEER"),
      }),
    );
    render(<AskWaiverSection {...baseProps()} />);

    expect(screen.getByTestId("ask-waiver-use-standard")).toBeDisabled();
    fireEvent.click(screen.getByTestId("ask-waiver-use-standard"));
    expect(mockAssignMutateAsync).not.toHaveBeenCalled();
  });

  it("renders nothing for an EVENT-subject ask", () => {
    render(<AskWaiverSection {...baseProps()} subjectType="EVENT" />);
    expect(screen.queryByTestId("ask-waiver-section")).not.toBeInTheDocument();
  });

  it("assigns the platform standard waiver via the one-click button", async () => {
    const onAssigned = vi.fn();
    render(<AskWaiverSection {...baseProps()} onAssigned={onAssigned} />);

    fireEvent.click(screen.getByTestId("ask-waiver-use-standard"));

    await waitFor(() =>
      expect(mockAssignMutateAsync).toHaveBeenCalledWith({
        askId: "ask-1",
        waiverTemplateId: PLATFORM_ID,
      }),
    );
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
  });

  it("shows the standard-in-use state when the platform template is selected", () => {
    render(
      <AskWaiverSection {...baseProps()} initialWaiverTemplateId={PLATFORM_ID} />,
    );
    expect(
      screen.getByTestId("ask-waiver-standard-active"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("ask-waiver-use-standard"),
    ).not.toBeInTheDocument();
  });

  it("assigns a chosen template through the select", async () => {
    render(<AskWaiverSection {...baseProps()} />);

    fireEvent.change(screen.getByTestId("ask-waiver-select"), {
      target: { value: "tpl-1" },
    });

    await waitFor(() =>
      expect(mockAssignMutateAsync).toHaveBeenCalledWith({
        askId: "ask-1",
        waiverTemplateId: "tpl-1",
      }),
    );
  });

  it("clears the waiver when 'No waiver' is picked", async () => {
    render(
      <AskWaiverSection {...baseProps()} initialWaiverTemplateId="tpl-1" />,
    );

    fireEvent.change(screen.getByTestId("ask-waiver-select"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(mockAssignMutateAsync).toHaveBeenCalledWith({
        askId: "ask-1",
        waiverTemplateId: null,
      }),
    );
  });

  it("warns when the ask requires a waiver but none is assigned", () => {
    render(<AskWaiverSection {...baseProps()} waiverRequired />);
    expect(
      screen.getByTestId("ask-waiver-missing-warning"),
    ).toBeInTheDocument();
  });

  it("notes when a template is attached but the requirement is off", () => {
    render(
      <AskWaiverSection
        {...baseProps()}
        waiverRequired={false}
        initialWaiverTemplateId="tpl-1"
      />,
    );
    expect(
      screen.getByTestId("ask-waiver-not-required-note"),
    ).toBeInTheDocument();
  });

  it("toasts and rolls back when the assign fails", async () => {
    mockAssignMutateAsync.mockRejectedValue(new Error("nope"));
    render(<AskWaiverSection {...baseProps()} />);

    fireEvent.click(screen.getByTestId("ask-waiver-use-standard"));

    await waitFor(() => expect(mockToastDanger).toHaveBeenCalled());
    // Rolled back to "no template selected" — the one-click CTA is back.
    expect(screen.getByTestId("ask-waiver-use-standard")).toBeInTheDocument();
  });
});
