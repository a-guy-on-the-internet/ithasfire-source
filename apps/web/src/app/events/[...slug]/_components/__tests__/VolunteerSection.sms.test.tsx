import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/**
 * VolunteerSection — the per-signup "Text me shift reminders" toggle on an
 * existing signup, with and without SMS available.
 *
 * With SMS unavailable (no provider) the toggle is revoke-only: a signup that
 * already consented can switch it off (texts would resume on that consent
 * when SMS returns), it can never be switched on, and a signup that has not
 * consented sees no toggle at all.
 *
 * A signup is reminded before its shift, or, on a role with NO shifts,
 * before the event starts (volunteer-ask-reminders R7). A role-level signup
 * on a role that has shifts is never reminded, so it is offered the toggle
 * only to withdraw consent it already gave. The signup sheet's box shows
 * when a picked item is reminded, and its label names what it is reminded
 * of: a shiftless volunteer never reads "my shift".
 */

const pickDomProps = (rest: Record<string, unknown>) => {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
      domProps[key] = value;
    }
  }
  return domProps;
};

const mocks = vi.hoisted(() => ({
  gates: undefined as { sms?: boolean } | undefined,
  mine: [] as unknown[],
  mutate: vi.fn(),
  submit: vi.fn(),
  prefsOptions: undefined as
    | {
        onError?: (err: unknown) => void;
        onSuccess?: (
          data: { smsMayNeedStart: boolean },
          variables: { signupId: string; smsOptIn: boolean },
        ) => void;
      }
    | undefined,
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<
    string,
    unknown
  >) => (
    <div onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </div>
  );
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    Card: Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => {
  const Passthrough = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  const Button = ({
    children,
    onPress,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
  } & Record<string, unknown>) => (
    <button type="button" onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </button>
  );
  const BottomSheet = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-testid="volunteer-sheet">{children}</div> : null,
    {
      Panel: Passthrough,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
      Body: Passthrough,
      Footer: Passthrough,
    },
  );
  return {
    Badge: Passthrough,
    BottomSheet,
    Button,
    Checkbox: ({
      id,
      checked,
      disabled,
      onCheckedChange,
      testIdBase,
    }: {
      id?: string;
      checked?: boolean;
      disabled?: boolean;
      onCheckedChange?: (next: boolean) => void;
      testIdBase?: string;
    }) => (
      <input
        id={id}
        type="checkbox"
        data-testid={testIdBase}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
    ),
    Text: ({
      children,
      ...rest
    }: { children?: ReactNode } & Record<string, unknown>) => (
      <span {...pickDomProps(rest)}>{children}</span>
    ),
    TextInput: ({
      value,
      onChangeText,
      ...rest
    }: {
      value?: string;
      onChangeText?: (next: string) => void;
    } & Record<string, unknown>) => (
      <input
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.target.value)}
        {...pickDomProps(rest)}
      />
    ),
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({
      dateTime: () => "Sat, Jan 1, 2028",
      date: () => "Sat, Jan 1, 2028",
      time: () => "8:00 PM",
    }),
  };
});

const ROLE = {
  id: "role_1",
  name: "Door",
  description: null,
  capacity: null,
  sortOrder: 0,
  signupCount: 1,
  acceptedCount: 1,
  shifts: [],
};

const SHIFT_ROLE = {
  id: "role_2",
  name: "Bar",
  description: null,
  capacity: null,
  sortOrder: 1,
  signupCount: 0,
  acceptedCount: 0,
  shifts: [
    {
      id: "shift_1",
      label: null,
      startsAt: "2099-01-01T20:00:00.000Z",
      endsAt: "2099-01-01T23:00:00.000Z",
      capacity: null,
      sortOrder: 0,
      signupCount: 0,
      acceptedCount: 0,
    },
  ],
};

const inertQuery = { data: undefined, isLoading: false, isError: false };

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: { signups: { listMine: { invalidate: vi.fn() } } },
    }),
    volunteer: {
      publicRoles: {
        list: {
          useQuery: () => ({
            isLoading: false,
            isError: false,
            data: { roles: [ROLE, SHIFT_ROLE] },
            refetch: vi.fn(),
          }),
        },
        waiver: { useQuery: () => ({ ...inertQuery, refetch: vi.fn() }) },
      },
      signups: {
        listMine: {
          useQuery: () => ({
            data: mocks.mine,
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
          }),
        },
        submit: { useMutation: () => ({ mutateAsync: mocks.submit }) },
        withdraw: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        updateContactPrefs: {
          useMutation: (options: typeof mocks.prefsOptions) => {
            mocks.prefsOptions = options;
            return { mutate: mocks.mutate, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "u1", name: "Vol", email: "vol@example.org" } },
    }),
  },
}));

