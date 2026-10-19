import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Venue-side decision on an unconfirmed third-party listing (venue-confirmation
 * spec, docs/specs/2026-08-27 "Venue calendar"). Pins: both actions offered;
 * Confirm calls the mutation with the eventId and refreshes both admin reads;
 * Not mine demands a reason before it calls withdraw, sends the trimmed reason,
 * and refreshes; failures surface as a toast and keep the dialog open.
 */

const { state } = vi.hoisted(() => ({
  state: {
    confirmMutate: vi.fn(),
    withdrawMutate: vi.fn(),
    confirmPending: false,
    withdrawPending: false,
    confirmOpts: null as null | { onSuccess: () => void; onError: (e: unknown) => void },
    withdrawOpts: null as null | { onSuccess: () => void; onError: (e: unknown) => void },
    invalidateVenueCalendar: vi.fn(() => Promise.resolve()),
    invalidateCalendarEventsAdmin: vi.fn(() => Promise.resolve()),
    toastDanger: vi.fn(),
    toastWarning: vi.fn(),
    toastSuccess: vi.fn(),
    /** Every `open` value the Modal stand-in was rendered with, in order. */
    modalOpens: [] as boolean[],
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getVenueCalendar: { invalidate: state.invalidateVenueCalendar },
        getCalendarEventsAdmin: { invalidate: state.invalidateCalendarEventsAdmin },
      },
    }),
    venueConfirmation: {
      confirm: {
        useMutation: (opts: typeof state.confirmOpts) => {
          state.confirmOpts = opts;
          return { mutate: state.confirmMutate, isPending: state.confirmPending };
        },
      },
      withdraw: {
        useMutation: (opts: typeof state.withdrawOpts) => {
          state.withdrawOpts = opts;
          return { mutate: state.withdrawMutate, isPending: state.withdrawPending };
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("tamagui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@th/ui", async () => {
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) => {
    state.modalOpens.push(open);
    return open ? <div role="dialog">{children}</div> : null;
  };
  Modal.Panel = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  Modal.Header = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div>
      <h2>{title}</h2>
      {subtitle && <p data-testid="dialog-subtitle">{subtitle}</p>}
    </div>
  );
  Modal.Body = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Modal.Footer = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

  return {
    Modal,
    // Forwards `disabled` and every aria-*/data-* — a mock that drops them
    // cannot catch a pending state that never disables, or a testid that
    // stops being emitted.
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: { children?: ReactNode; onPress?: () => void; disabled?: boolean } & Record<
      string,
      unknown
    >) => (
      <button type="button" onClick={onPress} disabled={disabled} {...pickDomProps(rest)}>
        {children}
      </button>
    ),
    Text: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
      <span {...pickDomProps(rest)}>{children}</span>
    ),
    CharCountTextarea: ({
      id,
      value,
      onChange,
      maxLength,
      disabled,
      error,
      ariaDescribedBy,
      testIdBase,
    }: {
      id?: string;
      value: string;
      onChange: (v: string) => void;
      maxLength: number;
      disabled?: boolean;
      error?: boolean;
      ariaDescribedBy?: string;
      testIdBase?: string;
    }) => (
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy}
        data-testid={testIdBase ? `${testIdBase}-textarea` : undefined}
      />
    ),
    useFormatters: () => ({ dateTime: () => "Sat, Oct 3, 8:00 PM" }),
    useNotify: () => ({
      toast: {
        danger: state.toastDanger,
        warning: state.toastWarning,
        success: state.toastSuccess,
      },
    }),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
  };
});

import enMessages from "@/i18n/messages/en";
import {
  NOT_MINE_REASON_MAX,
  VenueEventConfirmDialog,
} from "../VenueEventConfirmDialog";

const target = {
  id: "evt-1",
  title: "Willa & the Wolves",
  startsAt: new Date("2026-10-03T20:00:00"),
  venueConfirmed: false,
};
const confirmedTarget = { ...target, venueConfirmed: true };

beforeEach(() => {
  state.confirmMutate.mockReset();
  state.withdrawMutate.mockReset();
  state.invalidateVenueCalendar.mockClear();
  state.invalidateCalendarEventsAdmin.mockClear();
  state.toastDanger.mockReset();
  state.toastWarning.mockReset();
  state.toastSuccess.mockReset();
  state.confirmPending = false;
  state.withdrawPending = false;
  state.modalOpens = [];
});

