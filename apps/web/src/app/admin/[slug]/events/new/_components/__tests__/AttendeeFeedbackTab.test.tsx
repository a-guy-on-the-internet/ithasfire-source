import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AttendeeFeedbackTab (attendee-reviews FR-007): the private owner-facing
 * feedback surface. Pins:
 *  - it renders the organizer's EXACT aggregate (means + recommend + count),
 *  - it lists UNATTRIBUTED comments and invents no name/rating,
 *  - the per-item Report action calls flagFeedback({ reviewId }),
 *  - a flagged item shows the "reported" state instead of the button,
 *  - loading / error / empty states render honestly,
 *  - the flagged/unflagged chips narrow the CLIENT-side list (the only filter
 *    axis the contract carries), and
 *  - the pager slices the FILTERED array and resets to page 0 on a filter
 *    change.
 *
 * `@/components/AdminTableParts` is NOT mocked — the real FilterRow /
 * FilterChips / Pagination / NoResults render here, which is why the lucide
 * and @th/ui mocks below cover their imports too.
 */

type QueryResult = {
  data?: unknown;
  isPending?: boolean;
  isError?: boolean;
  isFetching?: boolean;
  refetch?: () => void;
};

let feedbackResult: QueryResult = {};
const flagMutate = vi.fn();
let flagState = {
  isPending: false,
  variables: undefined as { reviewId: string } | undefined,
};
let flagOnSuccess: (() => void) | undefined;
let flagOnError: (() => void) | undefined;
const invalidate = vi.fn();
const toastSuccess = vi.fn();
const toastDanger = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return {
    XStack: passthrough,
    YStack: passthrough,
    styled: () => passthrough,
  };
});

// Flag/Check are this component's; the rest are AdminTableParts' (FilterChips,
// FilterRow, Pagination and the parts they import at module scope).
vi.mock("lucide-react", () => {
  const stub = (name: string) => () => <span data-testid={`icon-${name}`} />;
  return {
    Flag: stub("flag"),
    Check: stub("check"),
    Filter: stub("filter"),
    X: stub("x"),
    ChevronLeft: stub("chevron-left"),
    ChevronRight: stub("chevron-right"),
    RefreshCw: stub("refresh"),
    Plus: stub("plus"),
    Search: stub("search"),
    Columns3: stub("columns"),
    AlertTriangle: stub("alert"),
  };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  // AdminTableParts imports these at module scope (ColumnSelector / SearchBar);
  // neither renders on this surface, but a missing mock export throws on import.
  Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: () => <input />,
  Text: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  useNotify: () => ({
    toast: { success: toastSuccess, danger: toastDanger },
  }),
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      attendeeReviews: { listEventFeedback: { invalidate } },
    }),
    attendeeReviews: {
      listEventFeedback: { useQuery: () => feedbackResult },
      flagFeedback: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: () => void;
        }) => {
          flagOnSuccess = opts?.onSuccess;
          flagOnError = opts?.onError;
          return { mutate: flagMutate, ...flagState };
        },
      },
    },
  },
}));

import { AttendeeFeedbackTab } from "../AttendeeFeedbackTab";

const AGGREGATE = {
  reviewCount: 12,
  overallMean: 4.25,
  soundQualityMean: 3.8,
  venueComfortMean: null,
  organizationMean: 4.6,
  valueForMoneyMean: 2.1,
  recommendPct: 83.3,
};

