import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAskQuery = vi.fn();
const mockWaiverQuery = vi.fn();
const mockSubmitMutateAsync = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);
const mockWaiverRefetch = vi.fn().mockResolvedValue(undefined);
let mockGates: { sms?: boolean } | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates, isLoading: false }),
}));

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
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
    testIdBase,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    testIdBase?: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      data-testid={testIdBase}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({ dateTime: (d: Date) => d.toISOString() }),
  useNotify: () => ({ toast: { danger: vi.fn(), success: vi.fn() } }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      publicAsks: {
        get: { useQuery: () => mockAskQuery() },
        waiver: { useQuery: () => mockWaiverQuery() },
      },
      signups: {
        submit: {
          useMutation: () => ({
            mutateAsync: mockSubmitMutateAsync,
            isPending: false,
          }),
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
  },
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: () => null,
}));

vi.mock("@/components/volunteering/AddToCalendarButton", () => ({
  AddToCalendarButton: () => <div data-testid="add-to-calendar" />,
}));

import { PublicAskView } from "../PublicAskView";

const openAsk = {
  ask: {
    id: "ask-1",
    title: "Door crew",
    description: "Help us run the door",
    status: "OPEN",
    cadence: "ONGOING",
    startsAt: null,
    endsAt: null,
    capacity: null,
    waiverRequired: false,
    smsOptInEnabled: false,
    textRemindersOffered: false,
    formSchema: {},
  },
  roles: [
    {
      id: "role-1",
      name: "Door",
      description: "Check people in",
      capacity: 5,
      defaultHours: 3,
      sortOrder: 0,
      acceptedCount: 1,
    },
    {
      id: "role-2",
      name: "Bar",
      description: null,
      capacity: null,
      defaultHours: null,
      sortOrder: 1,
      acceptedCount: 0,
    },
  ],
};

function askQueryResult(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: mockRefetch,
  };
}

type WaiverData = {
  waiverRequired: boolean;
  waiver: { id: string; name: string; body: string; version: number } | null;
  alreadyOnFile: boolean;
};

function waiverQueryResult(
  data: WaiverData | undefined,
  opts: { isLoading?: boolean; isError?: boolean } = {},
) {
  const isLoading = opts.isLoading ?? false;
  const isError = opts.isError ?? false;
  return {
    data,
    isLoading,
    isError,
    isSuccess: !isLoading && !isError,
    error: null,
    refetch: mockWaiverRefetch,
  };
}

const noWaiver: WaiverData = {
  waiverRequired: false,
  waiver: null,
  alreadyOnFile: false,
};

const armedWaiver: WaiverData = {
  waiverRequired: true,
  waiver: {
    id: "wt-1",
    name: "Standard Volunteer Waiver",
    body: "You agree to volunteer at your own risk.",
    version: 1,
  },
  alreadyOnFile: false,
};

