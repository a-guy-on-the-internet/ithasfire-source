import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue's vouch, decided in the thread (`VenueConfirmationActions`,
 * venue-confirmation spec docs/specs/2026-08-27 "Thread").
 *
 * Pins: WHICH action the slot offers per projected state (the pure table,
 * then the render); that confirming an event-less booking asks who owns it,
 * defaults by intent, and sends `ownerOverride`; that confirming an EXISTING
 * event sends no override; that withdraw demands a reason before it calls,
 * sends it trimmed, and targets the event; the two refusals the venue can
 * act on (open challenge → warning toast with the shared hold copy; not
 * accepted → "accept first"); and that success refreshes the row, the thread
 * and the agreement.
 *
 * Only chrome is mocked (tamagui, @th/ui, trpc). The decision helpers are
 * exercised for real.
 */

const { state } = vi.hoisted(() => ({
  state: {
    confirmMutate: vi.fn(),
    withdrawMutate: vi.fn(),
    confirmOpts: null as null | { onSuccess: () => void; onError: (e: unknown) => void },
    withdrawOpts: null as null | { onSuccess: () => void; onError: (e: unknown) => void },
    listInvalidate: vi.fn(),
    messagesInvalidate: vi.fn(),
    agreementInvalidate: vi.fn(),
    toastDanger: vi.fn(),
    toastWarning: vi.fn(),
    toastSuccess: vi.fn(),
    /** What `places.getPlacePublic` answers; undefined = loading / failed. */
    placePublic: { place: { locationIsExact: false } } as
      | undefined
      | { place: { locationIsExact: boolean } },
    placePublicArgs: [] as Array<{ input: unknown; opts: { enabled?: boolean } }>,
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: { invalidate: state.listInvalidate },
        messages: { list: { invalidate: state.messagesInvalidate } },
      },
      bookingAgreements: { get: { invalidate: state.agreementInvalidate } },
    }),
    places: {
      getPlacePublic: {
        useQuery: (input: unknown, opts: { enabled?: boolean }) => {
          state.placePublicArgs.push({ input, opts });
          return { data: opts.enabled ? state.placePublic : undefined };
        },
      },
    },
    venueConfirmation: {
      confirm: {
        useMutation: (opts: typeof state.confirmOpts) => {
          state.confirmOpts = opts;
          return { mutate: state.confirmMutate, isPending: false };
        },
      },
      withdraw: {
        useMutation: (opts: typeof state.withdrawOpts) => {
          state.withdrawOpts = opts;
          return { mutate: state.withdrawMutate, isPending: false };
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("tamagui", () => {
  const Stack = ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => (
    <div data-testid={rest["data-testid"] as string | undefined}>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("lucide-react", () => ({
  CalendarCheck: () => <span />,
  CalendarX: () => <span />,
}));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");

  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null;
  Modal.Panel = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  Modal.Header = ({ title }: { title: string }) => <h2>{title}</h2>;
  Modal.Body = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Modal.Footer = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

  // The radio group hands its value + setter down through context, like the
  // real Tamagui RadioGroup does, so a click on an item changes the group.
  const RadioCtx = React.createContext<{
    value: string;
    onValueChange: (v: string) => void;
  }>({ value: "", onValueChange: () => {} });
  const RadioGroupField = ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
    [k: string]: unknown;
  }) => (
    <RadioCtx.Provider value={{ value, onValueChange }}>
      <div role="radiogroup" {...pickDomProps(rest)}>
        {children}
      </div>
    </RadioCtx.Provider>
  );
  const Radio = ({
    value,
    label,
    testIdBase,
    disabled,
  }: {
    value: string;
    label: ReactNode;
    testIdBase?: string;
    disabled?: boolean;
  }) => {
    const ctx = React.useContext(RadioCtx);
    return (
      <button
        type="button"
        role="radio"
        aria-checked={ctx.value === value}
        disabled={disabled}
        data-testid={testIdBase}
        onClick={() => ctx.onValueChange(value)}
      >
        {label}
      </button>
    );
  };

  return {
    Modal,
    Radio,
    RadioGroupField,
    Button: ({
      children,
      onPress,
      disabled,
      testID,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    } & Record<string, unknown>) => (
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        data-testid={testID}
        {...pickDomProps(rest)}
      >
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
    useNotify: () => ({
      toast: {
        danger: state.toastDanger,
        warning: state.toastWarning,
        success: state.toastSuccess,
      },
    }),
    useTranslations: () => (key: string) => key,
  };
});

import {
  VenueConfirmationActions,
  defaultOwnerSideForIntent,
  venueConfirmationErrorNotice,
  venueConfirmationOffer,
} from "../VenueConfirmationActions";
import { shouldRetryPlacePrivacyRead } from "@/lib/places/venue-location-ceiling";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const AGREEMENT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
/** The event start the thread's rail shows — what Confirm vouches for. */
const STARTS_AT = new Date("2026-10-03T20:00:00.000Z");
const BASE = `booking-thread-${REQUEST_ID}-venue-confirmation`;

type Props = Parameters<typeof VenueConfirmationActions>[0];

function renderActions(overrides: Partial<Props> = {}) {
  const props: Props = {
    bookingRequestId: REQUEST_ID,
    requestStatus: "ACCEPTED",
    agreementId: AGREEMENT_ID,
    intent: "PERFORM",
    eventStartsAt: STARTS_AT,
    venueConfirmation: { state: "unconfirmed", eventId: EVENT_ID, ownerSide: "requester" },
    placeId: PLACE_ID,
    builtFromEvent: true,
    testIdBase: `booking-thread-${REQUEST_ID}`,
    ...overrides,
  };
  return render(<VenueConfirmationActions {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.confirmOpts = null;
  state.withdrawOpts = null;
  state.placePublic = { place: { locationIsExact: false } };
  state.placePublicArgs = [];
});

describe("venueConfirmationOffer (the decision table)", () => {
  const accepted = { requestStatus: "ACCEPTED" as const, agreementId: AGREEMENT_ID, builtFromEvent: true };

  it("offers Confirm only for a request built from an event — Withdraw stays (FR-011)", () => {
    const notFromEvent = { ...accepted, builtFromEvent: false };
    expect(venueConfirmationOffer({ ...notFromEvent, state: "unconfirmed", ownerSide: "requester" })).toBeNull();
    expect(venueConfirmationOffer({ ...notFromEvent, state: "withdrawn", ownerSide: "requester" })).toBeNull();
    expect(venueConfirmationOffer({ ...notFromEvent, state: "none", ownerSide: null })).toBeNull();
    // Withdraw is per event: a stamped requester-owned event can still be withdrawn.
    expect(venueConfirmationOffer({ ...notFromEvent, state: "confirmed", ownerSide: "requester" })).toBe("withdraw");
  });

  it("offers Confirm on an unconfirmed or withdrawn event", () => {
    expect(venueConfirmationOffer({ ...accepted, state: "unconfirmed", ownerSide: "requester" })).toBe("confirm");
    expect(venueConfirmationOffer({ ...accepted, state: "withdrawn", ownerSide: "requester" })).toBe("confirm");
  });

  it("offers Confirm (a mint) on an ACCEPTED booking with an agreement and no event — and not without either", () => {
    expect(venueConfirmationOffer({ ...accepted, state: "none", ownerSide: null })).toBe("confirm");
    expect(venueConfirmationOffer({ ...accepted, state: "none", ownerSide: null, agreementId: null })).toBeNull();
    expect(venueConfirmationOffer({ ...accepted, state: "none", ownerSide: null, requestStatus: "VIEWED" })).toBeNull();
  });

  it("offers Withdraw only on a REQUESTER-owned confirmed event — a venue-owned one refuses it server-side", () => {
    expect(venueConfirmationOffer({ ...accepted, state: "confirmed", ownerSide: "requester" })).toBe("withdraw");
    expect(venueConfirmationOffer({ ...accepted, state: "confirmed", ownerSide: "place" })).toBeNull();
  });

  it("offers nothing on a closed request, whatever the event says", () => {
    for (const requestStatus of ["DECLINED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(
        venueConfirmationOffer({ ...accepted, requestStatus, state: "unconfirmed", ownerSide: "requester" }),
      ).toBeNull();
    }
  });

  it("offers nothing for a state it has never heard of", () => {
    expect(venueConfirmationOffer({ ...accepted, state: "brand-new", ownerSide: null })).toBeNull();
  });

  it("defaults the owner by intent: PERFORM → venue, RENT / USE → they own it", () => {
    expect(defaultOwnerSideForIntent("PERFORM")).toBe("place");
    expect(defaultOwnerSideForIntent("RENT")).toBe("requester");
    expect(defaultOwnerSideForIntent("USE")).toBe("requester");
  });
});

describe("venueConfirmationErrorNotice", () => {
  it("maps an open challenge (CONFLICT / HOLD_LINE_HAS_OPEN_CHALLENGE) to the shared hold copy as a warning", () => {
    expect(
      venueConfirmationErrorNotice({ message: "x", data: { appCode: "HOLD_LINE_HAS_OPEN_CHALLENGE" } }),
    ).toEqual({ tone: "warning", key: "errors.holdLineHasOpenChallenge" });
    expect(venueConfirmationErrorNotice({ message: "HOLD_LINE_HAS_OPEN_CHALLENGE" })).toEqual({
      tone: "warning",
      key: "errors.holdLineHasOpenChallenge",
    });
  });

  it("maps INVALID_STATUS booking_request_not_accepted to 'accept first'", () => {
    expect(
      venueConfirmationErrorNotice({
        message: "booking_request_not_accepted",
        data: { appCode: "INVALID_STATUS" },
      }),
    ).toEqual({ tone: "danger", key: "errors.venueConfirmationRequestNotAccepted" });
  });

  it("leaves everything else to formatErrorMessage", () => {
    expect(venueConfirmationErrorNotice(new Error("PLACE_NOT_FOUND"))).toBeNull();
    expect(venueConfirmationErrorNotice(null)).toBeNull();
  });
});

describe("VenueConfirmationActions", () => {
  it("renders nothing on a venue-owned confirmed event", () => {
    const { container } = renderActions({
      venueConfirmation: { state: "confirmed", eventId: EVENT_ID, ownerSide: "place" },
    });
    expect(container.innerHTML).toBe("");
  });

  it("offers Confirm on an unconfirmed event and sends NO owner override for it", () => {
    renderActions();
    expect(screen.getByTestId(`${BASE}-state`).textContent).toBe("booking.vcStateUnconfirmed");
    expect(screen.queryByTestId(`${BASE}-withdraw`)).toBeNull();

    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    // An existing event keeps its owner: no radio, no override.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm-submit`));
    // …and vouches for the date the thread shows.
    expect(state.confirmMutate).toHaveBeenCalledWith({
      bookingRequestId: REQUEST_ID,
      expectedStartsAt: STARTS_AT.toISOString(),
    });
  });

  it("confirming an event-less ACCEPTED booking asks who owns it, defaults by intent, and sends ownerOverride", () => {
    renderActions({
      intent: "RENT",
      eventStartsAt: null,
      venueConfirmation: { state: "none", eventId: null, ownerSide: null },
    });
    expect(screen.getByTestId(`${BASE}-state`).textContent).toBe("booking.vcStateNone");
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));

    // RENT → they own it, by default.
    expect(screen.getByTestId(`${BASE}-owner-requester`).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId(`${BASE}-owner-venue`).getAttribute("aria-checked")).toBe("false");

    // The venue overrides.
    fireEvent.click(screen.getByTestId(`${BASE}-owner-venue`));
    fireEvent.click(screen.getByTestId(`${BASE}-confirm-submit`));
    // No event, so no date on screen: the field is still sent (core requires
    // it and ignores it on a mint) as a value no real start can equal.
    expect(state.confirmMutate).toHaveBeenCalledWith({
      bookingRequestId: REQUEST_ID,
      ownerOverride: "place",
      expectedStartsAt: new Date(0).toISOString(),
    });
  });

  it("PERFORM defaults the owner to the venue", () => {
    renderActions({
      intent: "PERFORM",
      eventStartsAt: null,
      venueConfirmation: { state: "none", eventId: null, ownerSide: null },
    });
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(screen.getByTestId(`${BASE}-owner-venue`).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId(`${BASE}-confirm-submit`));
    // No event, so no date on screen: the field is still sent (core requires
    // it and ignores it on a mint) as a value no real start can equal.
    expect(state.confirmMutate).toHaveBeenCalledWith({
      bookingRequestId: REQUEST_ID,
      ownerOverride: "place",
      expectedStartsAt: new Date(0).toISOString(),
    });
  });

  it("offers Confirm again after a withdrawal", () => {
    renderActions({
      venueConfirmation: { state: "withdrawn", eventId: EVENT_ID, ownerSide: "requester" },
    });
    expect(screen.getByTestId(`${BASE}-state`).textContent).toBe("booking.vcStateWithdrawn");
    expect(screen.getByTestId(`${BASE}-confirm`)).toBeTruthy();
  });

  it("withdraw demands a reason, then sends it trimmed against the EVENT", () => {
    renderActions({
      venueConfirmation: { state: "confirmed", eventId: EVENT_ID, ownerSide: "requester" },
    });
    expect(screen.queryByTestId(`${BASE}-confirm`)).toBeNull();
    fireEvent.click(screen.getByTestId(`${BASE}-withdraw`));

    fireEvent.click(screen.getByTestId(`${BASE}-withdraw-submit`));
    expect(state.withdrawMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${BASE}-reason-error`).textContent).toBe(
      "booking.vcWithdrawReasonRequired",
    );

    const textarea = screen.getByTestId(`${BASE}-reason-textarea`);
    fireEvent.change(textarea, { target: { value: "  Double-booked that night.  " } });
    // Clear on input.
    expect(screen.queryByTestId(`${BASE}-reason-error`)).toBeNull();
    fireEvent.click(screen.getByTestId(`${BASE}-withdraw-submit`));
    expect(state.withdrawMutate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      reason: "Double-booked that night.",
    });
  });

  it("an open challenge surfaces as a WARNING with the shared hold copy, and the dialog stays open", () => {
    renderActions();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    act(() =>
      state.confirmOpts?.onError({
        message: "HOLD_LINE_HAS_OPEN_CHALLENGE",
        data: { appCode: "HOLD_LINE_HAS_OPEN_CHALLENGE", code: "CONFLICT" },
      }),
    );
    expect(state.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "errors.holdLineHasOpenChallenge" }),
    );
    expect(state.toastDanger).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("'not accepted' says to accept the request first", () => {
    renderActions({ venueConfirmation: { state: "none", eventId: null, ownerSide: null } });
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    act(() =>
      state.confirmOpts?.onError({
        message: "booking_request_not_accepted",
        data: { appCode: "INVALID_STATUS" },
      }),
    );
    expect(state.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({ message: "errors.venueConfirmationRequestNotAccepted" }),
    );
  });

  it("EVENT_MOVED: says the date changed, refreshes so the rail shows the new one, and closes", () => {
    renderActions();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    act(() =>
      state.confirmOpts?.onError({
        message: "EVENT_MOVED",
        data: {
          appCode: "EVENT_MOVED",
          code: "CONFLICT",
          meta: {
            eventId: EVENT_ID,
            expectedStartsAt: STARTS_AT.toISOString(),
            startsAt: "2026-10-10T20:00:00.000Z",
          },
        },
      }),
    );
    expect(state.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "errors.eventMoved" }),
    );
    expect(state.toastDanger).not.toHaveBeenCalled();
    expect(state.listInvalidate).toHaveBeenCalled();
    expect(state.messagesInvalidate).toHaveBeenCalledWith({ bookingRequestId: REQUEST_ID });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("won't confirm an existing event while its date isn't on screen", () => {
    renderActions({ eventStartsAt: null });
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    const submit = screen.getByTestId(`${BASE}-confirm-submit`);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(state.confirmMutate).not.toHaveBeenCalled();
  });

  it("success refreshes the row, the thread's ledger and the agreement, toasts, and closes", () => {
    renderActions();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => state.confirmOpts?.onSuccess());
    expect(state.listInvalidate).toHaveBeenCalled();
    expect(state.messagesInvalidate).toHaveBeenCalledWith({ bookingRequestId: REQUEST_ID });
    expect(state.agreementInvalidate).toHaveBeenCalledWith({ agreementId: AGREEMENT_ID });
    expect(state.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "booking.vcToastConfirmed" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("VenueConfirmationActions — absent projection", () => {
  it("treats a missing stance as 'no event' and renders nothing on a non-accepted row", () => {
    const { container } = renderActions({
      requestStatus: "VIEWED",
      venueConfirmation: undefined,
    });
    expect(container.innerHTML).toBe("");
  });
});

describe("VenueConfirmationActions — the address disclosure", () => {
  const STAMP_KEY = "admin.venueCalConfirmSharesAddress";
  const OWN_EVENT_KEY = "booking.vcConfirmSharesAddressOwnEvent";
  const MINT = { state: "none", eventId: null, ownerSide: null } as const;

  /** The note, found INSIDE the confirm dialog — not just anywhere. */
  function noteInConfirmDialog() {
    const dialog = screen.getByTestId(`${BASE}-confirm-dialog`);
    return dialog.querySelector(`[data-testid="${BASE}-address-note"]`);
  }

  it("withheld venue + existing event: the stamp copy, and Confirm is described by it", () => {
    renderActions();
    // Nothing until the dialog opens.
    expect(screen.queryByTestId(`${BASE}-address-note`)).toBeNull();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));

    const note = noteInConfirmDialog();
    expect(note?.textContent).toBe(STAMP_KEY);
    const id = note?.getAttribute("id");
    expect(id).toBeTruthy();
    expect(screen.getByTestId(`${BASE}-confirm-submit`).getAttribute("aria-describedby")).toBe(id);
    // The read is the one the venue calendar makes, for this row's venue.
    expect(state.placePublicArgs.at(-1)).toEqual({
      input: { placeId: PLACE_ID },
      // One retry, transient failures only (a NOT_FOUND is final).
      opts: expect.objectContaining({
        enabled: true,
        staleTime: 60_000,
        retry: shouldRetryPlacePrivacyRead,
      }),
    });
  });

  it("withheld venue + a mint: the venue-owned copy, and it follows the owner radio live", () => {
    renderActions({ intent: "PERFORM", eventStartsAt: null, venueConfirmation: MINT });
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(noteInConfirmDialog()?.textContent).toBe(OWN_EVENT_KEY);

    fireEvent.click(screen.getByTestId(`${BASE}-owner-requester`));
    expect(noteInConfirmDialog()?.textContent).toBe(STAMP_KEY);

    fireEvent.click(screen.getByTestId(`${BASE}-owner-venue`));
    expect(noteInConfirmDialog()?.textContent).toBe(OWN_EVENT_KEY);
    expect(
      screen.getByTestId(`${BASE}-confirm-submit`).getAttribute("aria-describedby"),
    ).toBe(noteInConfirmDialog()?.getAttribute("id"));
  });

  it("a venue that publishes its address gets no note and no description", () => {
    state.placePublic = { place: { locationIsExact: true } };
    renderActions();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(screen.queryByTestId(`${BASE}-address-note`)).toBeNull();
    expect(screen.getByTestId(`${BASE}-confirm-submit`).hasAttribute("aria-describedby")).toBe(false);
  });

  it("an unanswered read (loading / failed) counts as withheld", () => {
    state.placePublic = undefined;
    renderActions();
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(noteInConfirmDialog()?.textContent).toBe(STAMP_KEY);
  });

  it("a row with no place fails toward telling, and makes no read", () => {
    state.placePublic = { place: { locationIsExact: true } };
    renderActions({ placeId: null });
    fireEvent.click(screen.getByTestId(`${BASE}-confirm`));
    expect(noteInConfirmDialog()?.textContent).toBe(STAMP_KEY);
    expect(state.placePublicArgs.every((c) => c.opts.enabled === false)).toBe(true);
  });

  it("the withdraw dialog never carries it — withdrawing shares nothing", () => {
    renderActions({
      venueConfirmation: { state: "confirmed", eventId: EVENT_ID, ownerSide: "requester" },
    });
    fireEvent.click(screen.getByTestId(`${BASE}-withdraw`));
    expect(screen.getByTestId(`${BASE}-withdraw-dialog`)).toBeTruthy();
    expect(screen.queryByTestId(`${BASE}-address-note`)).toBeNull();
    // …and the privacy read is not even made while only Withdraw is on offer.
    expect(state.placePublicArgs.every((c) => c.opts.enabled === false)).toBe(true);
  });
});
