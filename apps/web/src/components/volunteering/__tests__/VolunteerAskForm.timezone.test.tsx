import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { YStack: passthrough, XStack: passthrough };
});

vi.mock("@th/ui", () => {
  const Modal = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );
  return {
    Modal,
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
      testId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      testId?: string;
    }) => (
      <select
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Switch: () => <input type="checkbox" />,
    Text: ({
      children,
      role,
      id,
      "data-testid": testId,
    }: {
      children?: ReactNode;
      role?: string;
      id?: string;
      "data-testid"?: string;
    }) => (
      <span role={role} id={id} data-testid={testId}>
        {children}
      </span>
    ),
    // Forwards the ref and the aria props the form sets, so focus and the
    // error wiring can be asserted.
    TextInput: ({
      ref,
      value,
      onChangeText,
      testId,
      "aria-invalid": ariaInvalid,
      "aria-describedby": ariaDescribedBy,
    }: {
      ref?: Ref<HTMLInputElement>;
      value: string;
      onChangeText?: (value: string) => void;
      testId?: string;
      "aria-invalid"?: boolean;
      "aria-describedby"?: string;
    }) => (
      <input
        ref={ref}
        data-testid={testId}
        value={value}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations:
      () => (key: string, values?: Record<string, string>) =>
        values ? `${key}:${Object.values(values).join(",")}` : key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      asks: {
        create: {
          useMutation: () => ({ mutate: mockCreate, isPending: false }),
        },
        update: {
          useMutation: () => ({ mutate: mockUpdate, isPending: false }),
        },
      },
    },
  },
}));

let mockGates: { sms?: boolean } | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates, isLoading: false }),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { VolunteerAskForm } from "../VolunteerAskForm";

function renderCreate() {
  render(
    <VolunteerAskForm
      mode="create"
      subject={{ subjectType: "ORG", subjectId: "org1" }}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />,
  );
}

const zoneSelect = () =>
  screen.getByTestId("volunteer-ask-timezone") as HTMLSelectElement;
const submit = () => fireEvent.click(screen.getByTestId("volunteer-ask-submit"));
const typeTitle = (value: string) =>
  fireEvent.change(screen.getByTestId("volunteer-ask-title"), {
    target: { value },
  });

