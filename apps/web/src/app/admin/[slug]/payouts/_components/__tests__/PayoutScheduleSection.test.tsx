import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PayoutScheduleSection as Section } from "../PayoutScheduleSection";

// ─────────────────────────────────────────────────────────────────────────────
// Harness (mirrors TeamView.test.tsx): tamagui/@th/ui are replaced with plain
// DOM elements so we exercise the component's state machine — no-terms
// provisioning mode, payouts-not-ready read-only mode, and the existing
// terms-present mode — without the design system.
// ─────────────────────────────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  primaryPayoutTerms: null as { payoutSchedule: string } | null,
  mutateAsync: vi.fn(async (_input?: unknown): Promise<unknown> => ({})),
  setData: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  formatErrorMessage: vi.fn(() => "formatted-error"),
  queryError: null as unknown,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      // `id` / `tabIndex` / `onKeyDown` are forwarded because the radio-group
      // semantics under test live in exactly those props — a mock that dropped
      // them would render an inaccessible tree and still pass.
      if (
        key === "role" ||
        key.startsWith("data-") ||
        key === "id" ||
        key === "tabIndex" ||
        key === "onKeyDown" ||
        key.startsWith("aria-")
      )
        safe[key] = value;
    }
    if (onPress) safe.onClick = onPress;
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({
      colorMuted: { val: "#666666" },
      success: { val: "#00aa00" },
    }),
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
    ref,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    // React 19 passes `ref` as a prop; forwarded so focus-return is testable.
    ref?: Ref<HTMLButtonElement>;
  }) => (
    <button
      ref={ref}
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testId}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
    >
      {children}
    </button>
  ),
  Separator: () => <hr />,
  Spinner: () => <span>Loading</span>,
  useNotify: () => ({
    toast: { success: testState.toastSuccess, danger: testState.toastDanger },
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  Clock: () => null,
  Check: () => null,
  CalendarClock: () => null,
  Info: () => null,
  ChevronDown: () => null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    agreements: {
      getDefaultPayoutTerms: {
        useQuery: () => ({
          data: testState.queryError
            ? undefined
            : { primaryPayoutTerms: testState.primaryPayoutTerms },
          isLoading: false,
          error: testState.queryError,
          refetch: testState.refetch,
        }),
      },
      updatePayoutSchedule: {
        // Runs the caller's onSuccess like the real hook, so the cache write
        // after a save is exercised.
        useMutation: (opts?: { onSuccess?: (saved: unknown) => void }) => ({
          mutateAsync: async (input: unknown) => {
            const saved = await testState.mutateAsync(input);
            opts?.onSuccess?.(saved);
            return saved;
          },
          isPending: false,
        }),
      },
    },
    useUtils: () => ({
      agreements: { getDefaultPayoutTerms: { setData: testState.setData } },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (...args: unknown[]) =>
    testState.formatErrorMessage(...(args as [])),
}));

const orgEntity = { kind: "org", orgId: "org-1" } as const;

type HarnessProps = Omit<
  ComponentProps<typeof Section>,
  "disclosure" | "labelledBy" | "setupRequiredMessage"
> & {
  labelledBy?: string;
  setupRequiredMessage?: string;
  initiallyOpen?: boolean;
};

/**
 * The Settings row as PayoutsView drives it: a controlled disclosure. The
 * picker tests start it open; the disclosure tests start it folded.
 */
function PayoutScheduleSection({
  initiallyOpen = true,
  labelledBy = "schedule",
  setupRequiredMessage = "finish setup",
  ...props
}: HarnessProps) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <Section
      {...props}
      labelledBy={labelledBy}
      setupRequiredMessage={setupRequiredMessage}
      disclosure={{ open, onOpenChange: setOpen }}
    />
  );
}

function DisclosureHarness(props: HarnessProps) {
  return <PayoutScheduleSection {...props} initiallyOpen={false} />;
}

