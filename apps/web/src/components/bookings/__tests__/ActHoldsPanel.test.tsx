import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ActHoldsPanel — the act's own holds (booking-holds FR-013).
 *
 * What is pinned: which holds get buttons (a CHALLENGED one that has not
 * lapsed, nothing else), that Release confirms before it fires, that an
 * answer invalidates the three readers that show the result, and that a
 * stale-hold error is a refresh rather than a scolding. Chrome is mocked as
 * everywhere in this suite; nothing here asserts on layout.
 */

type MutationOpts = {
  onSuccess?: (data: unknown, vars: { holdId: string; answer: "keep" | "release" }) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

const mocks = vi.hoisted(() => ({
  answerMutate: vi.fn(),
  /** The options the panel hands to `useMutation` — captured, not called. */
  mutationOpts: { current: null as null | Record<string, unknown> },
  isPending: { current: false },
  listInvalidate: vi.fn(),
  holdsInvalidate: vi.fn(),
  messagesInvalidate: vi.fn(),
  toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  /** What `bookingHolds.listForRequest` (viewer act) returns: what Keep will do. */
  actRead: { current: null as null | Record<string, unknown> },
  actReadInput: { current: null as unknown },
  refetch: vi.fn(),
}));

/** A settled act read saying `keepWill` / `kept` for hold h1. */
function actRead(keepWill: "book_now" | "ask_for_terms" | null, kept = false, respondBy: Date | null = null) {
  mocks.actRead.current = {
    data: {
      viewer: "act",
      holds: [
        { id: "h1", date: "2026-10-13", position: 1, status: "CHALLENGED", respondBy, lapsed: false, keepWill, kept },
      ],
    },
    isSuccess: true,
    isError: false,
    refetch: mocks.refetch,
  };
}

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: { invalidate: mocks.listInvalidate },
        messages: { list: { invalidate: mocks.messagesInvalidate } },
      },
      bookingHolds: { listForRequest: { invalidate: mocks.holdsInvalidate } },
    }),
    bookingHolds: {
      listForRequest: {
        useQuery: (input: unknown) => {
          mocks.actReadInput.current = input;
          return mocks.actRead.current;
        },
      },
      answer: {
        useMutation: (opts: Record<string, unknown>) => {
          mocks.mutationOpts.current = opts;
          return { mutate: mocks.answerMutate, isPending: mocks.isPending.current };
        },
      },
    },
  },
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onCancel,
    description,
  }: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    description: ReactNode;
  }) =>
    open ? (
      <div role="dialog" data-testid="confirm-dialog">
        <span>{description}</span>
        <button type="button" data-testid="confirm-yes" onClick={onConfirm} />
        <button type="button" data-testid="confirm-no" onClick={onCancel} />
      </div>
    ) : null,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String((err as Error).message ?? err),
}));