describe("VolunteerAskForm — empty title", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  it("keeps CREATE enabled, and on submit says Title is missing, focuses it and sends nothing", () => {
    renderCreate();
    const button = screen.getByTestId("volunteer-ask-submit");
    expect(button).not.toBeDisabled();

    submit();

    expect(mockCreate).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("volunteering.askTitleRequired");
    const title = screen.getByTestId("volunteer-ask-title");
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveAttribute("aria-describedby", alert.id);
    expect(document.activeElement).toBe(title);
  });

  it("treats a whitespace-only title as missing", () => {
    renderCreate();
    typeTitle("   ");
    submit();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "volunteering.askTitleRequired",
    );
  });

  it("clears the error as soon as a title is typed", () => {
    renderCreate();
    submit();
    expect(screen.getByRole("alert")).toBeTruthy();

    typeTitle("D");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("volunteer-ask-title")).not.toHaveAttribute(
      "aria-invalid",
    );

    submit();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// Two zones neither of which can be the host's at once, with the instant
// "2026-10-24T18:00" names in each. Picking one at runtime that differs from
// the host means a regression to browser-zone parsing cannot pass by luck.
// Kolkata also covers a half-hour offset.
const ZONES = [
  { zone: "Asia/Kolkata", sixPm: "2026-10-24T12:30:00.000Z" },
  { zone: "Pacific/Auckland", sixPm: "2026-10-24T05:00:00.000Z" },
] as const;
const canonical = (zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
    .timeZone;
/** The select's option for `zone`: ICU may list it under an alias. */
const listed = (zone: string) =>
  Intl.supportedValuesOf("timeZone").find(
    (z) => canonical(z) === canonical(zone),
  ) ?? zone;
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Compared canonically: a Kolkata host reports "Asia/Calcutta" on some ICUs.
const [AWAY, OTHER] = (() => {
  const away =
    ZONES.find((z) => canonical(z.zone) !== canonical(HOST_ZONE)) ?? ZONES[0];
  const other = ZONES.find((z) => z !== away) ?? ZONES[1];
  return [away, other];
})();

describe("VolunteerAskForm — timezone", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  it("picks a test zone that is not the host's", () => {
    expect(canonical(AWAY.zone)).not.toBe(canonical(HOST_ZONE));
  });

  it("defaults to the browser zone and sends it on create", () => {
    renderCreate();
    expect(zoneSelect().value).toBe(HOST_ZONE);

    typeTitle("Door crew");
    submit();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0].timezone).toBe(HOST_ZONE);
  });

  it("reads the typed wall clock in the chosen zone, not the browser's", () => {
    renderCreate();
    typeTitle("Door crew");
    fireEvent.change(screen.getByTestId("volunteer-ask-starts-at"), {
      target: { value: "2026-10-24T18:00" },
    });
    fireEvent.change(zoneSelect(), { target: { value: listed(AWAY.zone) } });
    submit();

    const sent = mockCreate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(AWAY.zone));
    expect((sent.startsAt as Date).toISOString()).toBe(AWAY.sixPm);
  });

  it("keeps the typed clock when the zone changes, and moves the instant", () => {
    renderCreate();
    typeTitle("Door crew");
    const starts = screen.getByTestId(
      "volunteer-ask-starts-at",
    ) as HTMLInputElement;
    fireEvent.change(starts, { target: { value: "2026-10-24T18:00" } });
    fireEvent.change(zoneSelect(), { target: { value: listed(AWAY.zone) } });
    fireEvent.change(zoneSelect(), { target: { value: listed(OTHER.zone) } });
    expect(starts.value).toBe("2026-10-24T18:00");

    submit();
    const sent = mockCreate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(OTHER.zone));
    expect((sent.startsAt as Date).toISOString()).toBe(OTHER.sixPm);
  });

  it("edit mode prefills the window as the wall clock in the ask's zone", () => {
    render(
      <VolunteerAskForm
        mode="edit"
        askId="ask1"
        initial={{
          title: "Door crew",
          description: null,
          cadence: "ONE_TIME",
          startsAt: AWAY.sixPm,
          endsAt: new Date(new Date(AWAY.sixPm).getTime() + 4 * 3_600_000),
          capacity: null,
          autoApprove: false,
          waiverRequired: false,
          smsOptInEnabled: false,
          timezone: AWAY.zone,
        }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    // Shown as whichever alias this runtime lists…
    expect(zoneSelect().value).toBe(listed(AWAY.zone));
    expect(
      (screen.getByTestId("volunteer-ask-starts-at") as HTMLInputElement).value,
    ).toBe("2026-10-24T18:00");
    expect(
      (screen.getByTestId("volunteer-ask-ends-at") as HTMLInputElement).value,
    ).toBe("2026-10-24T22:00");

    // …and saving untouched round-trips the same instants and the stored
    // spelling of the zone.
    submit();
    const sent = mockUpdate.mock.calls[0]?.[0];
    expect(sent.askId).toBe("ask1");
    expect(sent.timezone).toBe(AWAY.zone);
    expect((sent.startsAt as Date).toISOString()).toBe(AWAY.sixPm);
    expect((sent.endsAt as Date).getTime()).toBe(
      new Date(AWAY.sixPm).getTime() + 4 * 3_600_000,
    );
  });
});

function renderEdit(
  overrides: {
    startsAt?: string | null;
    timezone?: string | null;
    smsOptInEnabled?: boolean;
  } = {},
  defaultTimezone?: string | null,
) {
  const initial = {
    title: "Door crew",
    description: null,
    cadence: "ONE_TIME" as const,
    startsAt: AWAY.sixPm,
    endsAt: null,
    capacity: null,
    autoApprove: false,
    waiverRequired: false,
    smsOptInEnabled: false,
    timezone: AWAY.zone,
    ...overrides,
  };
  return render(
    <VolunteerAskForm
      mode="edit"
      askId="ask1"
      initial={initial}
      defaultTimezone={defaultTimezone}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />,
  );
}

const startsInput = () =>
  screen.getByTestId("volunteer-ask-starts-at") as HTMLInputElement;
const fromPlaceNote = () =>
  screen.queryByTestId("volunteer-ask-timezone-from-place");

