import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SetHoursModal (availability-onboarding spec, FR-002) — wire-level pins:
 *
 *  - presets exist ONLY while the detector says unconfigured, and never while
 *    the read is still in flight (a preset over an unanswered read could
 *    replace real hours — data loss);
 *  - a preset writes through `places.upsertCalendarAvailability`, one FULL-PUT
 *    create per weekday, threaded to the scope the detector chose (default
 *    calendar id, else place-wide null);
 *  - after a preset lands, BOTH reads are invalidated — the rows the editor
 *    shows and the setup-state every warning surface hangs off.
 *
 * The real CalendarHoursEditor mounts inside (only chrome and transport are
 * mocked), which is itself part of the contract: the modal embeds the
 * existing editor, it does not fork one.
 */

const testMocks = vi.hoisted(() => ({
  upsertAsync: vi.fn(),
  upsertMutate: vi.fn(),
  deleteMutate: vi.fn(),
  invalidateAvailability: vi.fn(),
  invalidateSetupState: vi.fn(),
  refetchSetup: vi.fn(),
  toastDanger: vi.fn(),
}));

let setupState:
  | {
      configured: boolean;
      calendarCount: number;
      defaultCalendarId: string | null;
    }
  | undefined;
let setupPending = false;
let setupError: Error | null = null;
let calendarRows: { id: string; name: string }[] = [];

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        listCalendarAvailability: {
          invalidate: testMocks.invalidateAvailability,
        },
        getAvailabilitySetupState: {
          invalidate: testMocks.invalidateSetupState,
        },
      },
    }),
    places: {
      getAvailabilitySetupState: {
        useQuery: () => ({
          data: setupError || setupPending ? undefined : setupState,
          isPending: setupPending,
          error: setupError,
          refetch: testMocks.refetchSetup,
        }),
      },
      listCalendars: {
        useQuery: () => ({
          data: calendarRows,
          isPending: false,
          error: null,
        }),
      },
      listCalendarAvailability: {
        useQuery: () => ({
          data: [],
          isPending: false,
          error: null,
        }),
      },
      upsertCalendarAvailability: {
        useMutation: () => ({
          mutate: testMocks.upsertMutate,
          mutateAsync: testMocks.upsertAsync,
          isPending: false,
        }),
      },
      deleteCalendarAvailability: {
        useMutation: () => ({
          mutate: testMocks.deleteMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    testID,
  }: {
    children?: ReactNode;
    testID?: string;
  }) => <div data-testid={testID}>{children}</div>;
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const ModalRoot = ({
    open,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    children?: ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null);
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(ModalRoot, {
    Panel: Passthrough,
    Header: ({ title, onClose }: { title: string; onClose?: () => void }) => (
      <div>
        <h2>{title}</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            close
          </button>
        )}
      </div>
    ),
    Body: Passthrough,
    Footer: Passthrough,
  });
  return {
    Modal,
    Button: ({
      children,
      disabled,
      onPress,
      testID,
      "aria-label": ariaLabel,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      testID?: string;
      "aria-label"?: string;
    }) => (
      <button
        type="button"
        data-testid={testID}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    Spinner: () => <span>loading…</span>,
    Text: ({ children, id }: { children?: ReactNode; id?: string }) => (
      <span id={id}>{children}</span>
    ),
    useNotify: () => ({ toast: { danger: testMocks.toastDanger } }),
    useTranslations: () => (key: string) => key,
  };
});

import { SetHoursModal } from "../SetHoursModal";

const PLACE_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.upsertAsync.mockResolvedValue({});
  setupState = { configured: false, calendarCount: 0, defaultCalendarId: null };
  setupPending = false;
  setupError = null;
  calendarRows = [];
});

const renderModal = () =>
  render(<SetHoursModal placeId={PLACE_ID} open onClose={vi.fn()} />);