describe("AttendeeFeedbackTab", () => {
  beforeEach(() => {
    feedbackResult = {};
    flagMutate.mockClear();
    invalidate.mockClear();
    toastSuccess.mockClear();
    toastDanger.mockClear();
    flagState = { isPending: false, variables: undefined };
  });

  it("shows a loading state", () => {
    feedbackResult = { isPending: true };
    render(<AttendeeFeedbackTab eventId="e1" />);
    expect(screen.getByText("attendeeFeedback.loading")).toBeInTheDocument();
  });

  it("shows an actionable error state", () => {
    const refetch = vi.fn();
    feedbackResult = { isError: true, isFetching: false, refetch };
    render(<AttendeeFeedbackTab eventId="e1" />);
    expect(
      screen.getByText("attendeeFeedback.errorMessage"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("attendeeFeedback.retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("shows an honest empty state when there are no reviews", () => {
    feedbackResult = {
      isPending: false,
      data: { aggregate: { ...AGGREGATE, reviewCount: 0 }, feedback: [] },
    };
    render(<AttendeeFeedbackTab eventId="e1" />);
    expect(
      screen.getByTestId("attendee-feedback-empty"),
    ).toBeInTheDocument();
    expect(screen.getByText("attendeeFeedback.emptyTitle")).toBeInTheDocument();
  });

  it("renders the exact aggregate, present facets only", () => {
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback: [] },
    };
    render(<AttendeeFeedbackTab eventId="e1" />);

    // Review count band.
    expect(
      screen.getByText("attendeeFeedback.reviewCount count=12"),
    ).toBeInTheDocument();
    // Means to one decimal.
    expect(
      screen.getByText("attendeeFeedback.scoreOutOf score=4.3"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("attendeeFeedback.scoreOutOf score=3.8"),
    ).toBeInTheDocument();
    expect(screen.getByText("attendeeFeedback.aggOverall")).toBeInTheDocument();
    // Recommend percent rounded.
    expect(screen.getByText("83%")).toBeInTheDocument();
    // A null facet (venue comfort) is absent, never zeroed.
    expect(
      screen.queryByText("attendeeFeedback.aggVenueComfort"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("attendeeFeedback.aggValue")).toBeInTheDocument();
    // No written comments → the quiet note.
    expect(
      screen.getByTestId("attendee-feedback-no-comments"),
    ).toBeInTheDocument();
  });

  it("lists unattributed comments and reports one via flagFeedback", () => {
    feedbackResult = {
      isPending: false,
      data: {
        aggregate: AGGREGATE,
        feedback: [
          { reviewId: "r1", text: "Great sound, ran late.", flagged: false },
          { reviewId: "r2", text: "Already reported one.", flagged: true },
        ],
      },
    };
    render(<AttendeeFeedbackTab eventId="e1" />);

    // Both comment texts render; no name/rating is invented anywhere.
    expect(screen.getByText("Great sound, ran late.")).toBeInTheDocument();
    expect(screen.getByText("Already reported one.")).toBeInTheDocument();

    // The flagged item shows the reported state, not a report button.
    expect(
      screen.getByTestId("attendee-feedback-reported"),
    ).toBeInTheDocument();

    // Exactly one report button (for the un-flagged item); clicking it flags r1.
    const reportButtons = screen.getAllByTestId("attendee-feedback-report");
    expect(reportButtons).toHaveLength(1);
    fireEvent.click(reportButtons[0]);
    expect(flagMutate).toHaveBeenCalledWith({ reviewId: "r1" });
  });

  // ── Filter + pager (client-side, over the already-fetched array) ───────

  /** `count` comments, every `flagEvery`-th one flagged. */
  function comments(count: number, flagEvery = 0) {
    return Array.from({ length: count }, (_, i) => ({
      reviewId: `r${i + 1}`,
      text: `Comment ${i + 1}`,
      flagged: flagEvery > 0 && (i + 1) % flagEvery === 0,
    }));
  }

  function renderWith(feedback: ReturnType<typeof comments>) {
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback },
    };
    return render(<AttendeeFeedbackTab eventId="e1" />);
  }

  const cardCount = () =>
    screen.queryAllByTestId("attendee-feedback-comment").length;

  it("narrows the list to reported comments, and back on deselect", () => {
    // 1..6, every 3rd flagged → r3, r6.
    renderWith(comments(6, 3));
    expect(cardCount()).toBe(6);

    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));
    expect(cardCount()).toBe(2);
    expect(screen.getByText("Comment 3")).toBeInTheDocument();
    expect(screen.getByText("Comment 6")).toBeInTheDocument();
    expect(screen.queryByText("Comment 1")).not.toBeInTheDocument();
    // The count kicker reports the FILTERED total, not the raw one.
    expect(
      screen.getByText("attendeeFeedback.commentCountFiltered shown=2 total=6"),
    ).toBeInTheDocument();

    // Pressing the active chip again deselects → default scope (all).
    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));
    expect(cardCount()).toBe(6);
  });

  it("narrows to unreported comments", () => {
    renderWith(comments(6, 3));
    fireEvent.click(screen.getByText("attendeeFeedback.filterUnflagged"));
    expect(cardCount()).toBe(4);
    expect(screen.queryByText("Comment 3")).not.toBeInTheDocument();
  });

  it("pages the list ten at a time", () => {
    renderWith(comments(14));
    expect(cardCount()).toBe(10);
    expect(screen.getByText("Comment 1")).toBeInTheDocument();
    expect(screen.queryByText("Comment 11")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("admin.atNext"));
    expect(cardCount()).toBe(4);
    expect(screen.getByText("Comment 11")).toBeInTheDocument();
    expect(screen.queryByText("Comment 1")).not.toBeInTheDocument();
  });

  it("pages the FILTERED array, not the raw one", () => {
    // 24 comments, every 2nd flagged → 12 flagged, 12 unflagged.
    renderWith(comments(24, 2));
    // Unfiltered: 24 rows → 3 pages.
    expect(
      screen.getByText("admin.atPageOf page=1 total=3"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));
    // 12 flagged → 2 pages, first page holds 10 of them.
    expect(
      screen.getByText("admin.atPageOf page=1 total=2"),
    ).toBeInTheDocument();
    expect(cardCount()).toBe(10);
    fireEvent.click(screen.getByLabelText("admin.atNext"));
    expect(cardCount()).toBe(2);
  });

  it("resets to the first page when the filter changes", () => {
    renderWith(comments(24, 2));
    fireEvent.click(screen.getByLabelText("admin.atNext"));
    expect(
      screen.getByText("admin.atPageOf page=2 total=3"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("attendeeFeedback.filterUnflagged"));
    expect(
      screen.getByText("admin.atPageOf page=1 total=2"),
    ).toBeInTheDocument();
    // First page of the filtered scope, from the top.
    expect(screen.getByText("Comment 1")).toBeInTheDocument();
  });

  it("hides the pager when everything fits on one page", () => {
    renderWith(comments(4));
    expect(screen.queryByLabelText("admin.atNext")).not.toBeInTheDocument();
  });

  it("offers a way out when the filter matches nothing", () => {
    renderWith(comments(3)); // none flagged
    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));

    expect(
      screen.getByTestId("attendee-feedback-no-matches"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("attendeeFeedback.noMatchTitle"),
    ).toBeInTheDocument();
    // NOT the "no comments at all" copy — that is a different situation.
    expect(
      screen.queryByTestId("attendee-feedback-no-comments"),
    ).not.toBeInTheDocument();
    expect(cardCount()).toBe(0);

    // The empty state's own clear button restores the default scope.
    fireEvent.click(screen.getByText("admin.atClearFiltersShowAll"));
    expect(cardCount()).toBe(3);
  });

  it("snaps back to the last real page when a refetch shrinks the scope", () => {
    // The ONE vector that can strand a page here: you are on the last page of
    // the UNFLAGGED scope and the post-report invalidation drops a row out of
    // it. Both clamps are exercised — the render clamp must show page 1's
    // rows immediately (not an empty list), and usePageClamp must converge the
    // state so the pager agrees.
    const { rerender } = renderWith(comments(11));
    fireEvent.click(screen.getByText("attendeeFeedback.filterUnflagged"));
    fireEvent.click(screen.getByLabelText("admin.atNext"));
    expect(cardCount()).toBe(1);
    expect(screen.getByText("Comment 11")).toBeInTheDocument();

    // …the 11th comment gets reported and leaves the unflagged scope.
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback: comments(10) },
    };
    rerender(<AttendeeFeedbackTab eventId="e1" />);

    expect(cardCount()).toBe(10);
    expect(screen.getByText("Comment 1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("attendee-feedback-no-matches"),
    ).not.toBeInTheDocument();
    // One page now, so the pager is gone rather than stranding the view.
    expect(screen.queryByLabelText("admin.atNext")).not.toBeInTheDocument();

    // This half is what pins usePageClamp specifically rather than the render
    // clamp: if the state had stayed at the stale page 2, a scope that grows
    // back would silently teleport the reader there. It converged, so a
    // later refetch leaves them where they are — on page 1.
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback: comments(20) },
    };
    rerender(<AttendeeFeedbackTab eventId="e1" />);
    expect(screen.getByText("Comment 1")).toBeInTheDocument();
    expect(screen.queryByText("Comment 11")).not.toBeInTheDocument();
  });

  it("keeps the two clear controls distinctly named in the no-match state", () => {
    // Both are on screen at once; two controls sharing one accessible name is
    // ambiguous for screen-reader and voice-control users. getByRole throws on
    // a duplicate, so this also pins that each name is unique.
    renderWith(comments(3));
    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));

    expect(
      screen.getByRole("button", { name: "admin.atClearFilters" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "admin.atClearFiltersShowAll" }),
    ).toBeInTheDocument();
  });

  it("says the aggregate is out of the filter's scope while a chip is on", () => {
    renderWith(comments(6, 3));
    expect(
      screen.getByText("attendeeFeedback.aggregateScope"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("attendeeFeedback.filterFlagged"));
    expect(
      screen.getByText("attendeeFeedback.aggregateScopeFiltered"),
    ).toBeInTheDocument();
    // The numbers themselves are NOT rescoped — they stay the event's own.
    expect(
      screen.getByText("attendeeFeedback.reviewCount count=12"),
    ).toBeInTheDocument();
  });

  it("shows no filter chips until there is prose to filter", () => {
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback: [] },
    };
    render(<AttendeeFeedbackTab eventId="e1" />);
    expect(
      screen.queryByText("attendeeFeedback.filterFlagged"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("attendee-feedback-no-comments"),
    ).toBeInTheDocument();
  });

  it("invalidates the list and toasts on a successful report", () => {
    feedbackResult = {
      isPending: false,
      data: { aggregate: AGGREGATE, feedback: [] },
    };
    render(<AttendeeFeedbackTab eventId="e1" />);
    flagOnSuccess?.();
    expect(invalidate).toHaveBeenCalledWith({ eventId: "e1" });
    expect(toastSuccess).toHaveBeenCalled();

    flagOnError?.();
    expect(toastDanger).toHaveBeenCalled();
  });
});