describe("VolunteerAskForm — changing the zone in edit mode", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  it("sends the newly chosen zone and the instants the clock names in it", () => {
    renderEdit();
    expect(startsInput().value).toBe("2026-10-24T18:00");
    fireEvent.change(zoneSelect(), { target: { value: listed(OTHER.zone) } });
    submit();

    const sent = mockUpdate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(OTHER.zone));
    expect((sent.startsAt as Date).toISOString()).toBe(OTHER.sixPm);
  });

  it("sends exactly the stored spelling after changing away and back", () => {
    renderEdit();
    fireEvent.change(zoneSelect(), { target: { value: listed(OTHER.zone) } });
    fireEvent.change(zoneSelect(), { target: { value: listed(AWAY.zone) } });
    submit();

    const sent = mockUpdate.mock.calls[0]?.[0];
    expect(sent.timezone).toBe(AWAY.zone);
    expect((sent.startsAt as Date).toISOString()).toBe(AWAY.sixPm);
  });
});

describe("VolunteerAskForm — a place's zone as the default", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  it("starts a new ask on the place's zone and says where it came from", () => {
    render(
      <VolunteerAskForm
        mode="create"
        subject={{ subjectType: "PLACE", subjectId: "place1" }}
        defaultTimezone={AWAY.zone}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(canonical(zoneSelect().value)).toBe(canonical(AWAY.zone));
    expect(fromPlaceNote()?.textContent).toContain(
      "communityCreate.pfTimezoneFromPlace",
    );

    typeTitle("Door crew");
    fireEvent.change(startsInput(), { target: { value: "2026-10-24T18:00" } });
    submit();
    const sent = mockCreate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(AWAY.zone));
    expect((sent.startsAt as Date).toISOString()).toBe(AWAY.sixPm);
  });

  it("drops the note once the user picks a zone", () => {
    render(
      <VolunteerAskForm
        mode="create"
        subject={{ subjectType: "PLACE", subjectId: "place1" }}
        defaultTimezone={AWAY.zone}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.change(zoneSelect(), { target: { value: listed(OTHER.zone) } });
    expect(fromPlaceNote()).toBeNull();
  });

  it("uses the browser zone when the place has none", () => {
    render(
      <VolunteerAskForm
        mode="create"
        subject={{ subjectType: "PLACE", subjectId: "place1" }}
        defaultTimezone={null}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(zoneSelect().value).toBe(HOST_ZONE);
    expect(fromPlaceNote()).toBeNull();
  });

  it("switches to the place zone when it arrives late, unless the user picked one", () => {
    const props = {
      mode: "create" as const,
      subject: { subjectType: "PLACE" as const, subjectId: "place1" },
      onClose: vi.fn(),
      onSuccess: vi.fn(),
    };
    const { rerender } = render(<VolunteerAskForm {...props} />);
    expect(zoneSelect().value).toBe(HOST_ZONE);
    rerender(<VolunteerAskForm {...props} defaultTimezone={AWAY.zone} />);
    expect(canonical(zoneSelect().value)).toBe(canonical(AWAY.zone));
    expect(fromPlaceNote()).not.toBeNull();
  });

  it("keeps the user's pick when the place zone arrives after it", () => {
    const props = {
      mode: "create" as const,
      subject: { subjectType: "PLACE" as const, subjectId: "place1" },
      onClose: vi.fn(),
      onSuccess: vi.fn(),
    };
    const { rerender } = render(<VolunteerAskForm {...props} />);
    fireEvent.change(zoneSelect(), { target: { value: listed(OTHER.zone) } });
    rerender(<VolunteerAskForm {...props} defaultTimezone={AWAY.zone} />);
    expect(canonical(zoneSelect().value)).toBe(canonical(OTHER.zone));
    expect(fromPlaceNote()).toBeNull();
  });

  it("keeps an ask's own zone over the place's", () => {
    renderEdit({}, OTHER.zone);
    expect(canonical(zoneSelect().value)).toBe(canonical(AWAY.zone));
    expect(fromPlaceNote()).toBeNull();
  });

  it("prefills and saves an older zone-less ask in the place's zone", () => {
    renderEdit({ timezone: null }, AWAY.zone);
    expect(canonical(zoneSelect().value)).toBe(canonical(AWAY.zone));
    expect(startsInput().value).toBe("2026-10-24T18:00");
    submit();
    const sent = mockUpdate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(AWAY.zone));
    // Same instant as stored: prefill and save used the same zone.
    expect((sent.startsAt as Date).toISOString()).toBe(AWAY.sixPm);
  });

  it("re-reads an untouched zone-less ask when the place zone arrives late", () => {
    const { rerender } = renderEdit({ timezone: null });
    const before = startsInput().value;
    rerender(
      <VolunteerAskForm
        mode="edit"
        askId="ask1"
        initial={{
          title: "Door crew",
          description: null,
          cadence: "ONE_TIME",
          startsAt: AWAY.sixPm,
          endsAt: null,
          capacity: null,
          autoApprove: false,
          waiverRequired: false,
          smsOptInEnabled: false,
          timezone: null,
        }}
        defaultTimezone={AWAY.zone}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(before).not.toBe("2026-10-24T18:00");
    expect(startsInput().value).toBe("2026-10-24T18:00");
    submit();
    expect(
      (mockUpdate.mock.calls[0]?.[0].startsAt as Date).toISOString(),
    ).toBe(AWAY.sixPm);
  });
});

describe("VolunteerAskForm — the place zone arriving after typing", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  it("create: keeps the typed clock and reads it in the place zone", () => {
    const props = {
      mode: "create" as const,
      subject: { subjectType: "PLACE" as const, subjectId: "place1" },
      onClose: vi.fn(),
      onSuccess: vi.fn(),
    };
    const { rerender } = render(<VolunteerAskForm {...props} />);
    typeTitle("Door crew");
    fireEvent.change(startsInput(), { target: { value: "2026-10-24T18:00" } });

    rerender(<VolunteerAskForm {...props} defaultTimezone={AWAY.zone} />);

    expect(startsInput().value).toBe("2026-10-24T18:00");
    expect(canonical(zoneSelect().value)).toBe(canonical(AWAY.zone));
    expect(fromPlaceNote()).not.toBeNull();
    submit();
    expect(
      (mockCreate.mock.calls[0]?.[0].startsAt as Date).toISOString(),
    ).toBe(AWAY.sixPm);
  });

  it("edit: a touched Starts keeps its clock, an untouched Ends keeps its instant", () => {
    const endsInstant = new Date(new Date(AWAY.sixPm).getTime() + 4 * 3_600_000);
    const initial = {
      title: "Door crew",
      description: null,
      cadence: "ONE_TIME" as const,
      startsAt: AWAY.sixPm,
      endsAt: endsInstant,
      capacity: null,
      autoApprove: false,
      waiverRequired: false,
      smsOptInEnabled: false,
      timezone: null,
    };
    const props = {
      mode: "edit" as const,
      askId: "ask1",
      initial,
      onClose: vi.fn(),
      onSuccess: vi.fn(),
    };
    const { rerender } = render(<VolunteerAskForm {...props} />);
    fireEvent.change(startsInput(), { target: { value: "2026-10-24T09:00" } });

    rerender(<VolunteerAskForm {...props} defaultTimezone={AWAY.zone} />);

    const ends = screen.getByTestId(
      "volunteer-ask-ends-at",
    ) as HTMLInputElement;
    expect(startsInput().value).toBe("2026-10-24T09:00");
    // Re-read in the place zone: the same instant, shown as AWAY's clock.
    expect(ends.value).toBe("2026-10-24T22:00");

    submit();
    const sent = mockUpdate.mock.calls[0]?.[0];
    expect(canonical(sent.timezone)).toBe(canonical(AWAY.zone));
    expect((sent.endsAt as Date).getTime()).toBe(endsInstant.getTime());
    // The typed 09:00 is read in the place zone, nine hours before 18:00.
    expect((sent.startsAt as Date).getTime()).toBe(
      new Date(AWAY.sixPm).getTime() - 9 * 3_600_000,
    );
  });
});

// Ask reminders are not built yet, so the switch is gone whatever the SMS
// gate says; the stored setting rides through a save untouched.
describe("VolunteerAskForm — Offer SMS reminders (not offered)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset();
  });

  for (const [label, gates] of [
    ["sms gate on", { sms: true }],
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`shows no switch and creates with smsOptInEnabled: false (${label})`, () => {
      mockGates = gates;
      renderCreate();
      expect(
        screen.queryByText("volunteering.askFieldSmsOptIn"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("volunteering.askFieldSmsOptInHelp"),
      ).not.toBeInTheDocument();
      typeTitle("Door crew");
      submit();
      expect(mockCreate.mock.calls[0]?.[0].smsOptInEnabled).toBe(false);
    });
  }

  it("keeps an ask's stored choice on save", () => {
    mockGates = { sms: true };
    renderEdit({ smsOptInEnabled: true });
    expect(
      screen.queryByText("volunteering.askFieldSmsOptIn"),
    ).not.toBeInTheDocument();
    submit();
    expect(mockUpdate.mock.calls[0]?.[0].smsOptInEnabled).toBe(true);
  });
});