describe("SetHoursModal", () => {
  it("offers presets while unconfigured, with the editor mounted below", () => {
    renderModal();
    expect(screen.getByTestId("hours-presets")).toBeTruthy();
    expect(screen.getByTestId("hours-preset-every_night")).toBeTruthy();
    // The embedded editor's heading — the real component, not a fork.
    expect(screen.getByText("admin.peHoursTitle")).toBeTruthy();
  });

  it("hides presets once ANY rows exist — editor only", () => {
    setupState = {
      configured: true,
      calendarCount: 0,
      defaultCalendarId: null,
    };
    renderModal();
    expect(screen.queryByTestId("hours-presets")).toBeNull();
    expect(screen.getByText("admin.peHoursTitle")).toBeTruthy();
  });

  it("offers nothing while the detector read is still in flight", () => {
    setupPending = true;
    renderModal();
    expect(screen.queryByTestId("hours-presets")).toBeNull();
    // And no live editor over a state we cannot vouch for either.
    expect(screen.queryByText("admin.peHoursTitle")).toBeNull();
  });

  it("a failed detector read shows retry, not live controls", () => {
    setupError = new Error("boom");
    renderModal();
    expect(screen.queryByTestId("hours-presets")).toBeNull();
    fireEvent.click(screen.getByText("admin.placesRetry"));
    expect(testMocks.refetchSetup).toHaveBeenCalled();
  });

  it("'Every night' seeds 7 FULL-PUT rows, Monday-first, 18:00–02:00 overnight, place-wide scope", async () => {
    renderModal();
    fireEvent.click(screen.getByTestId("hours-preset-every_night"));

    await waitFor(() =>
      expect(testMocks.upsertAsync).toHaveBeenCalledTimes(7),
    );

    const payloads = testMocks.upsertAsync.mock.calls.map((c) => c[0]);
    expect(payloads.map((p) => p.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    for (const p of payloads) {
      expect(p).toMatchObject({
        placeId: PLACE_ID,
        calendarId: null,
        date: null,
        startTime: "18:00",
        endTime: "02:00",
        isOpen: true,
        note: null,
      });
    }

    // Both reads move together: the editor's rows AND the detector the
    // FR-001 warning hangs off.
    await waitFor(() =>
      expect(testMocks.invalidateSetupState).toHaveBeenCalledWith({
        placeId: PLACE_ID,
      }),
    );
    expect(testMocks.invalidateAvailability).toHaveBeenCalledWith({
      placeId: PLACE_ID,
    });
  });

  it("threads the default calendar's id when the detector reports one", async () => {
    setupState = {
      configured: false,
      calendarCount: 1,
      defaultCalendarId: "cal-main",
    };
    calendarRows = [{ id: "cal-main", name: "Main Room" }];
    renderModal();

    fireEvent.click(screen.getByTestId("hours-preset-weekends"));
    await waitFor(() =>
      expect(testMocks.upsertAsync).toHaveBeenCalledTimes(2),
    );
    for (const call of testMocks.upsertAsync.mock.calls) {
      expect(call[0].calendarId).toBe("cal-main");
    }
  });

  it("disables every preset while one is writing — no doubled schedules", async () => {
    let release: (v: unknown) => void = () => {};
    testMocks.upsertAsync.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    renderModal();

    fireEvent.click(screen.getByTestId("hours-preset-weekends"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("hours-preset-weekends") as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByTestId("hours-preset-every_night") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // A click on a disabled preset fires nothing extra.
    fireEvent.click(screen.getByTestId("hours-preset-every_night"));
    expect(testMocks.upsertAsync).toHaveBeenCalledTimes(1);

    // Drain the sequential writes (weekends = 2 rows) so the component's
    // state updates land inside the test, not after teardown.
    release({});
    await waitFor(() => expect(testMocks.upsertAsync).toHaveBeenCalledTimes(2));
    release({});
    await waitFor(() =>
      expect(testMocks.invalidateSetupState).toHaveBeenCalled(),
    );
  });

  it("a mid-preset failure surfaces a toast and still refreshes both reads — partial rows are real", async () => {
    testMocks.upsertAsync
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("nope"));
    renderModal();

    fireEvent.click(screen.getByTestId("hours-preset-weekends"));
    await waitFor(() => expect(testMocks.toastDanger).toHaveBeenCalled());
    expect(testMocks.invalidateAvailability).toHaveBeenCalled();
    expect(testMocks.invalidateSetupState).toHaveBeenCalled();
  });
});
