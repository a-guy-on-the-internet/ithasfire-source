import { forwardRef, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue's hold line, on its own (booking-holds FR-012). The inbox suite
 * pins WHERE the strip mounts and how the row follows a write; this one pins
 * the strip's own mechanics — form floor and payloads, the confirm outcome's
 * focus, the retryable-race toast, the end-of-line no-op, and the gating of
 * "Place hold".
 */

const mocks = vi.hoisted(() => ({
  // Every mutation in this suite resolves synchronously, so `isPending` is
  // false throughout — except when a test flips this, which is the only way
  // to reach the strip's `busy` branch (reset in `beforeEach`).
  releasePending: false,
  reorder: vi.fn(),
  challenge: vi.fn(),
  extend: vi.fn(),
  release: vi.fn(),
  book: vi.fn(),
  sendTerms: vi.fn(),
  agreementInvalidate: vi.fn(),
  listInvalidate: vi.fn(),
  messagesInvalidate: vi.fn(),
  holdsInvalidate: vi.fn(),
  calendarInvalidate: vi.fn(),
  calendarEventsInvalidate: vi.fn(),
  countOpenInvalidate: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: { invalidate: mocks.listInvalidate },
        messages: { list: { invalidate: mocks.messagesInvalidate } },
        countOpen: { invalidate: mocks.countOpenInvalidate },
      },
      bookingHolds: { listForRequest: { invalidate: mocks.holdsInvalidate } },
      bookingAgreements: { get: { invalidate: mocks.agreementInvalidate } },
      places: {
        getVenueCalendar: { invalidate: mocks.calendarInvalidate },
        getCalendarEventsAdmin: { invalidate: mocks.calendarEventsInvalidate },
      },
    }),
    bookingHolds: {
      reorder: { useMutation: () => ({ mutate: mocks.reorder, isPending: false }) },
      challenge: { useMutation: () => ({ mutate: mocks.challenge, isPending: false }) },
      extend: { useMutation: () => ({ mutate: mocks.extend, isPending: false }) },
      release: {
        useMutation: () => ({ mutate: mocks.release, isPending: mocks.releasePending }),
      },
      bookNightWithoutTerms: { useMutation: () => ({ mutate: mocks.book, isPending: false }) },
    },
    bookingAgreements: {
      sendTerms: { useMutation: () => ({ mutate: mocks.sendTerms, isPending: false }) },
    },
  },
}));

const STACK_PASSTHROUGH = [
  "role",
  "aria-label",
  "aria-hidden",
  "data-status",
] as const;

vi.mock("tamagui", () => {
  const passthrough = (props: Record<string, unknown>) => {
    const passed: Record<string, unknown> = {};
    for (const key of STACK_PASSTHROUGH) if (key in props) passed[key] = props[key];
    return passed;
  };
  /**
   * `tag` is honoured, not flattened to a div. A <button>'s content model is
   * phrasing content only, so whether the glyph inside the add-row is a span
   * or a div is a real difference that React never warns about — flattening
   * it here would make that difference untestable.
   */
  const Stack = ({ tag, ...props }: Record<string, unknown>) => {
    const El = (tag as "div" | "span" | undefined) ?? "div";
    return (
      <El
        data-testid={(props.testID ?? props["data-testid"]) as string | undefined}
        onClick={props.onPress as (() => void) | undefined}
        {...passthrough(props)}
      >
        {props.children as ReactNode}
      </El>
    );
  };
  /**
   * A styled `tag: "button"` renders a REAL button here, not a div: the
   * add-row's accessible name, its `disabled` state and the `type="button"`
   * that keeps it out of a form submit are exactly what this suite pins, and
   * a div would fake all three. The `type` default mirrors the DOM's, so a
   * call site that forgets it fails the assertion rather than passing.
   */
  const ButtonStack = (props: Record<string, unknown>) => (
    <button
      type={(props.type as "button" | "submit" | undefined) ?? "submit"}
      data-testid={(props.testID ?? props["data-testid"]) as string | undefined}
      disabled={props.disabled as boolean | undefined}
      onClick={props.onPress as (() => void) | undefined}
      // `styled()`'s variants never reach the DOM, so a variant the component
      // sets is otherwise unobservable here — delete the variant and every
      // test still passes. Mirroring it onto `data-*` pins the component's
      // DECISION; whether the rule actually paints is the visual pass's job.
      data-divided={String(Boolean(props.divided))}
      {...passthrough(props)}
    >
      {props.children as ReactNode}
    </button>
  );
  return {
    XStack: Stack,
    YStack: Stack,
    styled: (_base: unknown, config?: { tag?: string }) => {
      if (config?.tag === "button") return ButtonStack;
      const Tagged = (props: Record<string, unknown>) => (
        <Stack tag={config?.tag} {...props} />
      );
      return Tagged;
    },
  };
});