vi.mock("@/lib/app-error", () => ({ getAppErrorCode: () => undefined }));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mocks.gates, isLoading: false }),
}));

vi.mock("@/components/volunteering/AddToCalendarButton", () => ({
  AddToCalendarButton: () => null,
}));

import { VolunteerSection } from "../VolunteerSection";

const SIGNUP_ID = "signup_1";
const TOGGLE = `volunteer-sms-prefs-${SIGNUP_ID}`;

/**
 * `shift`: on a shift (reminded before it). `shiftlessRole`: on a role with
 * no shifts (reminded before the event starts).
 */
type SignupKind = "shift" | "shiftlessRole";

function signup(smsOptIn: boolean, kind: SignupKind = "shiftlessRole") {
  return {
    id: SIGNUP_ID,
    eventId: "evt_1",
    roleId: kind === "shift" ? SHIFT_ROLE.id : ROLE.id,
    shiftId: kind === "shift" ? SHIFT_ROLE.shifts[0]!.id : null,
    status: "APPROVED",
    smsOptIn,
    contactPhone: "+15005550006",
  };
}

function renderOpenSheet() {
  render(
    <VolunteerSection
      eventId="evt_1"
      eventStatus="PUBLISHED"
      eventEndsAt="2099-01-01T00:00:00.000Z"
    />,
  );
  fireEvent.click(screen.getByTestId("volunteer-open-sheet-btn"));
}