vi.mock("tamagui", () => {
  const Stack = ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => (
    <div
      data-testid={rest["data-testid"] as string | undefined}
      data-status={rest["data-status"] as string | undefined}
      role={rest.role as string | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled} data-testid={testID} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  Spinner: () => <span>loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({
    dateTime: (d: Date, opts?: { timeStyle?: string }) =>
      opts?.timeStyle ? d.toISOString() : d.toISOString().slice(0, 10),
  }),
  useNotify: () => ({ toast: mocks.toast }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => ({
  Bookmark: () => <span />,
  BookmarkCheck: () => <span />,
  BookmarkX: () => <span />,
  Timer: () => <span />,
}));

import { ActHoldsPanel, type ActHold } from "../ActHoldsPanel";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const IN_A_DAY = new Date(Date.now() + 24 * 60 * 60 * 1000);

function hold(over: Partial<ActHold> = {}): ActHold {
  return {
    id: "h1",
    date: "2026-10-13",
    position: 2,
    status: "ACTIVE",
    respondBy: null,
    lapsed: false,
    ...over,
  };
}

/**
 * The panel's callbacks live on `useMutation` (so a remount mid-flight cannot
 * drop them), so the mock `mutate` settles the request by calling THOSE.
 */
function opts(): MutationOpts {
  return mocks.mutationOpts.current as MutationOpts;
}
function settleWithSuccess() {
  mocks.answerMutate.mockImplementation((vars: { holdId: string; answer: "keep" | "release" }) => {
    opts().onSuccess?.(undefined, vars);
    opts().onSettled?.();
  });
}
function settleWithError(err: unknown) {
  mocks.answerMutate.mockImplementation(() => {
    opts().onError?.(err);
    opts().onSettled?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutationOpts.current = null;
  mocks.isPending.current = false;
  // Default: no terms yet, so Keep asks the place for terms.
  actRead("ask_for_terms");
});

describe("ActHoldsPanel", () => {
  it("renders nothing at all when the act holds nothing", () => {
    const { container } = render(
      <ActHoldsPanel bookingRequestId={REQUEST_ID} holds={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for holds that are already gone (released / confirmed)", () => {
    const { container } = render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "RELEASED" }), hold({ id: "h2", status: "CONFIRMED" })]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("lists a live hold as its date and place in line, with no buttons while unchallenged", () => {
    render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={[hold()]} />);

    expect(
      screen.getByText('booking.actHoldLine:{"date":"2026-10-13","position":"admin.bkHoldPosition2:{\\"position\\":\\"2\\"}"}'),
    ).toBeTruthy();
    expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
    expect(screen.queryByTestId("act-holds-release-h1")).toBeNull();
  });

  it("offers Keep and Release, with the deadline, on a challenged hold", () => {
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    expect(screen.getByText(/booking\.actHoldKeepOrReleaseBy/)).toBeTruthy();
    expect(screen.getByTestId("act-holds-clock-h1")).toBeTruthy();
    expect(screen.getByTestId("act-holds-keep-h1")).toBeTruthy();
    expect(screen.getByTestId("act-holds-release-h1")).toBeTruthy();
  });

  it("Keep answers immediately and refreshes every reader of the result", () => {
    settleWithSuccess();
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-keep-h1"));

    // Keep sends back what it showed (FR-014): never a plain keep.
    expect(mocks.answerMutate.mock.calls[0]![0]).toEqual({
      holdId: "h1",
      answer: "keep",
      expectedKeepWill: "ask_for_terms",
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      expect.objectContaining({ title: "booking.actHoldKeptToast" }),
    );
    // The row (list), the act-side reader, and the thread (a ledger line was
    // written) — all three, every time.
    expect(mocks.listInvalidate).toHaveBeenCalled();
    expect(mocks.holdsInvalidate).toHaveBeenCalledWith({ bookingRequestId: REQUEST_ID });
    expect(mocks.messagesInvalidate).toHaveBeenCalledWith({ bookingRequestId: REQUEST_ID });
  });

  it("Release confirms first, and only fires once confirmed", () => {
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-release-h1"));
    expect(mocks.answerMutate).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    // The body names the date the act is giving up.
    expect(dialog.textContent).toContain("2026-10-13");

    fireEvent.click(screen.getByTestId("confirm-no"));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(mocks.answerMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("act-holds-release-h1"));
    fireEvent.click(screen.getByTestId("confirm-yes"));
    expect(mocks.answerMutate.mock.calls[0]![0]).toEqual({ holdId: "h1", answer: "release" });
  });

  it("treats a stale hold as a refresh, not a failure", () => {
    settleWithError(
      Object.assign(new Error("HOLD_LINE_CHANGED"), {
        data: { appCode: "HOLD_LINE_CHANGED" },
      }),
    );
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-keep-h1"));

    expect(mocks.toast.warning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "booking.actHoldChanged" }),
    );
    expect(mocks.toast.danger).not.toHaveBeenCalled();
    expect(mocks.listInvalidate).toHaveBeenCalled();
  });

  it("surfaces FORBIDDEN (and anything else) as a failure with the server's copy", () => {
    settleWithError(Object.assign(new Error("FORBIDDEN"), { data: { code: "FORBIDDEN" } }));
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-keep-h1"));

    expect(mocks.toast.danger).toHaveBeenCalledWith(
      expect.objectContaining({ title: "booking.actHoldAnswerFailed", message: "FORBIDDEN" }),
    );
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("shows a lapsed challenge as released — no buttons, and it says why", () => {
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[
          hold({
            status: "CHALLENGED",
            respondBy: new Date(Date.now() - 60_000),
            lapsed: true,
          }),
        ]}
      />,
    );

    const row = screen.getByTestId("act-holds-row-h1");
    expect(row.getAttribute("data-status")).toBe("LAPSED");
    expect(screen.getByText("booking.actHoldLapsedLine")).toBeTruthy();
    expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
    expect(screen.queryByTestId("act-holds-release-h1")).toBeNull();
  });

  it("keeps its callbacks on the mutation, not on mutate(), so a remount mid-flight cannot drop them", () => {
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );
    fireEvent.click(screen.getByTestId("act-holds-keep-h1"));

    // The panel moves between two slots in SentBookingRequestsList when the
    // thread opens or closes; callbacks handed to mutate() die with the
    // observer, callbacks on useMutation() survive it.
    const o = opts();
    expect(typeof o.onSuccess).toBe("function");
    expect(typeof o.onError).toBe("function");
    expect(typeof o.onSettled).toBe("function");
    expect(mocks.answerMutate).toHaveBeenCalledTimes(1);
    expect(mocks.answerMutate.mock.calls[0]!.length).toBe(1);
  });

  it("renders only the act's own projection — never another act, a calendar or a space", () => {
    // The wire projects `{id, date, position, status, respondBy, lapsed}` and
    // nothing more; if something wider ever leaks through, the panel must
    // still not show it. An over-wide object is forced past the type on
    // purpose, and a second act's row rides along.
    const leaky = {
      ...hold({ status: "CHALLENGED", respondBy: IN_A_DAY }),
      actName: "LEAKED_ACT_NAME",
      calendarId: "LEAKED_CALENDAR_ID",
      spaceId: "LEAKED_SPACE_ID",
      act: { name: "LEAKED_OTHER_ACT" },
    } as unknown as ActHold;
    const { container } = render(
      <ActHoldsPanel bookingRequestId={REQUEST_ID} holds={[leaky]} />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("LEAKED_ACT_NAME");
    expect(text).not.toContain("LEAKED_CALENDAR_ID");
    expect(text).not.toContain("LEAKED_SPACE_ID");
    expect(text).not.toContain("LEAKED_OTHER_ACT");
    expect(container.innerHTML).not.toContain("LEAKED_");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("disables both buttons while an answer is in flight; Keep alone shows the spinner", () => {
    mocks.isPending.current = true;
    render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    const keep = screen.getByTestId("act-holds-keep-h1") as HTMLButtonElement;
    const release = screen.getByTestId("act-holds-release-h1") as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(release.disabled).toBe(true);
    // No answer has been chosen in this render, so no spinner anywhere: the
    // spinner belongs to the row being answered, and only to Keep.
    expect(keep.textContent).not.toContain("loading");
    expect(release.textContent).not.toContain("loading");
  });

  it("shows the spinner on Keep for the row being kept, and not when Release is the pending answer", () => {
    // mutate() never settles here, so pendingHoldId stays set and the
    // re-render after the click reads isPending=true from the mock.
    mocks.answerMutate.mockImplementation(() => {
      mocks.isPending.current = true;
    });
    const { rerender } = render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-keep-h1"));
    rerender(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );
    const keep = screen.getByTestId("act-holds-keep-h1") as HTMLButtonElement;
    const release = screen.getByTestId("act-holds-release-h1") as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(release.disabled).toBe(true);
    expect(keep.textContent).toContain("loading");
    expect(release.textContent).not.toContain("loading");
  });

  it("does not put the spinner on Keep while Release is the pending answer", () => {
    mocks.answerMutate.mockImplementation(() => {
      mocks.isPending.current = true;
    });
    const { rerender } = render(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );

    fireEvent.click(screen.getByTestId("act-holds-release-h1"));
    fireEvent.click(screen.getByTestId("confirm-yes"));
    rerender(
      <ActHoldsPanel
        bookingRequestId={REQUEST_ID}
        holds={[hold({ status: "CHALLENGED", respondBy: IN_A_DAY })]}
      />,
    );
    // releaseTarget is still set (the mutation has not settled), so Keep must
    // not claim the in-flight state as its own.
    const keep = screen.getByTestId("act-holds-keep-h1") as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(keep.textContent).not.toContain("loading");
    expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
  });

  describe("what Keep will do (FR-014)", () => {
    const challenged = () => [hold({ status: "CHALLENGED", position: 1, respondBy: IN_A_DAY })];

    it("reads the act's own holds, as the act", () => {
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(mocks.actReadInput.current).toEqual({ bookingRequestId: REQUEST_ID, viewer: "act" });
    });

    it("book_now: says keeping books the night, labels it, and sends expectedKeepWill book_now", () => {
      actRead("book_now");
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.getByText("booking.actHoldKeepWillBook")).toBeTruthy();
      expect(screen.getByTestId("act-holds-keep-h1").textContent).toContain("booking.actHoldKeepAndBook");
      fireEvent.click(screen.getByTestId("act-holds-keep-h1"));
      expect(mocks.answerMutate.mock.calls[0]![0]).toEqual({
        holdId: "h1",
        answer: "keep",
        expectedKeepWill: "book_now",
      });
    });

    it("ask_for_terms: says Keep asks the place for terms", () => {
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.getByText("booking.actHoldKeepWillAsk")).toBeTruthy();
      expect(screen.getByTestId("act-holds-keep-h1").textContent).toContain("booking.actHoldKeep");
    });

    it("kept: no Keep, the (server's, pushed) deadline to agree the terms", () => {
      const later = new Date(IN_A_DAY.getTime() + 24 * 3_600_000);
      actRead("ask_for_terms", true, later);
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
      expect(screen.getByText(new RegExp(`booking\\.actHoldKeptAwaiting.*${later.toISOString()}`))).toBeTruthy();
      expect(screen.getByTestId("act-holds-release-h1")).toBeTruthy();
    });

    it("kept, then the terms arrived: Keep is back as 'agree & book'", () => {
      actRead("book_now", true);
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.getByTestId("act-holds-keep-h1").textContent).toContain("booking.actHoldKeepAndBook");
      fireEvent.click(screen.getByTestId("act-holds-keep-h1"));
      expect(mocks.answerMutate.mock.calls[0]![0]).toMatchObject({ expectedKeepWill: "book_now" });
    });

    it("names every button by its date (two challenged holds never share a name)", () => {
      actRead("book_now");
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.getByTestId("act-holds-keep-h1").getAttribute("aria-label")).toBe(
        'booking.actHoldKeepAndBookAction:{"date":"2026-10-13"}',
      );
      expect(screen.getByTestId("act-holds-release-h1").getAttribute("aria-label")).toBe(
        'booking.actHoldReleaseAction:{"date":"2026-10-13"}',
      );
    });

    it("terms agreed: no Keep, and says the place books it", () => {
      actRead(null);
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
      expect(screen.getByText("booking.actHoldTermsAgreedLine")).toBeTruthy();
    });

    it("while the read loads, or after it fails, Keep is withheld (it may need expectedKeepWill)", () => {
      mocks.actRead.current = { data: undefined, isSuccess: false, isError: false, refetch: mocks.refetch };
      const { unmount } = render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
      expect(screen.getByText("booking.actHoldKeepChecking")).toBeTruthy();
      unmount();

      mocks.actRead.current = { data: undefined, isSuccess: false, isError: true, refetch: mocks.refetch };
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      expect(screen.queryByTestId("act-holds-keep-h1")).toBeNull();
      fireEvent.click(screen.getByTestId("act-holds-recheck-h1"));
      expect(mocks.refetch).toHaveBeenCalled();
    });

    it("a 'Keep changed' refusal refetches and says so — never retries", () => {
      actRead("book_now");
      settleWithError({ data: { appCode: "TERMS_CHANGED_SINCE_VIEWED" } });
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      fireEvent.click(screen.getByTestId("act-holds-keep-h1"));
      expect(mocks.answerMutate).toHaveBeenCalledTimes(1);
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        expect.objectContaining({ title: "booking.actHoldKeepChanged" }),
      );
      expect(mocks.toast.danger).not.toHaveBeenCalled();
      expect(mocks.holdsInvalidate).toHaveBeenCalledWith({ bookingRequestId: REQUEST_ID });
    });

    it("a booking keep says the night is booked", () => {
      actRead("book_now");
      mocks.answerMutate.mockImplementation((vars: { holdId: string; answer: "keep" | "release" }) => {
        opts().onSuccess?.({ keepOutcome: "booked" }, vars);
        opts().onSettled?.();
      });
      render(<ActHoldsPanel bookingRequestId={REQUEST_ID} holds={challenged()} />);
      fireEvent.click(screen.getByTestId("act-holds-keep-h1"));
      expect(mocks.toast.success).toHaveBeenCalledWith(
        expect.objectContaining({ title: "booking.actHoldKeptBookedToast" }),
      );
    });
  });
});