vi.mock("@th/ui", () => ({
  /**
   * DISABLED IS `aria-disabled`, NOT THE NATIVE ATTRIBUTE — measured, not
   * assumed. `@th/ui` Button wraps Tamagui's `Button`, for which `disabled` is
   * an RN prop; Tamagui suppresses the press itself and emits ARIA rather than
   * the DOM attribute. Rendering the real atom in jsdom gives:
   *
   *   <button role="button" aria-disabled="true" tabindex="-1" …>
   *   hasAttribute("disabled") === false   ·   el.disabled === false
   *
   * and the same was confirmed in the browser on four independent samples,
   * including the sign-in page's `type="submit"`. (`tabindex` was "0" until
   * 2026-09-25, when the atom took disabled Buttons out of the Tab order;
   * `-1` rather than native `disabled` so a button that goes disabled while
   * busy keeps the focus the user just gave it.)
   *
   * This mock used to emit the native attribute, which made
   * `expect(btn).toBeDisabled()` pass against a contract production does not
   * have — backwards in BOTH directions: it would have stayed green if the
   * atom stopped disabling at all, and gone red if someone correctly asserted
   * `aria-disabled`. That is the "@th/ui Button mocks lie" hazard, and it sat
   * under the Confirm-and-Challenge-disabled behaviour that is the whole point
   * of the unclaimed-inquiry work.
   *
   * `onClick` is suppressed when disabled because the real thing suppresses
   * the press (verified in the browser: clicking a disabled Confirm opens no
   * dialog, yet the click lands and the button takes focus — which a native
   * `<button disabled>` could never do).
   *
   * `tabIndex` mirrors the real atom: -1 when disabled, and a caller's own
   * `tabIndex` wins. The owner ruled on this design-system-wide (2026-09-25);
   * it is pinned against the REAL component in `packages/ui`'s
   * `Button.theme.test.tsx`, so this mock only has to stop lying about it.
   */
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    "aria-label": ariaLabel,
    "aria-hidden": ariaHidden,
    tabIndex,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    "aria-label"?: string;
    "aria-hidden"?: boolean;
    tabIndex?: number;
  }) => (
    <button
      type="button"
      data-testid={testID}
      aria-disabled={disabled ? "true" : undefined}
      onClick={disabled ? undefined : onPress}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      tabIndex={tabIndex ?? (disabled ? -1 : undefined)}
    >
      {children}
    </button>
  ),
  NextLinkAnchor: forwardRef<
    HTMLAnchorElement,
    {
      href: string;
      children?: ReactNode;
      "aria-label"?: string;
      tabIndex?: number;
      "data-testid"?: string;
    }
  >(function NextLinkAnchor(
    { href, children, "aria-label": ariaLabel, tabIndex, "data-testid": testId },
    ref,
  ) {
    return (
      <a ref={ref} href={href} aria-label={ariaLabel} tabIndex={tabIndex} data-testid={testId}>
        {children}
      </a>
    );
  }),
  Spinner: () => <span>loading…</span>,
  StyledSelect: ({
    value,
    options,
    onChange,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    testId?: string;
  }) => (
    <select data-testid={testId} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Text: ({
    children,
    role,
    id,
    "data-testid": testId,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    role?: string;
    id?: string;
    "data-testid"?: string;
    "aria-hidden"?: boolean;
  }) => (
    <span role={role} id={id} data-testid={testId} aria-hidden={ariaHidden}>
      {children}
    </span>
  ),
  TextInput: forwardRef<
    HTMLInputElement,
    {
      value?: string;
      onChangeText?: (v: string) => void;
      testId?: string;
      type?: string;
      "aria-describedby"?: string;
    }
  >(function TextInput({ value, onChangeText, testId, type, "aria-describedby": describedBy }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        aria-describedby={describedBy}
        data-testid={testId}
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.currentTarget.value)}
      />
    );
  }),
  useFormatters: () => ({
    dateTime: (d: Date) => new Date(d).toISOString().slice(0, 10),
  }),
  useNotify: () => ({
    toast: {
      info: mocks.toastInfo,
      success: mocks.toastSuccess,
      warning: mocks.toastWarning,
      danger: mocks.toastDanger,
    },
  }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key} ${Object.entries(values)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(" ")}`
      : key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    ArrowDown: Icon,
    ArrowUp: Icon,
    Bookmark: Icon,
    BookmarkCheck: Icon,
    BookmarkX: Icon,
    ExternalLink: Icon,
    Plus: Icon,
    Send: Icon,
    Timer: Icon,
  };
});

/**
 * `title` and `description` are RENDERED, not dropped. The dialog's body is a
 * sentence about what the button is about to do — "The act is notified." — and
 * a mock that swallows it makes the one place this strip makes a promise
 * unassertable. It shipped a false promise exactly that way.
 */
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    title,
    description,
  }: {
    open: boolean;
    onConfirm: () => void;
    title?: string;
    description?: string;
  }) =>
    open ? (
      <div role="dialog">
        <p data-testid="dialog-title">{title}</p>
        <p data-testid="dialog-description">{description}</p>
        <button type="button" data-testid="dialog-confirm" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

/**
 * The month picker is its own surface with its own suite (`hold-date-grid`
 * for the model). Here it is a seam: this suite pins what the strip HANDS it
 * and what the strip does when it reports back.
 */
vi.mock("../HoldDatePicker", () => ({
  HoldDatePicker: ({
    preferredDates,
    onPlaced,
    onCancel,
    testIdBase,
  }: {
    preferredDates: readonly string[];
    onPlaced: (placedCount: number, failedCount: number) => void;
    onCancel: () => void;
    testIdBase: string;
  }) => (
    <div data-testid={`${testIdBase}-form`} data-preferred={preferredDates.join(",")}>
      <button type="button" data-testid={`${testIdBase}-submit`} onClick={() => onPlaced(2, 0)}>
        place all
      </button>
      <button
        type="button"
        data-testid={`${testIdBase}-submit-partial`}
        onClick={() => onPlaced(4, 1)}
      >
        place some
      </button>
      <button type="button" data-testid={`${testIdBase}-cancel`} onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => `fmt:${(err as Error)?.message ?? String(err)}`,
}));

import { BookingHoldsStrip, type BookingHoldConfirmOutcome } from "../BookingHoldsStrip";
import { fromDateTimeLocalValue, toDateTimeLocalValue, type BookingHoldSummary } from "../booking-holds";

const NOW = new Date("2026-10-12T12:00:00.000Z");

type StripHold = BookingHoldSummary & { askedFor?: boolean };
const hold = (over: Partial<StripHold> = {}): StripHold => ({
  id: "h1",
  calendarId: "cal-1",
  date: "2026-10-13",
  position: 1,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  // The server's `isAskedForNight` answer (list-booking-requests.ts).
  askedFor: true,
  ...over,
});

type Props = Parameters<typeof BookingHoldsStrip>[0];

function renderStrip(props: Partial<Props> = {}) {
  const base: Props = {
    bookingRequestId: "req-1",
    placeId: "place-1",
    preferredDates: ["2026-10-13", "2026-10-20T20:00"],
    holds: [hold()],
    eventAdminSlug: "acme",
    testIdBase: "strip",
    // An accepted request with draft terms: both booking actions are live on
    // a 1st hold for an asked-for night (hold-booking-actions.ts).
    requestStatus: "ACCEPTED",
    agreementId: "agr-1",
    agreementStatus: "DRAFT",
    bookingEvent: { state: "none" },
    bookWithoutTermsPayee: "place",
    hasBookedNight: false,
    placeName: "Marrow Hall",
    ...props,
  };
  const utils = render(<BookingHoldsStrip {...base} />);
  return {
    ...utils,
    rerender: (next: Partial<Props>) =>
      utils.rerender(<BookingHoldsStrip {...base} {...next} />),
  };
}

/** The `{ onSuccess, onError }` bag the strip hands each mutation. */
function lastOptions(fn: ReturnType<typeof vi.fn>) {
  const call = fn.mock.calls.at(-1);
  if (!call) throw new Error("mutation was not called");
  return call[1] as {
    onSuccess?: (result: unknown) => void;
    onError?: (err: unknown) => void;
    onSettled?: () => void;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.releasePending = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BookingHoldsStrip — challenge / extend form", () => {
  it("opens with now + 24h and enforces the 1h floor before the server does", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-challenge-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    expect(fromDateTimeLocalValue(input.value)?.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);

    fireEvent.change(input, {
      target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 30 * 60_000)) },
    });
    expect(screen.getByRole("alert").textContent).toBe("admin.bkHoldDeadlineTooSoon");
    // `aria-disabled`, not `toBeDisabled()` — see the mock's header note: a
    // disabled `@th/ui` Button emits no native attribute.
    expect(screen.getByTestId("strip-form-submit")).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    fireEvent.change(input, { target: { value: toDateTimeLocalValue(later) } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.challenge).toHaveBeenCalledWith(
      { holdId: "h1", respondBy: later },
      expect.anything(),
    );
  });

  // The owner's report (2026-09-28): the deadline must be a pickable DATE and
  // TIME. This mock forwards `type` verbatim, so it pins the strip's side of the
  // contract only; the primitive keeping `type` alive under React 19 is pinned
  // in @th/ui's TextInput.test.tsx.
  it("asks for a native date+time and posts exactly the wall-clock time picked", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-challenge-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("datetime-local");
    expect(input.value).toBe(toDateTimeLocalValue(new Date(NOW.getTime() + 24 * 3_600_000)));

    // Two days out at 19:30, in the viewer's zone (the value is zone-less).
    const picked = new Date(NOW);
    picked.setDate(picked.getDate() + 2);
    picked.setHours(19, 30, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    const typed = `${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}T19:30`;
    fireEvent.change(input, { target: { value: typed } });
    expect(input.value).toBe(typed);
    expect(screen.queryByRole("alert")).toBeNull();
    // The choice is echoed in words (the field scrolls its date away at 320).
    const echo = screen.getByTestId("strip-deadline-echo");
    expect(echo.textContent).toContain("admin.bkHoldNewDeadline");
    expect(echo.id).not.toBe("");
    expect(input.getAttribute("aria-describedby")).toBe(echo.id);

    // Half-typed native segments report "": no verdict yet, no alert, no submit.
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("strip-deadline-echo")).toBeNull();
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByTestId("strip-form-submit")).toHaveAttribute("aria-disabled", "true");

    // A value under the floor drops the echo and raises the alert instead.
    fireEvent.change(input, {
      target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 30 * 60_000)) },
    });
    expect(screen.queryByTestId("strip-deadline-echo")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(input, { target: { value: typed } });

    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.challenge).toHaveBeenCalledWith(
      { holdId: "h1", respondBy: picked },
      expect.anything(),
    );
  });

  // `focus()` on a focused native date/time field sends Chrome back to its
  // first segment; the effect used to refire on every keystroke (it keyed on
  // the whole `form` object), so "10" typed into the month came out "01".
  it("focuses the deadline when the form opens, and never again on an edit", () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    try {
      renderStrip();
      fireEvent.click(screen.getByTestId("strip-challenge-h1"));
      expect(focus).toHaveBeenCalledTimes(1);
      const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
      fireEvent.change(input, {
        target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 3 * 3_600_000)) },
      });
      fireEvent.change(input, {
        target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 4 * 3_600_000)) },
      });
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      focus.mockRestore();
    }
  });

  it("validates the floor against the clock AT OPEN, not at mount", () => {
    renderStrip();
    // Two hours pass with the strip mounted and no challenge running (so the
    // minute ticker is off and `now` would otherwise be the mount instant).
    const opened = new Date(NOW.getTime() + 2 * 3_600_000);
    vi.setSystemTime(opened);
    fireEvent.click(screen.getByTestId("strip-challenge-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    expect(fromDateTimeLocalValue(input.value)?.getTime()).toBe(opened.getTime() + 24 * 3_600_000);
    // 90 minutes after MOUNT is 30 minutes BEFORE open — under the floor.
    fireEvent.change(input, {
      target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 90 * 60_000)) },
    });
    expect(screen.getByTestId("strip-form-submit")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("extend seeds from the later of now + 24h and the current deadline, and posts respondBy", () => {
    const respondBy = new Date(NOW.getTime() + 40 * 3_600_000);
    renderStrip({ holds: [hold({ status: "CHALLENGED", respondBy })] });
    expect(screen.queryByTestId("strip-challenge-h1")).toBeNull();
    fireEvent.click(screen.getByTestId("strip-extend-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    expect(fromDateTimeLocalValue(input.value)?.getTime()).toBe(respondBy.getTime());
    const pushed = new Date(respondBy.getTime() + 24 * 3_600_000);
    fireEvent.change(input, { target: { value: toDateTimeLocalValue(pushed) } });
    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.extend).toHaveBeenCalledWith({ holdId: "h1", respondBy: pushed }, expect.anything());
  });

  it("caps a challenge's deadline at 30 days out (max + alert); an extend may go further", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-challenge-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    const ceiling = new Date(NOW.getTime() + 30 * 24 * 3_600_000);
    expect(input.getAttribute("max")).toBe(toDateTimeLocalValue(ceiling));

    fireEvent.change(input, {
      target: { value: toDateTimeLocalValue(new Date(ceiling.getTime() + 3_600_000)) },
    });
    expect(screen.getByRole("alert").textContent).toBe("admin.bkHoldDeadlineTooLate");
    expect(screen.getByTestId("strip-form-submit")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it("an extend has no 30-day ceiling: no near max, a far deadline posts", () => {
    const respondBy = new Date(NOW.getTime() + 40 * 3_600_000);
    renderStrip({ holds: [hold({ status: "CHALLENGED", respondBy })] });
    fireEvent.click(screen.getByTestId("strip-extend-h1"));
    const input = screen.getByTestId("strip-deadline") as HTMLInputElement;
    expect(input.getAttribute("max")).not.toBe(
      toDateTimeLocalValue(new Date(NOW.getTime() + 30 * 24 * 3_600_000)),
    );
    const far = new Date(NOW.getTime() + 45 * 24 * 3_600_000);
    fireEvent.change(input, { target: { value: toDateTimeLocalValue(far) } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.extend).toHaveBeenCalledWith({ holdId: "h1", respondBy: far }, expect.anything());
  });
});

describe("BookingHoldsStrip — place hold", () => {
  it("opens the month picker seeded with the act's asked-for dates, clock dropped", () => {
    renderStrip({ holds: [] });
    expect(screen.getByTestId("strip-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("strip-place"));
    // Preferred dates reach the picker date-only (the clock on the second is
    // dropped by `holdDateFromPreferred`), de-duplicated, in order.
    expect(
      screen.getByTestId("strip-place-form").getAttribute("data-preferred"),
    ).toBe("2026-10-13,2026-10-20");
  });

  it("closes, refreshes every reader and toasts once when the picker reports holds placed", () => {
    const onHoldsChanged = vi.fn();
    renderStrip({ holds: [], onHoldsChanged });
    fireEvent.click(screen.getByTestId("strip-place"));
    fireEvent.click(screen.getByTestId("strip-place-submit"));

    expect(screen.queryByTestId("strip-place-form")).toBeNull();
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.calendarInvalidate).toHaveBeenCalled();
    expect(onHoldsChanged).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("admin.bkHoldPickPlacedToast"),
      }),
    );
  });

  it("STAYS OPEN when a date was refused — the tray is the only place it exists", () => {
    const onHoldsChanged = vi.fn();
    renderStrip({ holds: [], onHoldsChanged });
    fireEvent.click(screen.getByTestId("strip-place"));
    fireEvent.click(screen.getByTestId("strip-place-submit-partial"));

    // Four landed, one did not. Closing here would compute the failure chip
    // and throw it away in the same batch, leaving a toast and nothing to fix.
    expect(screen.getByTestId("strip-place-form")).toBeTruthy();
    // Readers still refresh: four holds landing is four holds landing.
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.calendarEventsInvalidate).toHaveBeenCalled();
    expect(onHoldsChanged).toHaveBeenCalledTimes(1);
    // And the sentence says a night was refused, rather than only counting wins.
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("admin.bkHoldPickPlacedPartialToast"),
      }),
    );
  });

  it("refreshes the calendar overlay the picker is built from, not just the list", () => {
    renderStrip({ holds: [] });
    fireEvent.click(screen.getByTestId("strip-place"));
    fireEvent.click(screen.getByTestId("strip-place-submit"));
    // Without this the picker reopens inside its own 30s staleTime and rebuilds
    // the month from the pre-write snapshot.
    expect(mocks.calendarEventsInvalidate).toHaveBeenCalled();
  });

  it("cancelling the picker leaves the line untouched", () => {
    const onHoldsChanged = vi.fn();
    renderStrip({ holds: [], onHoldsChanged });
    fireEvent.click(screen.getByTestId("strip-place"));
    fireEvent.click(screen.getByTestId("strip-place-cancel"));
    expect(screen.queryByTestId("strip-place-form")).toBeNull();
    expect(screen.getByTestId("strip-place")).toBeTruthy();
    expect(onHoldsChanged).not.toHaveBeenCalled();
  });

  it("is not offered when the caller says the request can no longer take one", () => {
    renderStrip({ canPlace: false });
    expect(screen.queryByTestId("strip-place")).toBeNull();
    // The live line is still shown and still actionable.
    expect(screen.getByTestId("strip-release-h1")).toBeTruthy();
  });
});

/**
 * THE LINE GROWS. "Place hold" is the last ROW of the holds frame, not a
 * button floating under it — so what this block pins is structural: the row
 * is inside the frame, it is a real button that is not a list item, and the
 * frame appears for it alone when the line is empty.
 */
describe("BookingHoldsStrip — the add-row is the last row of the line", () => {
  it("renders inside the frame, after the list, as a real non-submitting button", () => {
    renderStrip({ holds: [hold()] });
    const frame = screen.getByTestId("strip-frame");
    const list = screen.getByTestId("strip-list");
    const add = screen.getByTestId("strip-place");

    expect(frame.contains(list)).toBe(true);
    // AFTER the list, not merely inside the frame — the row is the line's
    // last row, and `contains` alone would pass with it rendered on top.
    expect(frame.lastElementChild).toBe(add);
    expect(
      list.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A <button> may not be a child of a role="list", nor announce as a hold.
    expect(list.contains(add)).toBe(false);
    expect(add.closest('[role="listitem"]')).toBeNull();
    expect(add.tagName).toBe("BUTTON");
    // A styled `tag: "button"` defaults to submit inside a form.
    expect(add.getAttribute("type")).toBe("button");
    // The frame paints the box; the list inside it carries only the semantics.
    expect(list.getAttribute("role")).toBe("list");
    expect(frame.getAttribute("role")).toBeNull();
    // Holds above ⇒ the row draws the 1px rule that joins it to the line.
    expect(add.dataset.divided).toBe("true");
    // A <button> takes phrasing content only. The boxed `+` glyph is a
    // styled Stack, which defaults to a div — React never warns about a div
    // nested in a button, so it ships invalid markup silently.
    expect(add.querySelector("div")).toBeNull();
  });

  it("says 'Place hold' and PROMISES NO POSITION — the line is keyed by date", () => {
    // A line is (calendarId, date). This request's holds span dates and carry
    // their own server-given positions, so no count taken from `live` is a
    // place in any line: here the act is 3rd on Oct 13 and 1st on Oct 20, and
    // `live.length + 1` would have advertised "3rd" while the picker offers
    // 1st on every empty night. The row names the action and stops.
    renderStrip({
      holds: [
        hold({ id: "h1", position: 3, date: "2026-10-13" }),
        hold({ id: "h2", position: 1, date: "2026-10-20" }),
      ],
    });
    const add = screen.getByTestId("strip-place");
    expect(add.textContent).toBe("admin.bkHoldPlace");
    expect(screen.getByRole("button", { name: "admin.bkHoldPlace" })).toBe(add);
    // Nothing ordinal anywhere on the row, under any key.
    expect(add.textContent).not.toMatch(/bkHoldPosition/);
  });

  it("empty line: the frame still renders, holding the add-row alone", () => {
    renderStrip({ holds: [] });
    // The sentence stays where it was — the frame under it is what recruits.
    expect(screen.getByTestId("strip-empty")).toBeTruthy();
    const frame = screen.getByTestId("strip-frame");
    expect(frame.contains(screen.getByTestId("strip-place"))).toBe(true);
    // No holds ⇒ no list element at all, rather than an empty role="list".
    expect(screen.queryByTestId("strip-list")).toBeNull();
    // …and no rule above it: the row is the frame's only child, and a rule
    // there would read as a header for nothing.
    expect(screen.getByTestId("strip-place").dataset.divided).toBe("false");
  });

  it("no venue and no permission: no add-row, and no frame when the line is empty", () => {
    const { unmount } = renderStrip({ holds: [], canPlace: false });
    expect(screen.queryByTestId("strip-place")).toBeNull();
    expect(screen.queryByTestId("strip-frame")).toBeNull();
    unmount();

    renderStrip({ holds: [], placeId: null });
    expect(screen.queryByTestId("strip-place")).toBeNull();
    expect(screen.queryByTestId("strip-frame")).toBeNull();
  });

  it("holds present but placing not allowed: the frame keeps the line, minus the add-row", () => {
    renderStrip({ holds: [hold()], canPlace: false });
    const frame = screen.getByTestId("strip-frame");
    expect(frame.contains(screen.getByTestId("strip-list"))).toBe(true);
    expect(screen.queryByTestId("strip-place")).toBeNull();
  });

  it("the picker replaces the row and opens BELOW the frame, never inside the line", () => {
    renderStrip({ holds: [hold()] });
    fireEvent.click(screen.getByTestId("strip-place"));
    expect(screen.queryByTestId("strip-place")).toBeNull();
    const picker = screen.getByTestId("strip-place-form");
    const frame = screen.getByTestId("strip-frame");
    expect(frame.contains(picker)).toBe(false);
    expect(screen.getByTestId("strip-list").contains(picker)).toBe(false);
    // BELOW the frame, not above it — the month grid follows the line.
    expect(
      frame.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("goes disabled while another hold write is in flight", () => {
    renderStrip({ holds: [hold()] });
    expect(screen.getByTestId("strip-place")).not.toBeDisabled();
    // A release is in flight: every control in the strip is `busy`, and the
    // add-row is not a way around it.
    mocks.releasePending = true;
    renderStrip({ holds: [hold()], testIdBase: "busy-strip" });
    const busyAdd = screen.getByTestId("busy-strip-place");
    expect(busyAdd).toBeDisabled();
    fireEvent.click(busyAdd);
    expect(screen.queryByTestId("busy-strip-place-form")).toBeNull();
    // NOTE, so nobody mistakes this for coverage of the `if (busy) return;`
    // inside `onPress`: that line is UNREACHABLE from here and cannot be
    // tested through the DOM. React's `shouldPreventMouseEvent` drops the
    // onClick listener for any interactive element whose REACT PROPS carry
    // `disabled`, so the handler never runs — and flipping the DOM property
    // does not help, because React reads the props, not the node. The guard
    // is defence in depth for the day this stops being a real <button>
    // (a div, a role="button", an aria-disabled-only variant); what is
    // actually pinned above is the attribute the browser acts on.
  });
});

describe("BookingHoldsStrip — reorder", () => {
  it("names the hold in each arrow's accessible name (date + ordinal), never a bare 'move up'", () => {
    renderStrip({ holds: [hold({ position: 2 })] });
    expect(screen.getByTestId("strip-up-h1").getAttribute("aria-label")).toBe(
      "admin.bkHoldMoveUp date=2026-10-13 position=admin.bkHoldPosition2 position=2",
    );
    expect(screen.getByTestId("strip-down-h1").getAttribute("aria-label")).toContain(
      "admin.bkHoldMoveDown date=2026-10-13",
    );
  });

  it("surfaces the server's end-of-line no-op as an info toast", () => {
    renderStrip({ holds: [hold({ position: 2 })] });
    fireEvent.click(screen.getByTestId("strip-down-h1"));
    expect(mocks.reorder).toHaveBeenCalledWith({ holdId: "h1", toPosition: 3 }, expect.anything());
    act(() =>
      lastOptions(mocks.reorder).onSuccess?.({
        line: [{ id: "h0", position: 1 }, { id: "h1", position: 2 }],
      }),
    );
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkHoldAlreadyLast date=2026-10-13" }),
    );
    // A real move says nothing.
    mocks.toastInfo.mockClear();
    fireEvent.click(screen.getByTestId("strip-up-h1"));
    act(() =>
      lastOptions(mocks.reorder).onSuccess?.({
        line: [{ id: "h1", position: 1 }, { id: "h0", position: 2 }],
      }),
    );
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});

describe("BookingHoldsStrip — every action names the night it acts on", () => {
  /**
   * The defect this pins: a request holding TWO nights renders two rows, and
   * before this the four verb buttons were named by the verb alone — a screen
   * reader's controls list read "Release, Release", each releasing a different
   * night, with nothing to tell them apart. Worse than a poor label: releasing
   * the wrong night is destructive and not obviously undoable.
   *
   * The assertion is deliberately COMPARATIVE. `toContain` on one label would
   * still pass if both rows rendered the same date, which is the exact failure
   * the fix exists to prevent — so each pair is asserted DISTINCT as well as
   * correct.
   */
  const twoNights = [
    hold({ id: "h1", date: "2026-10-13", position: 1, status: "ACTIVE" }),
    hold({ id: "h2", date: "2026-10-24", position: 2, status: "ACTIVE" }),
  ];

  const nameOf = (testId: string) =>
    screen.getByTestId(testId).getAttribute("aria-label");

  it("release and book name their own date and ordinal on every row", () => {
    renderStrip({ holds: twoNights });

    expect(nameOf("strip-release-h1")).toBe(
      "admin.bkHoldReleaseAction date=2026-10-13 position=admin.bkHoldPosition1 position=1",
    );
    expect(nameOf("strip-release-h2")).toBe(
      "admin.bkHoldReleaseAction date=2026-10-24 position=admin.bkHoldPosition2 position=2",
    );
    expect(nameOf("strip-release-h1")).not.toBe(nameOf("strip-release-h2"));

    // Booking names its night; the 2nd hold has none (another act is ahead).
    expect(nameOf("strip-book-h1")).toBe("admin.bkHoldBookWithoutTermsAction date=2026-10-13");
    expect(nameOf("strip-send-terms-h1")).toBe("admin.bkHoldSendTermsAction date=2026-10-13");
    expect(screen.queryByTestId("strip-book-h2")).toBeNull();
    expect(screen.queryByTestId("strip-send-terms-h2")).toBeNull();
  });

  it("challenge and extend do too — and the VISIBLE label stays the bare verb", () => {
    // DELIBERATELY NOT live[0]. Challenge only renders on the ACTIVE
    // position-1 hold and extend only on a CHALLENGED one, so a fixture whose
    // single challengeable hold is also the FIRST in the sorted line cannot
    // tell `hold.date` from `live[0].date` — the exact substitution the
    // release plant caught. `liveHolds` sorts by date, so the position-1 hold
    // is given the LATER night and lands at live[1]; the challenged one at
    // live[2].
    renderStrip({
      holds: [
        hold({ id: "h1", date: "2026-10-13", position: 2, status: "ACTIVE" }),
        hold({ id: "h2", date: "2026-10-24", position: 1, status: "ACTIVE" }),
        hold({
          id: "h3",
          date: "2026-11-02",
          position: 3,
          status: "CHALLENGED",
          respondBy: new Date(NOW.getTime() + 6 * 3_600_000),
        }),
      ],
    });
    expect(screen.queryByTestId("strip-challenge-h1")).toBeNull();
    expect(nameOf("strip-challenge-h2")).toBe(
      "admin.bkHoldChallengeAction date=2026-10-24 position=admin.bkHoldPosition1 position=1",
    );
    expect(nameOf("strip-extend-h3")).toBe(
      "admin.bkHoldExtendAction date=2026-11-02 position=admin.bkHoldPosition3 position=3",
    );

    // The fix is to the ACCESSIBLE name only. A redesign of the visible text
    // would be a different change, and the row is already headed by its date.
    expect(screen.getByTestId("strip-challenge-h2").textContent).toBe(
      "admin.bkHoldChallenge",
    );
    expect(screen.getByTestId("strip-release-h1").textContent).toBe(
      "admin.bkHoldRelease",
    );
    // h2 is the 1st hold, on a night the pitch did not ask for: Send terms only.
    expect(screen.getByTestId("strip-send-terms-h2").textContent).toBe(
      "admin.bkHoldSendTerms",
    );
  });

  /**
   * ACROSS strips, date + ordinal is NOT unique. Two venues in an org scope
   * can both hold 2026-10-13 at 1st, and the inbox expands rows into a Set —
   * so two "Release the Oct 13, 2026 hold (1st)" buttons is the original
   * defect wearing the fix as a disguise. Same motivation that earned "Place
   * hold" its suffix; same suffix.
   */
  it("every action carries the counterparty too — date + ordinal repeats across venues", () => {
    renderStrip({ holds: [hold({ position: 2 })], nameSuffix: "Neon Static" });

    for (const [testId, key] of [
      ["strip-release-h1", "admin.bkHoldReleaseAction"],
      ["strip-up-h1", "admin.bkHoldMoveUp"],
      ["strip-down-h1", "admin.bkHoldMoveDown"],
    ] as const) {
      expect(nameOf(testId)).toBe(
        `${key} date=2026-10-13 position=admin.bkHoldPosition2 position=2 — Neon Static`,
      );
    }

    // And the list itself: two expanded rows otherwise give a screen reader
    // two lists both called "Holds".
    expect(screen.getByTestId("strip-list").getAttribute("aria-label")).toBe(
      "admin.bkHoldsHeading — Neon Static",
    );
  });

  it("no counterparty: every name falls back to the bare, date-qualified label", () => {
    renderStrip({ holds: [hold({ position: 2 })] });
    expect(nameOf("strip-release-h1")).toBe(
      "admin.bkHoldReleaseAction date=2026-10-13 position=admin.bkHoldPosition2 position=2",
    );
    expect(screen.getByTestId("strip-list").getAttribute("aria-label")).toBe(
      "admin.bkHoldsHeading",
    );
  });

  it("'Place hold' takes the counterparty from the caller — no date can qualify it", () => {
    renderStrip({ holds: [], nameSuffix: "Jo Blow" });
    expect(screen.getByTestId("strip-place").getAttribute("aria-label")).toBe(
      "admin.bkHoldPlace — Jo Blow",
    );
  });

  it("no counterparty: NO aria-label at all, so the row keeps its own text", () => {
    renderStrip({ holds: [] });
    const row = screen.getByTestId("strip-place");
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(row.textContent).toContain("admin.bkHoldPlace");
  });
});

describe("BookingHoldsStrip — an unclaimed sender's line", () => {
  /**
   * The line EXISTS on unclaimed embed inquiries — no placement path refuses
   * one, and the seed ships such a row — so the strip shows it. What it does
   * not do is offer the two actions the server will not carry through:
   * `confirmBookingHold` refuses outright, and a challenge clock started here
   * would lapse with nobody ever asked to answer it.
   */
  it("shows the line, says why, offers no booking, and disables challenge", () => {
    renderStrip({ holds: [hold()], unclaimedInquiry: true });

    expect(screen.getByTestId("strip-list")).toBeInTheDocument();
    expect(screen.getByTestId("strip-row-h1")).toBeInTheDocument();
    expect(screen.getByTestId("strip-unclaimed").textContent).toBe(
      "admin.bkHoldsUnclaimedNoteBooking",
    );

    // `aria-disabled`, NOT `toBeDisabled()`. A disabled `@th/ui` Button emits
    // no native `disabled` attribute at all (measured — see the Button mock's
    // comment), so jest-dom's `toBeDisabled`, which ignores `aria-disabled` by
    // design, asserted a contract production does not have.
    // The server refuses booking an unclaimed request
    // (HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST): neither action is offered.
    expect(screen.queryByTestId("strip-book-h1")).toBeNull();
    expect(screen.queryByTestId("strip-send-terms-h1")).toBeNull();
    expect(screen.getByTestId("strip-challenge-h1")).toHaveAttribute("aria-disabled", "true");
    // The server honours all three of these on an unclaimed request, so the
    // UI must not invent a refusal it would not get.
    expect(screen.getByTestId("strip-release-h1")).not.toHaveAttribute("aria-disabled");
    // Position 1 — the pre-existing reorder rule, nothing to do with claims.
    expect(screen.getByTestId("strip-up-h1")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("strip-down-h1")).not.toHaveAttribute("aria-disabled");
  });

  /**
   * THE DIALOG IS WHERE THE STRIP MAKES A PROMISE, and the destructive action
   * still live on an unclaimed row opens one. The claimed copy ends "The act
   * is notified"; `notify-booking-hold-intents` returns [] for that act. The
   * strip's own note, two inches up, says the opposite.
   */
  it("release's dialog drops the notify promise it cannot keep", () => {
    const { rerender } = renderStrip({ holds: [hold()] });

    fireEvent.click(screen.getByTestId("strip-release-h1"));
    expect(screen.getByTestId("dialog-description").textContent).toBe(
      "admin.bkHoldReleaseConfirmBody date=2026-10-13",
    );

    rerender({ unclaimedInquiry: true });
    fireEvent.click(screen.getByTestId("strip-release-h1"));
    expect(screen.getByTestId("dialog-description").textContent).toBe(
      "admin.bkHoldReleaseConfirmBodyUnclaimed date=2026-10-13",
    );
  });

  /**
   * The OTHER dialog, swept for the same reachability change rather than
   * assumed safe. Its body makes no notification claim — but the reason it is
   * safe is that it cannot be opened at all, and that is what this pins.
   */
  it("the booking dialog is unreachable on an unclaimed row", () => {
    renderStrip({ holds: [hold()], unclaimedInquiry: true });
    expect(screen.queryByTestId("strip-book-h1")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.book).not.toHaveBeenCalled();
  });

  /**
   * Both guards are belt-and-braces today — the buttons are real
   * `<button disabled>` and `unclaimedInquiry` only ever goes true→false. The
   * rerender is what makes them FALSIFIABLE: state opened while the sender was
   * claimed outlives the control that opened it, so the dialog and the inline
   * form are both still on screen after the flip.
   */
  it("a booking dialog opened while claimed does not fire after the row flips unclaimed", () => {
    const { rerender } = renderStrip({ holds: [hold()] });
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender({ unclaimedInquiry: true });
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    expect(mocks.book).not.toHaveBeenCalled();
  });

  it("a challenge form opened while claimed does not submit after the flip — extend still does", () => {
    const { rerender } = renderStrip({ holds: [hold()] });
    fireEvent.click(screen.getByTestId("strip-challenge-h1"));
    // The form REPLACES the action cluster, so it survives the button leaving.
    rerender({ unclaimedInquiry: true });
    expect(screen.getByTestId("strip-form-challenge")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("strip-form-submit"));
    expect(mocks.challenge).not.toHaveBeenCalled();

    // Extend is NOT guarded: the server honours it on an unclaimed request,
    // and the UI must not invent a refusal it would not get.
    const challenged = hold({
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() + 6 * 3_600_000),
    });
    renderStrip({ holds: [challenged], unclaimedInquiry: true, testIdBase: "strip2" });
    fireEvent.click(screen.getByTestId("strip2-extend-h1"));
    fireEvent.click(screen.getByTestId("strip2-form-submit"));
    expect(mocks.extend).toHaveBeenCalledTimes(1);
  });

  /**
   * THE FORM'S HINT IS THE STRIP'S OTHER PROMISE. Same shape of defect as the
   * release dialog, same narrow path: extend is the one deadline control still
   * reachable here (challenge is disabled AND handler-guarded), and it needs a
   * hold CHALLENGED while the sender still counted as claimed — which is
   * exactly what the sender-lens flip produces.
   *
   * The unclaimed copy does not just drop the false clause: the deadline still
   * does something (`settle-lapsed-holds` CASes to RELEASED/EXPIRED past it and
   * tells staff), so the sentence has to say that instead of going quiet.
   */
  it("the deadline hint stops naming an obligation nobody is asked to meet", () => {
    const challenged = hold({
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() + 6 * 3_600_000),
    });

    renderStrip({ holds: [challenged] });
    fireEvent.click(screen.getByTestId("strip-extend-h1"));
    expect(screen.getByTestId("strip-deadline-hint").textContent).toBe(
      "admin.bkHoldDeadlineHint",
    );

    renderStrip({ holds: [challenged], unclaimedInquiry: true, testIdBase: "strip2" });
    fireEvent.click(screen.getByTestId("strip2-extend-h1"));
    expect(screen.getByTestId("strip2-deadline-hint").textContent).toBe(
      "admin.bkHoldDeadlineHintUnclaimed",
    );

    // The floor still bites on the unclaimed branch — the forked hint describes
    // this field's validation, and the validation did not fork.
    const input = screen.getByTestId("strip2-deadline") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: toDateTimeLocalValue(new Date(NOW.getTime() + 30 * 60_000)) },
    });
    expect(screen.getByTestId("strip2-form-submit")).toHaveAttribute("aria-disabled", "true");
  });

  it("a claimed sender is untouched: no note, and booking/challenge stay live", () => {
    renderStrip({ holds: [hold()] });
    expect(screen.queryByTestId("strip-unclaimed")).toBeNull();
    expect(screen.getByTestId("strip-book-h1")).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("strip-challenge-h1")).not.toHaveAttribute("aria-disabled");
  });
});

describe("BookingHoldsStrip — booking and its outcome", () => {
  it("never offers the retired hold Confirm (HOLD_CONFIRM_RETIRED)", () => {
    renderStrip();
    expect(screen.queryByTestId("strip-confirm-h1")).toBeNull();
  });

  it("books without terms through the dialog and hands the outcome to the caller", () => {
    const onConfirmed = vi.fn();
    renderStrip({ onConfirmed });
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    // The dialog says where the money goes until terms are added.
    expect(screen.getByTestId("dialog-description").textContent).toContain(
      "admin.bkHoldBookMoney place=Marrow Hall",
    );
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    expect(mocks.book).toHaveBeenCalledWith(
      { bookingRequestId: "req-1", holdId: "h1" },
      expect.anything(),
    );
    act(() =>
      lastOptions(mocks.book).onSuccess?.({
        hold: { id: "h1" },
        eventId: "ev-1",
        releasedHoldIds: ["h2"],
      }),
    );
    expect(onConfirmed).toHaveBeenCalledWith({
      holdId: "h1",
      eventId: "ev-1",
      releasedHoldIds: ["h2"],
    });
    expect(mocks.countOpenInvalidate).toHaveBeenCalled();
    expect(mocks.agreementInvalidate).toHaveBeenCalled();
  });

  it("sends terms for the hold's night in one tap, and refreshes the readers", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-send-terms-h1"));
    expect(mocks.sendTerms).toHaveBeenCalledWith(
      { agreementId: "agr-1", night: "2026-10-13" },
      expect.anything(),
    );
    act(() => lastOptions(mocks.sendTerms).onSuccess?.({}));
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.agreementInvalidate).toHaveBeenCalled();
  });

  it("on a night the pitch did not ask for, offers Send terms only and says why", () => {
    renderStrip({ holds: [hold({ date: "2026-10-22", askedFor: false })], nameSuffix: "Lowlight Collective" });
    expect(screen.getByTestId("strip-send-terms-h1")).toBeInTheDocument();
    expect(screen.queryByTestId("strip-book-h1")).toBeNull();
    expect(screen.getByTestId("strip-reason-not_asked-h1").textContent).toBe(
      "admin.bkHoldNotAskedReason name=Lowlight Collective",
    );
  });

  it("names who the money goes to from the server's payee — place, requester, or neutral", () => {
    const money = () => screen.getByTestId("dialog-description").textContent ?? "";
    const { unmount } = renderStrip();
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    expect(money()).toContain("admin.bkHoldBookMoney place=Marrow Hall");
    unmount();

    // RENT / an event the sender owns: the requester is paid.
    const second = renderStrip({ bookWithoutTermsPayee: "requester", nameSuffix: "Lowlight Collective" });
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    expect(money()).toContain("admin.bkHoldBookMoneyRequester name=Lowlight Collective");
    second.unmount();

    renderStrip({ bookWithoutTermsPayee: null });
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    expect(money()).toContain("admin.bkHoldBookMoneyOrganiser");
  });

  it("a booked night ends both actions and says so (BOOKING_ALREADY_HAS_NIGHT)", () => {
    renderStrip({ hasBookedNight: true });
    expect(screen.queryByTestId("strip-book-h1")).toBeNull();
    expect(screen.queryByTestId("strip-send-terms-h1")).toBeNull();
    expect(screen.getByTestId("strip-reason-booked-h1").textContent).toBe("admin.bkHoldBookedReason");
  });

  it("withholds both, with the reason, when the server could not resolve the event", () => {
    renderStrip({ bookingEvent: null });
    expect(screen.queryByTestId("strip-book-h1")).toBeNull();
    expect(screen.queryByTestId("strip-send-terms-h1")).toBeNull();
    expect(screen.getByTestId("strip-reason-unknown-h1").textContent).toBe("admin.bkHoldStageUnknownReason");
  });

  it("only the pressed row's Send terms spins", () => {
    renderStrip({ holds: [hold(), hold({ id: "h2", date: "2026-10-20" })] });
    fireEvent.click(screen.getByTestId("strip-send-terms-h1"));
    expect(screen.getByTestId("strip-send-terms-h1").textContent).not.toContain("admin.bkHoldSendTerms");
    expect(screen.getByTestId("strip-send-terms-h2").textContent).toBe("admin.bkHoldSendTerms");
  });

  it("tags an asked-for night", () => {
    renderStrip();
    expect(screen.getByTestId("strip-asked-h1").textContent).toBe("admin.bkHoldPickRailAskedLabel");
  });

  it("moves focus to the outcome's Open-event link — the row remounts on the tab flip", () => {
    const outcome: BookingHoldConfirmOutcome = { holdId: "h1", eventId: "ev-1", releasedHoldIds: [] };
    renderStrip({ holds: [hold({ status: "CONFIRMED" })], confirmOutcome: outcome });
    const link = screen.getByTestId("strip-confirmed-link");
    expect(link.getAttribute("href")).toBe("/admin/acme/events/ev-1");
    // A real <a href> stays in the tab order — only the decorative inner
    // span-button is taken out of it.
    expect(link.hasAttribute("tabindex")).toBe(false);
    expect(
      screen.getByTestId("strip-confirmed-open-event").getAttribute("tabindex"),
    ).toBe("-1");
    expect(document.activeElement).toBe(link);
    expect(screen.getByTestId("strip-confirmed").getAttribute("role")).toBe("status");
  });
});

describe("BookingHoldsStrip — errors", () => {
  it("HOLD_LINE_CHANGED is the retryable race: a warning, and every reader refreshed", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-release-h1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    act(() =>
      lastOptions(mocks.release).onError?.(
        Object.assign(new Error("HOLD_LINE_CHANGED"), { data: { appCode: "HOLD_LINE_CHANGED" } }),
      ),
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkHoldConflict" }),
    );
    expect(mocks.toastDanger).not.toHaveBeenCalled();
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.holdsInvalidate).toHaveBeenCalledWith({ bookingRequestId: "req-1" });
  });

  it("HOLD_LINE_HAS_OPEN_CHALLENGE on booking is the rule's sentence, not the race's, and refreshes", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    act(() =>
      lastOptions(mocks.book).onError?.({
        data: { code: "CONFLICT", appCode: "HOLD_LINE_HAS_OPEN_CHALLENGE" },
      }),
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "errors.holdLineHasOpenChallenge" }),
    );
    expect(mocks.toastWarning).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkHoldConflict" }),
    );
    expect(mocks.toastDanger).not.toHaveBeenCalled();
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.holdsInvalidate).toHaveBeenCalledWith({ bookingRequestId: "req-1" });
  });

  it("a HOLD_LINE_CHANGED conflict on booking still reads as the retryable race", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-book-h1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    act(() =>
      lastOptions(mocks.book).onError?.({
        data: { code: "CONFLICT", appCode: "HOLD_LINE_CHANGED" },
      }),
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkHoldConflict" }),
    );
    expect(mocks.toastDanger).not.toHaveBeenCalled();
    expect(mocks.holdsInvalidate).toHaveBeenCalledWith({ bookingRequestId: "req-1" });
  });

  it("every other code carries its own copy through the translated formatter", () => {
    renderStrip();
    fireEvent.click(screen.getByTestId("strip-release-h1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    act(() =>
      lastOptions(mocks.release).onError?.(
        Object.assign(new Error("HOLD_LINE_ALREADY_CONFIRMED"), {
          data: { appCode: "HOLD_LINE_ALREADY_CONFIRMED" },
        }),
      ),
    );
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fmt:HOLD_LINE_ALREADY_CONFIRMED" }),
    );
  });
});