describe("VolunteerSection — existing signup SMS toggle", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
  });

  it("offers the toggle both ways on a shift signup when SMS is available", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shift")];
    renderOpenSheet();

    const toggle = screen.getByTestId(TOGGLE);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(mocks.mutate).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });
  });

  it("offers the toggle both ways on a role with no shifts, labelled for the event start", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shiftlessRole")];
    renderOpenSheet();

    expect(
      screen.getByText("eventDetail.volunteerSmsToggleLabelEventStart"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("eventDetail.volunteerSmsToggleLabel"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("eventDetail.volunteerSmsStopHint")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(TOGGLE));
    expect(mocks.mutate).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });
  });

  it("a shift signup's toggle keeps the shift label", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shift")];
    renderOpenSheet();

    expect(
      screen.getByText("eventDetail.volunteerSmsToggleLabel"),
    ).toBeInTheDocument();
  });

  // A role-level signup on a role that has shifts gets no status row in the
  // sheet at all (rows render per shift), so its "no reminder, revoke-only"
  // branch is covered by `eventPickReminderAnchor`'s helper tests.

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`hides the toggle for a signup that never opted in (${label})`, () => {
      mocks.gates = gates;
      mocks.mine = [signup(false)];
      renderOpenSheet();

      expect(screen.queryByTestId(TOGGLE)).not.toBeInTheDocument();
      expect(
        screen.queryByText("eventDetail.volunteerSmsToggleLabel"),
      ).not.toBeInTheDocument();
    });

    it(`keeps a revoke-only toggle for a signup that opted in (${label})`, () => {
      mocks.gates = gates;
      mocks.mine = [signup(true)];
      renderOpenSheet();

      const toggle = screen.getByTestId(TOGGLE);
      expect(toggle).toBeChecked();
      expect(
        screen.queryByText("eventDetail.volunteerSmsStopHint"),
      ).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(mocks.mutate).toHaveBeenCalledWith({
        signupId: SIGNUP_ID,
        smsOptIn: false,
      });
    });
  }

  it("a toggle refused for a non-US number says we only text US numbers", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shift")];
    renderOpenSheet();

    act(() => {
      mocks.prefsOptions?.onError?.({
        message: "sms_requires_us_phone",
        data: { code: "BAD_REQUEST" },
      });
    });

    expect(
      screen.getByText("eventDetail.volunteerSmsToggleUsOnly"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("eventDetail.volunteerSmsUpdateFailed"),
    ).not.toBeInTheDocument();
  });

  const START = "eventDetail.volunteerSmsMayNeedStart";
  const STOP = "eventDetail.volunteerSmsStopHint";

  it("switching reminders on with the START hint shows it instead of the STOP hint", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(true, "shift")];
    renderOpenSheet();
    expect(screen.getByText(STOP)).toBeInTheDocument();

    act(() => {
      mocks.prefsOptions?.onSuccess?.(
        { smsMayNeedStart: true },
        { signupId: SIGNUP_ID, smsOptIn: true },
      );
    });

    expect(screen.getByText(START)).toBeInTheDocument();
    expect(screen.queryByText(STOP)).not.toBeInTheDocument();
  });

  it("the captions sit in a polite live region", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(true, "shift")];
    renderOpenSheet();

    const region = screen.getByTestId(
      `volunteer-sms-prefs-captions-${SIGNUP_ID}`,
    );
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toContainElement(screen.getByText(STOP));
  });

  it("holds the START hint until the refetch shows reminders on", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shift")];
    renderOpenSheet();

    act(() => {
      mocks.prefsOptions?.onSuccess?.(
        { smsMayNeedStart: true },
        { signupId: SIGNUP_ID, smsOptIn: true },
      );
    });

    expect(screen.getByText(STOP)).toBeInTheDocument();
    expect(screen.queryByText(START)).not.toBeInTheDocument();
  });

  it("switching reminders on without the START hint keeps the STOP hint", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(true, "shift")];
    renderOpenSheet();

    act(() => {
      mocks.prefsOptions?.onSuccess?.(
        { smsMayNeedStart: false },
        { signupId: SIGNUP_ID, smsOptIn: true },
      );
    });

    expect(screen.queryByText(START)).not.toBeInTheDocument();
    expect(screen.getByText(STOP)).toBeInTheDocument();
  });

  it("switching reminders off, or an error, clears the START hint", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(true, "shift")];
    renderOpenSheet();
    const on = () =>
      act(() => {
        mocks.prefsOptions?.onSuccess?.(
          { smsMayNeedStart: true },
          { signupId: SIGNUP_ID, smsOptIn: true },
        );
      });

    on();
    expect(screen.getByText(START)).toBeInTheDocument();
    act(() => {
      mocks.prefsOptions?.onSuccess?.(
        { smsMayNeedStart: false },
        { signupId: SIGNUP_ID, smsOptIn: false },
      );
    });
    expect(screen.queryByText(START)).not.toBeInTheDocument();

    on();
    expect(screen.getByText(START)).toBeInTheDocument();
    act(() => {
      mocks.prefsOptions?.onError?.({ message: "boom" });
    });
    expect(screen.queryByText(START)).not.toBeInTheDocument();
    expect(
      screen.getByText("eventDetail.volunteerSmsUpdateFailed"),
    ).toBeInTheDocument();
  });

  it("any other toggle failure keeps the generic message", () => {
    mocks.gates = { sms: true };
    mocks.mine = [signup(false, "shift")];
    renderOpenSheet();

    act(() => {
      mocks.prefsOptions?.onError?.({ message: "boom" });
    });

    expect(
      screen.getByText("eventDetail.volunteerSmsUpdateFailed"),
    ).toBeInTheDocument();
  });
});