describe("VenueEventConfirmDialog", () => {
  it("renders nothing without a target", () => {
    render(<VenueEventConfirmDialog event={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing flips `open` to false and keeps the Modal mounted, so its focus-restore can run", () => {
    const { rerender } = render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    expect(state.modalOpens.at(-1)).toBe(true);
    const rendersWhileOpen = state.modalOpens.length;

    rerender(<VenueEventConfirmDialog event={null} onClose={vi.fn()} />);
    // Rendered again — with open=false — rather than returning null.
    expect(state.modalOpens.length).toBeGreaterThan(rendersWhileOpen);
    expect(state.modalOpens.at(-1)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reopening starts over at the two actions with an empty reason", () => {
    const { rerender } = render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));
    fireEvent.change(screen.getByTestId("venue-event-not-mine-reason-textarea"), {
      target: { value: "half-typed" },
    });

    rerender(<VenueEventConfirmDialog event={null} onClose={vi.fn()} />);
    // A fresh target object per press, as VenueCalendar mints one.
    rerender(<VenueEventConfirmDialog event={{ ...target }} onClose={vi.fn()} />);
    expect(screen.getByTestId("venue-event-confirm")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));
    expect(screen.getByTestId("venue-event-not-mine-reason-textarea")).toHaveValue("");
  });

  it("names the event, states it is unconfirmed, and offers exactly Confirm and Not mine", () => {
    render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Willa & the Wolves" })).toBeInTheDocument();
    expect(screen.getByTestId("dialog-subtitle")).toHaveTextContent("Sat, Oct 3, 8:00 PM");
    expect(screen.getByText("admin.venueCalUnconfirmed")).toBeInTheDocument();
    expect(screen.getByText("admin.venueCalUnconfirmedHelp")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "admin.venueCalNotMine",
      "admin.venueCalConfirm",
    ]);
    // The reason form is not on screen until "Not mine" is chosen.
    expect(screen.queryByTestId("venue-event-not-mine-reason-textarea")).toBeNull();
  });

  it("falls back to the untitled label for a nameless event", () => {
    render(
      <VenueEventConfirmDialog event={{ ...target, title: null }} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "admin.ecUntitled" })).toBeInTheDocument();
  });

  it("Confirm calls the mutation with the eventId; success refreshes both admin reads and closes", () => {
    const onClose = vi.fn();
    render(<VenueEventConfirmDialog event={target} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("venue-event-confirm"));
    // A confirmation vouches for the date the dialog shows.
    expect(state.confirmMutate).toHaveBeenCalledWith({
      eventId: "evt-1",
      expectedStartsAt: target.startsAt.toISOString(),
    });
    expect(state.withdrawMutate).not.toHaveBeenCalled();

    expect(state.toastSuccess).not.toHaveBeenCalled();
    state.confirmOpts?.onSuccess();
    expect(state.invalidateVenueCalendar).toHaveBeenCalledTimes(1);
    expect(state.invalidateCalendarEventsAdmin).toHaveBeenCalledTimes(1);
    expect(state.toastSuccess).toHaveBeenCalledTimes(1);
    expect(state.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.venueCalConfirmed" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Not mine asks for a reason and refuses an empty one — withdraw is never called", () => {
    render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));

    const textarea = screen.getByTestId("venue-event-not-mine-reason-textarea");
    expect(textarea).toHaveAttribute("maxlength", String(NOT_MINE_REASON_MAX));
    // core BOOKING_REASON_MAX — one cap for every booking reason (FR-013).
    expect(NOT_MINE_REASON_MAX).toBe(1000);
    expect(screen.getByText("admin.venueCalNotMineHelp")).toBeInTheDocument();
    // The label is a real <label> pointing at the textarea.
    expect(screen.getByLabelText("admin.venueCalNotMineReasonLabel")).toBe(textarea);

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("venue-event-not-mine-submit"));
    expect(state.withdrawMutate).not.toHaveBeenCalled();
    const error = screen.getByTestId("venue-event-not-mine-reason-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent("admin.venueCalNotMineReasonRequired");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveAttribute("aria-describedby", error.getAttribute("id"));

    // Clear on input: editing the field removes the error.
    fireEvent.change(textarea, { target: { value: "W" } });
    expect(screen.queryByTestId("venue-event-not-mine-reason-error")).toBeNull();
    expect(textarea).not.toHaveAttribute("aria-invalid");
  });

  it("Not mine sends the trimmed reason; success refreshes and closes", () => {
    const onClose = vi.fn();
    render(<VenueEventConfirmDialog event={target} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));
    fireEvent.change(screen.getByTestId("venue-event-not-mine-reason-textarea"), {
      target: { value: "  We never booked this act.  " },
    });
    fireEvent.click(screen.getByTestId("venue-event-not-mine-submit"));
    expect(state.withdrawMutate).toHaveBeenCalledWith({
      eventId: "evt-1",
      reason: "We never booked this act.",
    });
    expect(state.confirmMutate).not.toHaveBeenCalled();

    state.withdrawOpts?.onSuccess();
    expect(state.invalidateVenueCalendar).toHaveBeenCalledTimes(1);
    expect(state.invalidateCalendarEventsAdmin).toHaveBeenCalledTimes(1);
    expect(state.toastSuccess).toHaveBeenCalledTimes(1);
    expect(state.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.venueCalNotMineDone" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Back returns to the two actions without losing the dialog", () => {
    render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));
    fireEvent.click(screen.getByTestId("venue-event-not-mine-back"));
    expect(screen.getByTestId("venue-event-confirm")).toBeInTheDocument();
    expect(screen.queryByTestId("venue-event-not-mine-reason-textarea")).toBeNull();
  });

  it("a failed mutation toasts and keeps the dialog open", () => {
    const onClose = vi.fn();
    render(<VenueEventConfirmDialog event={target} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("venue-event-confirm"));
    state.confirmOpts?.onError(new Error("FORBIDDEN"));
    expect(state.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "admin.venueCalActionFailed",
        message: "FORBIDDEN",
      }),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(state.invalidateVenueCalendar).not.toHaveBeenCalled();
    expect(state.toastSuccess).not.toHaveBeenCalled();
  });

  describe("EVENT_MOVED — the organizer moved the show after the dialog opened", () => {
    const NEW_START = "2026-10-10T20:00:00.000Z";
    const moved = (startsAt: string | null) => ({
      message: "EVENT_MOVED",
      data: {
        appCode: "EVENT_MOVED",
        code: "CONFLICT",
        meta: {
          eventId: "evt-1",
          expectedStartsAt: target.startsAt.toISOString(),
          startsAt,
        },
      },
    });

    it("switches to the new start, says why, refreshes, and the next Confirm vouches for the NEW date", () => {
      const onClose = vi.fn();
      render(<VenueEventConfirmDialog event={target} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("venue-event-confirm"));
      act(() => state.confirmOpts?.onError(moved(NEW_START)));

      expect(screen.getByTestId("venue-event-confirm-moved")).toHaveTextContent(
        "errors.eventMoved",
      );
      expect(screen.getByTestId("venue-event-confirm-moved")).toHaveAttribute(
        "role",
        "alert",
      );
      expect(state.invalidateVenueCalendar).toHaveBeenCalledTimes(1);
      expect(state.invalidateCalendarEventsAdmin).toHaveBeenCalledTimes(1);
      expect(state.toastDanger).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("venue-event-confirm"));
      expect(state.confirmMutate).toHaveBeenLastCalledWith({
        eventId: "evt-1",
        expectedStartsAt: NEW_START,
      });
    });

    it("closes with the message when the new start is unknown, so the venue reopens it from the refreshed calendar", () => {
      const onClose = vi.fn();
      render(<VenueEventConfirmDialog event={target} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("venue-event-confirm"));
      act(() => state.confirmOpts?.onError(moved(null)));

      expect(state.toastWarning).toHaveBeenCalledWith(
        expect.objectContaining({ title: "errors.eventMoved" }),
      );
      expect(state.invalidateVenueCalendar).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("a fresh open starts without the moved notice", () => {
      const { rerender } = render(
        <VenueEventConfirmDialog event={target} onClose={vi.fn()} />,
      );
      act(() => state.confirmOpts?.onError(moved(NEW_START)));
      expect(screen.getByTestId("venue-event-confirm-moved")).toBeInTheDocument();

      rerender(<VenueEventConfirmDialog event={null} onClose={vi.fn()} />);
      rerender(<VenueEventConfirmDialog event={{ ...target }} onClose={vi.fn()} />);
      expect(screen.queryByTestId("venue-event-confirm-moved")).toBeNull();
    });
  });

  describe("confirmed third-party event — withdraw-only mode", () => {
    it("states it is confirmed and offers exactly Cancel and Withdraw confirmation", () => {
      render(<VenueEventConfirmDialog event={confirmedTarget} onClose={vi.fn()} />);
      expect(screen.getByText("admin.venueCalConfirmedByVenue")).toBeInTheDocument();
      expect(screen.getByText("admin.venueCalConfirmedHelp")).toBeInTheDocument();
      expect(screen.queryByText("admin.venueCalUnconfirmed")).toBeNull();
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
        "admin.cancel",
        "admin.venueCalWithdraw",
      ]);
      expect(screen.queryByTestId("venue-event-confirm")).toBeNull();
      expect(screen.queryByTestId("venue-event-not-mine")).toBeNull();
    });

    it("Cancel closes without calling anything", () => {
      const onClose = vi.fn();
      render(<VenueEventConfirmDialog event={confirmedTarget} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("venue-event-cancel"));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(state.withdrawMutate).not.toHaveBeenCalled();
      expect(state.confirmMutate).not.toHaveBeenCalled();
    });

    it("Withdraw confirmation goes to the reason step, requires a reason, then calls withdraw; success toasts the withdrawn key", () => {
      const onClose = vi.fn();
      render(<VenueEventConfirmDialog event={confirmedTarget} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("venue-event-withdraw"));
      const textarea = screen.getByTestId("venue-event-not-mine-reason-textarea");
      expect(screen.getByLabelText("admin.venueCalNotMineReasonLabel")).toBe(textarea);
      // The "not mine" caption belongs to the other mode.
      expect(screen.queryByText("admin.venueCalNotMineHelp")).toBeNull();
      const submit = screen.getByTestId("venue-event-withdraw-submit");
      expect(submit).toHaveTextContent("admin.venueCalWithdraw");

      fireEvent.click(submit);
      expect(state.withdrawMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId("venue-event-not-mine-reason-error")).toHaveTextContent(
        "admin.venueCalNotMineReasonRequired",
      );

      fireEvent.change(textarea, { target: { value: "  Booked someone else.  " } });
      fireEvent.click(submit);
      expect(state.withdrawMutate).toHaveBeenCalledWith({
        eventId: "evt-1",
        reason: "Booked someone else.",
      });
      expect(state.confirmMutate).not.toHaveBeenCalled();

      state.withdrawOpts?.onSuccess();
      expect(state.toastSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ title: "admin.venueCalWithdrawn" }),
      );
      expect(state.invalidateVenueCalendar).toHaveBeenCalledTimes(1);
      expect(state.invalidateCalendarEventsAdmin).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("while withdraw is pending the submit reports busy with the withdrawing label", () => {
      const { rerender } = render(
        <VenueEventConfirmDialog event={confirmedTarget} onClose={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId("venue-event-withdraw"));
      // Pending begins after submit; flip the flag once on the reason step.
      state.withdrawPending = true;
      rerender(<VenueEventConfirmDialog event={confirmedTarget} onClose={vi.fn()} />);
      const submit = screen.getByTestId("venue-event-withdraw-submit");
      expect(submit).toBeDisabled();
      expect(submit).toHaveAttribute("aria-busy", "true");
      expect(submit).toHaveTextContent("admin.venueCalWithdrawing");
    });
  });

  it("while Confirm is pending both actions are disabled and the button reports busy", () => {
    state.confirmPending = true;
    render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
    const confirm = screen.getByTestId("venue-event-confirm");
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(confirm).toHaveTextContent("admin.venueCalConfirming");
    expect(screen.getByTestId("venue-event-not-mine")).toBeDisabled();
  });

  describe("a venue that hides its address", () => {
    it("says confirming shares the address with ticket holders, and wires it to Confirm", () => {
      render(
        <VenueEventConfirmDialog event={target} onClose={vi.fn()} venueWithholdsAddress />,
      );
      const note = screen.getByTestId("venue-event-confirm-address-note");
      expect(note).toHaveTextContent("admin.venueCalConfirmSharesAddress");
      // The copy states the real rule: the LATER of the event's own reveal
      // and a day before the start — and Never still wins. A flat "a day
      // before" overstated it.
      // `Messages` types each namespace as a generic MessageNode, so read the
      // key the way RecurrenceBuilder.inlineStart.test does.
      const copy = (enMessages.admin as unknown as Record<string, unknown>)
        .venueCalConfirmSharesAddress;
      expect(typeof copy).toBe("string");
      expect(copy).toContain("no earlier than a day before it starts");
      expect(copy).toContain("not at all if the event never reveals it");
      // The disclosure is what the press does, so it describes the button.
      const confirm = screen.getByTestId("venue-event-confirm");
      expect(note.id).not.toBe("");
      expect(confirm).toHaveAttribute("aria-describedby", note.id);
    });

    it("says nothing about the address at a venue that publishes it", () => {
      render(<VenueEventConfirmDialog event={target} onClose={vi.fn()} />);
      expect(screen.queryByTestId("venue-event-confirm-address-note")).toBeNull();
      expect(screen.getByTestId("venue-event-confirm")).not.toHaveAttribute(
        "aria-describedby",
      );
    });

    it("leaves the note off the withdraw side, which shares nothing", () => {
      render(
        <VenueEventConfirmDialog
          event={confirmedTarget}
          onClose={vi.fn()}
          venueWithholdsAddress
        />,
      );
      expect(screen.queryByTestId("venue-event-confirm-address-note")).toBeNull();
    });
  });
});