describe("PayoutScheduleSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.primaryPayoutTerms = null;
    testState.queryError = null;
    testState.mutateAsync.mockResolvedValue({});
  });

  it("a role that cannot read the terms (VIEWER, FORBIDDEN) gets a role notice, not a picker", () => {
    testState.queryError = { data: { code: "FORBIDDEN" } };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);
    // (This harness's Text mock drops test ids; the key is the assertion.)
    expect(screen.getByText("admin.payoutsRoleNoticeAccount")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("option copy comes from the catalog (titles, bodies, the notes)", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "WEEK_OF_EVENT" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);
    for (const key of [
      "admin.payoutSchedAsapTitle",
      "admin.payoutSchedWeekOfBody",
      "admin.payoutSchedFourWeeksTitle",
      "admin.payoutSchedTimingLine",
    ]) {
      expect(screen.getByText(key), key).toBeTruthy();
    }
  });

  it("no terms + payoutsReady: renders options unselected, Save appears on pick and fires the mutation", async () => {
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    // All five options render; nothing is marked "Current".
    expect(screen.getByTestId("schedule-option-ASAP")).toBeTruthy();
    expect(screen.getByTestId("schedule-option-FOUR_WEEKS_AFTER")).toBeTruthy();
    expect(screen.queryByText("admin.payoutSchedCurrent")).toBeNull();

    // Not chosen yet, and still the same cost whichever is picked.
    expect(screen.getByTestId("payout-schedule-summary").textContent).toContain(
      "admin.payoutSchedNoneYet" + "admin.payoutSchedSameCost",
    );
    expect(screen.queryByText("finish setup")).toBeNull();

    // No Save until a selection is made.
    expect(screen.queryByTestId("save-payout-schedule-btn")).toBeNull();

    fireEvent.click(screen.getByTestId("schedule-option-WEEK_OF_EVENT"));
    const save = screen.getByTestId("save-payout-schedule-btn");

    fireEvent.click(save);
    await waitFor(() =>
      expect(testState.mutateAsync).toHaveBeenCalledWith({
        entity: orgEntity,
        payoutSchedule: "WEEK_OF_EVENT",
      }),
    );
    await waitFor(() => expect(testState.toastSuccess).toHaveBeenCalled());
  });

  it("no terms + !payoutsReady: options are inert, setup notice shows, no Save", () => {
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady={false} />);

    // (The Text mock drops test ids; the caller's note is the assertion.)
    expect(screen.getByText("finish setup")).toBeTruthy();

    // Options render for context but picking one does nothing.
    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    expect(screen.queryByTestId("save-payout-schedule-btn")).toBeNull();
    expect(testState.mutateAsync).not.toHaveBeenCalled();
  });

  it("terms exist: current chip renders and changing the schedule saves — regardless of payoutsReady", async () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    // payoutsReady={false} must have NO effect once terms exist.
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady={false} />);

    expect(screen.getByText("admin.payoutSchedCurrent")).toBeTruthy();
    // The summary names the current schedule.
    expect(screen.getByTestId("payout-schedule-summary").textContent).toContain(
      "admin.payoutSchedAsapTitle",
    );
    expect(screen.queryByText("finish setup")).toBeNull();
    expect(screen.queryByTestId("save-payout-schedule-btn")).toBeNull();

    fireEvent.click(screen.getByTestId("schedule-option-TWO_WEEKS_AFTER"));
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));

    await waitFor(() =>
      expect(testState.mutateAsync).toHaveBeenCalledWith({
        entity: orgEntity,
        payoutSchedule: "TWO_WEEKS_AFTER",
      }),
    );
  });

  it("canEdit=false stays read-only even with no terms and payouts ready", () => {
    render(
      <PayoutScheduleSection
        entity={orgEntity}
        canEdit={false}
        payoutsReady
      />,
    );

    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    expect(screen.queryByTestId("save-payout-schedule-btn")).toBeNull();
  });

  it("save failure threads the translator into formatErrorMessage", async () => {
    const failure = new Error("PAYEE_NOT_READY");
    testState.mutateAsync.mockRejectedValueOnce(failure);
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));

    await waitFor(() => expect(testState.toastDanger).toHaveBeenCalled());
    expect(testState.formatErrorMessage).toHaveBeenCalledWith(
      failure,
      expect.any(Function),
    );
    expect(testState.toastDanger.mock.calls[0][0].message).toBe(
      "formatted-error",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARIA radio-group semantics + keyboard operation
// ─────────────────────────────────────────────────────────────────────────────

describe("PayoutScheduleSection — radio group accessibility", () => {
  const ORDER = [
    "ASAP",
    "WEEK_OF_EVENT",
    "ONE_WEEK_AFTER",
    "TWO_WEEKS_AFTER",
    "FOUR_WEEKS_AFTER",
  ] as const;

  const rowFor = (value: string) => screen.getByTestId(`schedule-option-${value}`);

  it("exposes a labelled radiogroup of radios with the current one checked", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ONE_WEEK_AFTER" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    const group = screen.getByRole("radiogroup");
    // Named by the row's visible heading, so the label can't drift from it.
    expect(group.getAttribute("aria-labelledby")).toBe("schedule");

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(ORDER.length);

    // Exactly one radio is checked, and it is the stored schedule.
    const checked = radios.filter(
      (r) => r.getAttribute("aria-checked") === "true",
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBe(rowFor("ONE_WEEK_AFTER"));
  });

  it("uses a roving tabindex so the group is a single tab stop", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "TWO_WEEKS_AFTER" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    const tabbable = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rowFor("TWO_WEEKS_AFTER"));
  });

  it("makes the FIRST radio the entry point when nothing is selected yet", () => {
    // Pre-first-save: no schedule stored, so the group still needs one tab stop.
    testState.primaryPayoutTerms = null;
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    const tabbable = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rowFor("ASAP"));
    expect(
      screen.getAllByRole("radio").every(
        (r) => r.getAttribute("aria-checked") === "false",
      ),
    ).toBe(true);
  });

  it("moves selection with arrow keys, wrapping at both ends", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    fireEvent.keyDown(rowFor("ASAP"), { key: "ArrowDown" });
    expect(rowFor("WEEK_OF_EVENT").getAttribute("aria-checked")).toBe("true");

    // Wrap backwards off the first option.
    fireEvent.keyDown(rowFor("WEEK_OF_EVENT"), { key: "ArrowUp" });
    fireEvent.keyDown(rowFor("ASAP"), { key: "ArrowUp" });
    expect(rowFor("FOUR_WEEKS_AFTER").getAttribute("aria-checked")).toBe("true");
  });

  it("supports Home/End and selects with Space", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ONE_WEEK_AFTER" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    fireEvent.keyDown(rowFor("ONE_WEEK_AFTER"), { key: "End" });
    expect(rowFor("FOUR_WEEKS_AFTER").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(rowFor("FOUR_WEEKS_AFTER"), { key: "Home" });
    expect(rowFor("ASAP").getAttribute("aria-checked")).toBe("true");

    // Space selects whatever Tab landed on, without moving focus.
    fireEvent.keyDown(rowFor("TWO_WEEKS_AFTER"), { key: " " });
    expect(rowFor("TWO_WEEKS_AFTER").getAttribute("aria-checked")).toBe("true");
  });

  it("keyboard selection reaches the mutation, same as clicking", async () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    fireEvent.keyDown(rowFor("ASAP"), { key: "ArrowDown" });
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));

    await waitFor(() =>
      expect(testState.mutateAsync).toHaveBeenCalledWith({
        entity: orgEntity,
        payoutSchedule: "WEEK_OF_EVENT",
      }),
    );
  });

  it("marks the group disabled and drops it from the tab order when payouts are not ready", () => {
    testState.primaryPayoutTerms = null;
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady={false} />);

    expect(screen.getByRole("radiogroup").getAttribute("aria-disabled")).toBe(
      "true",
    );

    const radios = screen.getAllByRole("radio");
    expect(
      radios.every((r) => r.getAttribute("aria-disabled") === "true"),
    ).toBe(true);
    // No tab stop at all — a disabled control should not be reachable by Tab.
    expect(radios.every((r) => r.getAttribute("tabindex") === "-1")).toBe(true);

    // And the keys are inert too.
    fireEvent.keyDown(rowFor("ASAP"), { key: "ArrowDown" });
    expect(
      radios.every((r) => r.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(screen.queryByTestId("save-payout-schedule-btn")).toBeNull();
  });

  it("does not hijack keys it has no business handling", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);

    // Tab must stay Tab, or the group becomes a keyboard trap.
    const evt = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    rowFor("ASAP").dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(rowFor("ASAP").getAttribute("aria-checked")).toBe("true");
  });

  it("ready and configured: never dimmed", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    render(<PayoutScheduleSection entity={orgEntity} payoutsReady />);
    expect(screen.getByRole("radiogroup").getAttribute("data-dimmed")).toBeNull();
  });

  it("setup required: the options dim and the caller's note says where setup is", () => {
    testState.primaryPayoutTerms = null;
    render(
      <PayoutScheduleSection
        entity={orgEntity}
        payoutsReady={false}
        setupRequiredMessage="finish it below"
      />,
    );
    expect(screen.getByRole("radiogroup").getAttribute("data-dimmed")).toBe(
      "true",
    );
    expect(screen.getByText("finish it below")).toBeTruthy();
  });

  it("read-only for a role is not dimmed — the current schedule is real information", () => {
    testState.primaryPayoutTerms = { payoutSchedule: "ASAP" };
    render(
      <PayoutScheduleSection entity={orgEntity} canEdit={false} payoutsReady />,
    );
    expect(screen.getByRole("radiogroup").getAttribute("data-dimmed")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Settings row (board B, 2026-10-14): a one-line summary and a
// "Change schedule" disclosure over the full picker.
// ─────────────────────────────────────────────────────────────────────────────

describe("PayoutScheduleSection — the Settings row disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.primaryPayoutTerms = { payoutSchedule: "TWO_WEEKS_AFTER" };
    testState.queryError = null;
    testState.mutateAsync.mockResolvedValue({});
  });

  const toggle = () =>
    screen.getByTestId("payout-schedule-toggle") as HTMLButtonElement;

  it("folded: the current schedule in one line, the picker behind Change schedule", () => {
    render(<DisclosureHarness entity={orgEntity} payoutsReady labelledBy="schedule" />);

    const summary = screen.getByTestId("payout-schedule-summary");
    expect(summary.textContent).toBe(
      "admin.payoutSchedTwoWeeksTitle" +
        "admin.payoutSchedTwoWeeksShort admin.payoutSchedSameCost" +
        "admin.payoutSchedTimingLine",
    );
    expect(toggle().textContent).toBe("admin.payoutSchedChange");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe("payout-schedule-picker");
    // The controlled element exists while folded, empty.
    const picker = screen.getByTestId("payout-schedule-picker");
    expect(picker.getAttribute("id")).toBe("payout-schedule-picker");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("open: all five options and every trade-off note, readable while choosing", () => {
    render(<DisclosureHarness entity={orgEntity} payoutsReady labelledBy="schedule" />);
    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    for (const key of [
      "admin.payoutSchedAsapBody",
      "admin.payoutSchedFourWeeksBody",
      "admin.payoutSchedAppliesToNew",
    ]) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    // Midnight CT, two business days, the bank's own schedule: said once,
    // in the folded summary, not again inside the picker.
    expect(screen.getAllByText("admin.payoutSchedTimingLine")).toHaveLength(1);
    // The radiogroup takes the row heading's name.
    expect(screen.getByRole("radiogroup").getAttribute("aria-labelledby")).toBe(
      "schedule",
    );
  });

  it("an unsaved pick holds it open; Cancel lets it fold", () => {
    render(<DisclosureHarness entity={orgEntity} payoutsReady />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));

    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    expect(screen.getByTestId("save-payout-schedule-btn")).toBeTruthy();

    fireEvent.click(screen.getByText("admin.cancel"));
    expect(toggle().disabled).toBe(false);
    // Cancel unmounted itself; focus lands on the toggle, not <body>.
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("a failed save stays open with the pick in place; a saved one folds", async () => {
    testState.mutateAsync.mockRejectedValueOnce(new Error("boom"));
    render(<DisclosureHarness entity={orgEntity} payoutsReady />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));

    await waitFor(() => expect(testState.toastDanger).toHaveBeenCalled());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByTestId("schedule-option-ASAP").getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));
    await waitFor(() =>
      expect(toggle().getAttribute("aria-expanded")).toBe("false"),
    );
    // Save unmounted with the fold; focus goes back to the toggle.
    await waitFor(() => expect(document.activeElement).toBe(toggle()));
  });

  it("a saved schedule goes into the cache, so a failed refetch cannot show the old one", async () => {
    testState.mutateAsync.mockResolvedValueOnce({
      payoutTermsId: "pt-1",
      payoutSchedule: "ASAP",
    });
    render(<DisclosureHarness entity={orgEntity} payoutsReady />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));
    await waitFor(() => expect(testState.setData).toHaveBeenCalledTimes(1));

    const [input, update] = testState.setData.mock.calls[0] as [
      unknown,
      (prev: unknown) => {
        defaultPrimaryPayoutTermsId: string;
        primaryPayoutTerms: Record<string, unknown>;
      },
    ];
    expect(input).toEqual({ entity: orgEntity });
    // Existing terms: only the schedule changes.
    const next = update({
      // A stale cached id: the server's id for the row it wrote wins.
      defaultPrimaryPayoutTermsId: "pt-0",
      defaultResalePayoutTermsId: null,
      primaryPayoutTerms: { id: "pt-0", payoutSchedule: "TWO_WEEKS_AFTER", x: 1 },
      resalePayoutTerms: null,
    });
    expect(next.defaultPrimaryPayoutTermsId).toBe("pt-1");
    expect(next.primaryPayoutTerms).toEqual({
      id: "pt-1",
      payoutSchedule: "ASAP",
      x: 1,
    });
    // No terms before (first save provisions them): the summary still learns it.
    expect(update(undefined).primaryPayoutTerms).toEqual({
      id: "pt-1",
      payoutSchedule: "ASAP",
    });
  });

  it("after a save, focus stays put if the organiser has already moved it", async () => {
    render(
      <>
        <DisclosureHarness entity={orgEntity} payoutsReady />
        <button type="button">elsewhere</button>
      </>,
    );
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("schedule-option-ASAP"));
    const elsewhere = screen.getByText("elsewhere");
    elsewhere.focus();
    fireEvent.click(screen.getByTestId("save-payout-schedule-btn"));
    await waitFor(() =>
      expect(toggle().getAttribute("aria-expanded")).toBe("false"),
    );
    expect(document.activeElement).toBe(elsewhere);
  });

  it("a failed read says so, offers Retry, and hides Change", () => {
    testState.queryError = { data: { code: "INTERNAL_SERVER_ERROR" } };
    render(<DisclosureHarness entity={orgEntity} payoutsReady />);

    expect(screen.getByText("admin.payoutSchedLoadFailed")).toBeTruthy();
    expect(screen.queryByText("admin.payoutSchedNoneYet")).toBeNull();
    expect(screen.queryByTestId("payout-schedule-toggle")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.click(screen.getByTestId("payout-schedule-retry"));
    expect(testState.refetch).toHaveBeenCalledTimes(1);
  });

  it("read-only role: the button says See all schedules", () => {
    render(<DisclosureHarness entity={orgEntity} canEdit={false} payoutsReady />);
    expect(toggle().textContent).toBe("admin.payoutSchedSeeAll");
  });

  it("setup required: the note sits in the summary, said once even when open", () => {
    testState.primaryPayoutTerms = null;
    render(
      <DisclosureHarness
        entity={orgEntity}
        payoutsReady={false}
        setupRequiredMessage="finish at the top"
      />,
    );
    expect(screen.getByTestId("payout-schedule-summary").textContent).toContain(
      "admin.payoutSchedNoneYet",
    );
    fireEvent.click(toggle());
    expect(screen.getAllByText("finish at the top")).toHaveLength(1);
  });
});