describe("VolunteerSection — signup sheet SMS opt-in", () => {
  const BOX = "volunteer-sms-opt-in";

  beforeEach(() => {
    mocks.gates = { sms: true };
    mocks.mine = [];
    mocks.submit.mockReset();
    mocks.submit.mockResolvedValue({ id: "s1", status: "PENDING" });
  });

  function openDetailsWithPhone() {
    fireEvent.click(screen.getByText("eventDetail.volunteerAddDetails"));
    fireEvent.change(screen.getByLabelText("eventDetail.volunteerFieldPhone"), {
      target: { value: "+15005550006" },
    });
  }

  it("shows the box for a role with no shifts, labelled for the event start, and sends the tick", async () => {
    renderOpenSheet();
    fireEvent.click(screen.getByTestId(`volunteer-role-${ROLE.id}`));
    openDetailsWithPhone();

    expect(
      screen.getByText("eventDetail.volunteerSmsOptInLabelEventStart"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("eventDetail.volunteerSmsOptInLabel"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(BOX));
    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: ROLE.id, smsOptIn: true }),
    );
  });

  it("an unticked box on a role with no shifts sends smsOptIn: false", async () => {
    renderOpenSheet();
    fireEvent.click(screen.getByTestId(`volunteer-role-${ROLE.id}`));
    openDetailsWithPhone();

    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: ROLE.id, smsOptIn: false }),
    );
  });

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`hides the box and sends smsOptIn: false (${label})`, async () => {
      mocks.gates = gates;
      renderOpenSheet();
      fireEvent.click(screen.getByTestId(`volunteer-role-${ROLE.id}`));
      openDetailsWithPhone();

      expect(screen.queryByTestId(BOX)).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("volunteer-apply-button"));
      await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
      expect(mocks.submit).toHaveBeenCalledWith(
        expect.objectContaining({ smsOptIn: false }),
      );
    });
  }

  it("shows the box when a shift is picked and sends the opt-in on that shift", async () => {
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    openDetailsWithPhone();

    expect(
      screen.getByText("eventDetail.volunteerSmsOptInLabel"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(BOX));
    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ shiftId: "shift_1", smsOptIn: true }),
    );
  });

  it("with a shift and a shiftless role picked, the box names both and both signups opt in", async () => {
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    fireEvent.click(screen.getByTestId(`volunteer-role-${ROLE.id}`));
    openDetailsWithPhone();

    expect(
      screen.getByText("eventDetail.volunteerSmsOptInLabelMixed"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(BOX));
    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2));
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ shiftId: "shift_1", smsOptIn: true }),
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: ROLE.id, smsOptIn: true }),
    );
  });

  it("a ticked submit with the START hint says so once in the success summary", async () => {
    mocks.submit.mockResolvedValue({
      id: "s1",
      status: "PENDING",
      smsMayNeedStart: true,
    });
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    openDetailsWithPhone();

    fireEvent.click(screen.getByTestId(BOX));
    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    expect(
      await screen.findByText("eventDetail.volunteerSmsMayNeedStart"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("eventDetail.volunteerSmsMayNeedStart"),
    ).toHaveLength(1);
  });

  function submitShiftAndRoleTicked(
    shiftResult: "reject" | { smsMayNeedStart: boolean },
    roleResult: "reject" | { smsMayNeedStart: boolean },
  ) {
    mocks.submit.mockImplementation((input: { shiftId?: string }) => {
      const result = input.shiftId ? shiftResult : roleResult;
      return result === "reject"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ id: "s1", status: "PENDING", ...result });
    });
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    fireEvent.click(screen.getByTestId(`volunteer-role-${ROLE.id}`));
    openDetailsWithPhone();
    fireEvent.click(screen.getByTestId(BOX));
    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
  }

  it("a shiftless role signup that returns the hint shows it even when the shift one fails", async () => {
    submitShiftAndRoleTicked("reject", { smsMayNeedStart: true });

    expect(
      await screen.findByText("eventDetail.volunteerSuccessPartial"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("eventDetail.volunteerSmsMayNeedStart"),
    ).toHaveLength(1);
  });

  it("a failed signup beside one without the hint shows no START hint", async () => {
    submitShiftAndRoleTicked("reject", { smsMayNeedStart: false });

    expect(
      await screen.findByText("eventDetail.volunteerSuccessPartial"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("eventDetail.volunteerSmsMayNeedStart"),
    ).not.toBeInTheDocument();
  });

  it("a shift signup that returns the hint shows it even when the shiftless one fails", async () => {
    submitShiftAndRoleTicked({ smsMayNeedStart: true }, "reject");

    expect(
      await screen.findByText("eventDetail.volunteerSuccessPartial"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("eventDetail.volunteerSmsMayNeedStart"),
    ).toHaveLength(1);
  });

  it("an unticked submit never shows the START hint", async () => {
    mocks.submit.mockResolvedValue({
      id: "s1",
      status: "PENDING",
      smsMayNeedStart: true,
    });
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    openDetailsWithPhone();

    fireEvent.click(screen.getByTestId("volunteer-apply-button"));
    expect(
      await screen.findByText("eventDetail.volunteerSuccessAuth"),
    ).toBeInTheDocument();
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ smsOptIn: false }),
    );
    expect(
      screen.queryByText("eventDetail.volunteerSmsMayNeedStart"),
    ).not.toBeInTheDocument();
  });

  it("clears the tick when the last reminded pick is unpicked", () => {
    renderOpenSheet();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    openDetailsWithPhone();
    fireEvent.click(screen.getByTestId(BOX));
    expect(screen.getByTestId(BOX)).toBeChecked();

    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    expect(screen.queryByTestId(BOX)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("volunteer-shift-shift_1"));
    expect(screen.getByTestId(BOX)).not.toBeChecked();
  });
});