describe("PublicAskView", () => {
  beforeEach(() => {
    mockGates = { sms: true };
    mockAskQuery.mockReset();
    mockSubmitMutateAsync.mockReset();
    mockRefetch.mockClear();
    mockWaiverQuery.mockReset();
    mockWaiverRefetch.mockClear();
    // Default: no waiver gate. Individual tests override.
    mockWaiverQuery.mockReturnValue(waiverQueryResult(noWaiver));
  });

  it("renders the ask with its roles and occupancy", () => {
    mockAskQuery.mockReturnValue(askQueryResult(openAsk));
    render(<PublicAskView askId="ask-1" />);

    expect(screen.getByText("Door crew")).toBeInTheDocument();
    expect(screen.getByText("Door")).toBeInTheDocument();
    expect(screen.getByText("Bar")).toBeInTheDocument();
    expect(screen.getByText("1 / 5")).toBeInTheDocument();
    expect(
      screen.getByText("volunteering.publicSpotsOpen"),
    ).toBeInTheDocument();
  });

  it("renders the friendly closed state for a CLOSED ask", () => {
    mockAskQuery.mockReturnValue(
      askQueryResult({
        ...openAsk,
        ask: { ...openAsk.ask, status: "CLOSED" },
      }),
    );
    render(<PublicAskView askId="ask-1" />);

    expect(screen.getByTestId("public-ask-closed")).toBeInTheDocument();
    expect(
      screen.getByText("volunteering.publicClosedTitle"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("public-ask-submit")).not.toBeInTheDocument();
  });

  it("renders the not-found state when the query errors", () => {
    mockAskQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { data: { code: "NOT_FOUND" } },
      refetch: mockRefetch,
    });
    render(<PublicAskView askId="ask-1" />);
    expect(screen.getByTestId("public-ask-not-found")).toBeInTheDocument();
  });

  it("requires an email before submitting", async () => {
    mockAskQuery.mockReturnValue(askQueryResult(openAsk));
    render(<PublicAskView askId="ask-1" />);

    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    fireEvent.click(screen.getByTestId("public-ask-submit"));

    await waitFor(() => {
      expect(
        screen.getByText("volunteering.publicErrEmailRequired"),
      ).toBeInTheDocument();
    });
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
  });

  it("submits one signup per selected role with the ask id and contact email", async () => {
    mockAskQuery.mockReturnValue(askQueryResult(openAsk));
    mockSubmitMutateAsync.mockResolvedValue({ id: "s1", status: "PENDING" });
    render(<PublicAskView askId="ask-1" />);

    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    fireEvent.change(screen.getByTestId("public-ask-email"), {
      target: { value: "vol@example.org" },
    });
    fireEvent.change(screen.getByTestId("public-ask-name"), {
      target: { value: "Vol Unteer" },
    });
    fireEvent.click(screen.getByTestId("public-ask-submit"));

    await waitFor(() => {
      expect(mockSubmitMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockSubmitMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: "ask-1",
        roleId: "role-1",
        contactEmail: "vol@example.org",
        contactName: "Vol Unteer",
        smsOptIn: false,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("public-ask-success")).toBeInTheDocument();
    });
    expect(
      screen.getByText("volunteering.publicResultPending"),
    ).toBeInTheDocument();
  });

  it("renders the waiver body and gates submission on the checkbox when armed", () => {
    mockAskQuery.mockReturnValue(
      askQueryResult({
        ...openAsk,
        ask: { ...openAsk.ask, waiverRequired: true },
      }),
    );
    mockWaiverQuery.mockReturnValue(waiverQueryResult(armedWaiver));
    render(<PublicAskView askId="ask-1" />);

    expect(screen.getByTestId("public-ask-waiver-body")).toHaveTextContent(
      "You agree to volunteer at your own risk.",
    );
    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    expect(screen.getByTestId("public-ask-submit")).toBeDisabled();

    fireEvent.click(screen.getByTestId("public-ask-waiver"));
    expect(screen.getByTestId("public-ask-submit")).not.toBeDisabled();
  });

  it("renders no waiver checkbox when the flag is set but no template resolves", () => {
    mockAskQuery.mockReturnValue(
      askQueryResult({
        ...openAsk,
        ask: { ...openAsk.ask, waiverRequired: true },
      }),
    );
    // Effective gate is false (flag on, no template) — removes the theater.
    mockWaiverQuery.mockReturnValue(waiverQueryResult(noWaiver));
    render(<PublicAskView askId="ask-1" />);

    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    expect(screen.queryByTestId("public-ask-waiver")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("public-ask-waiver-body"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("public-ask-submit")).not.toBeDisabled();
  });

  it("shows the on-file state and does not block submit for a returning volunteer", () => {
    mockAskQuery.mockReturnValue(
      askQueryResult({
        ...openAsk,
        ask: { ...openAsk.ask, waiverRequired: true },
      }),
    );
    mockWaiverQuery.mockReturnValue(
      waiverQueryResult({ ...armedWaiver, alreadyOnFile: true }),
    );
    render(<PublicAskView askId="ask-1" />);

    expect(screen.getByTestId("public-ask-waiver-on-file")).toBeInTheDocument();
    expect(screen.queryByTestId("public-ask-waiver")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    expect(screen.getByTestId("public-ask-submit")).not.toBeDisabled();
  });

  it("blocks submit while the waiver read is still loading", () => {
    mockAskQuery.mockReturnValue(
      askQueryResult({
        ...openAsk,
        ask: { ...openAsk.ask, waiverRequired: true },
      }),
    );
    mockWaiverQuery.mockReturnValue(
      waiverQueryResult(undefined, { isLoading: true }),
    );
    render(<PublicAskView askId="ask-1" />);

    expect(
      screen.getByTestId("public-ask-waiver-loading"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    expect(screen.getByTestId("public-ask-submit")).toBeDisabled();
  });
});

describe("PublicAskView SMS reminder opt-in", () => {
  // A one-time ask with a start: the server says it reminds. The organiser's
  // old switch is off on purpose; it gates nothing (R5).
  const remindedAsk = {
    ...openAsk,
    ask: {
      ...openAsk.ask,
      cadence: "ONE_TIME",
      startsAt: "2099-01-01T20:00:00.000Z",
      smsOptInEnabled: false,
      textRemindersOffered: true,
    },
  };
  // ONGOING: its start is when it opens, so no reminder and no offer, even
  // with the old switch on.
  const ongoingAsk = {
    ...openAsk,
    ask: {
      ...openAsk.ask,
      smsOptInEnabled: true,
      textRemindersOffered: false,
    },
  };

  function fillForm({ phone = "+15005550006" } = {}) {
    fireEvent.click(screen.getByTestId("public-ask-role-role-1"));
    fireEvent.change(screen.getByTestId("public-ask-email"), {
      target: { value: "vol@example.org" },
    });
    fireEvent.change(screen.getByTestId("public-ask-phone"), {
      target: { value: phone },
    });
  }

  async function expectSubmitted(fields: Record<string, unknown>) {
    fireEvent.click(screen.getByTestId("public-ask-submit"));
    await waitFor(() => {
      expect(mockSubmitMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining(fields),
      );
    });
  }

  beforeEach(() => {
    mockGates = { sms: true };
    mockSubmitMutateAsync.mockReset();
    mockSubmitMutateAsync.mockResolvedValue({ id: "s1", status: "PENDING" });
    mockAskQuery.mockReturnValue(askQueryResult(remindedAsk));
    mockWaiverQuery.mockReturnValue(waiverQueryResult(noWaiver));
  });

  it("offers the opt-in on a reminded ask and sends the tick", async () => {
    render(<PublicAskView askId="ask-1" />);
    fillForm();

    expect(screen.getByText("volunteering.publicSmsOptIn")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("public-ask-sms-opt-in"));
    await expectSubmitted({ smsOptIn: true, contactPhone: "+15005550006" });
  });

  it("an unticked opt-in sends smsOptIn: false", async () => {
    render(<PublicAskView askId="ask-1" />);
    fillForm();

    expect(screen.getByTestId("public-ask-sms-opt-in")).not.toBeChecked();
    await expectSubmitted({ smsOptIn: false, contactPhone: "+15005550006" });
  });

  it("hides the opt-in with no phone, and a tick hidden by clearing it never travels", async () => {
    render(<PublicAskView askId="ask-1" />);
    fillForm();
    fireEvent.click(screen.getByTestId("public-ask-sms-opt-in"));

    fireEvent.change(screen.getByTestId("public-ask-phone"), {
      target: { value: "   " },
    });
    expect(
      screen.queryByTestId("public-ask-sms-opt-in"),
    ).not.toBeInTheDocument();
    await expectSubmitted({ smsOptIn: false });
  });

  it("clearing the phone clears the tick: retyping shows the box unticked", () => {
    render(<PublicAskView askId="ask-1" />);
    fillForm();
    fireEvent.click(screen.getByTestId("public-ask-sms-opt-in"));
    expect(screen.getByTestId("public-ask-sms-opt-in")).toBeChecked();

    fireEvent.change(screen.getByTestId("public-ask-phone"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("public-ask-phone"), {
      target: { value: "+15005550006" },
    });
    expect(screen.getByTestId("public-ask-sms-opt-in")).not.toBeChecked();
  });

  it("hides the opt-in on an ask that does not remind (ONGOING), whatever the old switch says", async () => {
    mockAskQuery.mockReturnValue(askQueryResult(ongoingAsk));
    render(<PublicAskView askId="ask-1" />);
    fillForm();

    expect(
      screen.queryByTestId("public-ask-sms-opt-in"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("volunteering.publicSmsOptIn"),
    ).not.toBeInTheDocument();
    await expectSubmitted({ smsOptIn: false, contactPhone: "+15005550006" });
  });

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`hides the opt-in and sends smsOptIn: false (${label})`, async () => {
      mockGates = gates;
      render(<PublicAskView askId="ask-1" />);
      fillForm();

      expect(
        screen.queryByTestId("public-ask-sms-opt-in"),
      ).not.toBeInTheDocument();
      await expectSubmitted({ smsOptIn: false, contactPhone: "+15005550006" });
    });
  }

  it("a non-US number refused for SMS says we only text US numbers", async () => {
    mockSubmitMutateAsync.mockRejectedValue({
      message: "sms_requires_us_phone",
      data: { code: "BAD_REQUEST", appCode: "INVALID_INPUT" },
    });
    render(<PublicAskView askId="ask-1" />);
    fillForm({ phone: "+447700900123" });

    fireEvent.click(screen.getByTestId("public-ask-sms-opt-in"));
    fireEvent.click(screen.getByTestId("public-ask-submit"));

    await waitFor(() => {
      expect(
        screen.getByText("volunteering.publicErrSmsUsOnly"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("volunteering.publicErrGeneric"),
    ).not.toBeInTheDocument();
  });
});
