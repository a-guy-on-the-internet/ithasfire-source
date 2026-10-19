import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { EntityReportItem } from "../EntityReportQueueView";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = React.forwardRef<HTMLDivElement, { children?: ReactNode }>(
    ({ children, ...props }, ref) => {
      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
          safe[key] = value;
      }
      return React.createElement("div", { ...safe, ref }, children);
    },
  );
  return { XStack: Stack, YStack: Stack, Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    // Forwards aria-* so accessible-name assertions can't pass against a
    // mock that swallows them (the two-Save-buttons defect class).
    Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
      ({ children, onPress, disabled, ...props }, ref) => {
        const safe: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key.startsWith("aria-")) safe[key] = value;
        }
        return (
          <button
            type="button"
            ref={ref}
            onClick={onPress as (() => void) | undefined}
            disabled={disabled as boolean | undefined}
            {...safe}
          >
            {children as ReactNode}
          </button>
        );
      },
    ),
    CharCountTextarea: ({
      value,
      onChange,
      testIdBase,
      disabled,
    }: {
      value: string;
      onChange: (next: string) => void;
      testIdBase?: string;
      disabled?: boolean;
    }) => (
      <textarea
        data-testid={testIdBase}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
    NextLinkAnchor: ({
      href,
      target,
      children,
    }: {
      href: string;
      target?: string;
      children?: ReactNode;
    }) => (
      <a href={href} target={target}>
        {children}
      </a>
    ),
    Spinner: () => <div data-testid="spinner" />,
    // Forwards ref + tabIndex so the heading-focus path is exercisable
    // (jsdom only honours focus() on focusable elements).
    Text: React.forwardRef<
      HTMLSpanElement,
      { children?: ReactNode; tabIndex?: number }
    >(({ children, tabIndex }, ref) => (
      <span ref={ref} tabIndex={tabIndex}>
        {children}
      </span>
    )),
    useFormatters: () => ({ locale: "en" }),
    useTranslations:
      () =>
      (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

vi.mock("lucide-react", () => {
  const icon =
    (name: string) =>
    ({
      size: _size,
      style: _style,
      ...rest
    }: Record<string, unknown> & { size?: number; style?: unknown }) => (
      <span data-icon={name} {...rest} />
    );
  return {
    Check: icon("check"),
    ExternalLink: icon("external-link"),
    Flag: icon("flag"),
    X: icon("x"),
  };
});

import { EntityReportQueueView } from "../EntityReportQueueView";

const basePlaceReport: EntityReportItem = {
  id: "report-1",
  subjectType: "PLACE",
  subjectId: "11111111-1111-4111-8111-111111111111",
  subjectName: null,
  subjectSlug: null,
  reporterHumanId: "22222222-2222-4222-8222-222222222222",
  reporterName: null,
  reason: "CLOSED_OR_GONE",
  details: null,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const otherReportWithDetails: EntityReportItem = {
  id: "report-2",
  subjectType: "HUMAN",
  subjectId: "33333333-3333-4333-8333-333333333333",
  subjectName: null,
  subjectSlug: null,
  reporterHumanId: "44444444-4444-4444-8444-444444444444",
  reporterName: null,
  reason: "OTHER",
  details: "First line of context.\nSecond line of context.",
  createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
};

const baseProps = {
  isLoading: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isReviewPending: false,
  onRetry: vi.fn(),
  onLoadMore: vi.fn(),
  onReview: vi.fn(),
};

describe("EntityReportQueueView", () => {
  it("renders the loading spinner band", () => {
    render(
      <EntityReportQueueView {...baseProps} items={[]} isLoading />,
    );
    expect(screen.getByTestId("spinner")).toBeTruthy();
  });

  it("renders the error band and retries", () => {
    const onRetry = vi.fn();
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[]}
        isError
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("moderation.loadError")).toBeTruthy();
    fireEvent.click(screen.getByText("moderation.retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state", () => {
    render(<EntityReportQueueView {...baseProps} items={[]} />);
    expect(screen.getByText("moderation.reportsEmpty")).toBeTruthy();
    expect(screen.getByText("moderation.reportsEmptyHint")).toBeTruthy();
  });

  it("renders the pending-count chip beside the heading, tracking the query data", () => {
    const view = render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        pendingCount={3}
      />,
    );
    expect(
      screen.getByText("moderation.reportsPendingCount 3"),
    ).toBeTruthy();

    // Updates when a fresher page reports a different total…
    view.rerender(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        pendingCount={2}
      />,
    );
    expect(
      screen.getByText("moderation.reportsPendingCount 2"),
    ).toBeTruthy();

    // …and disappears entirely at zero / before any data.
    view.rerender(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        pendingCount={0}
      />,
    );
    expect(
      screen.queryByText(/moderation\.reportsPendingCount/),
    ).toBeNull();
  });

  it("links the hydrated subject name to its typed public route, new tab", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[
          {
            ...basePlaceReport,
            id: "r-place",
            subjectName: "The Velvet Room",
            subjectSlug: "velvet-room",
          },
          {
            ...otherReportWithDetails,
            id: "r-human",
            subjectType: "HUMAN",
            subjectName: "Jane Doe",
            subjectSlug: "jane-doe",
          },
          {
            ...basePlaceReport,
            id: "r-org",
            subjectType: "ORGANIZATION",
            reason: "SPAM",
            subjectName: "DEV QA Collective",
            subjectSlug: "dev-qa-collective",
          },
        ]}
      />,
    );

    const placeLink = screen.getByText("The Velvet Room").closest("a");
    expect(placeLink?.getAttribute("href")).toBe("/places/velvet-room");
    expect(placeLink?.getAttribute("target")).toBe("_blank");
    expect(
      screen.getByText("Jane Doe").closest("a")?.getAttribute("href"),
    ).toBe("/humans/jane-doe");
    expect(
      screen
        .getByText("DEV QA Collective")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/orgs/dev-qa-collective");
  });

  it("renders the subject name unlinked when only the slug is missing", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[
          {
            ...basePlaceReport,
            subjectName: "The Velvet Room",
            subjectSlug: null,
          },
        ]}
      />,
    );
    const name = screen.getByText("The Velvet Room");
    expect(name.closest("a")).toBeNull();
    // The uuid chip is only the NAMELESS fallback.
    expect(screen.queryByText(basePlaceReport.subjectId)).toBeNull();
  });

  it("falls back to the unlinked type + id chip when the subject name is null", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport, otherReportWithDetails]}
      />,
    );

    expect(
      screen.getByText("moderation.reportsReasonClosedOrGone"),
    ).toBeTruthy();
    expect(screen.getByText("moderation.reportsReasonOther")).toBeTruthy();
    expect(screen.getByText("moderation.reportsSubjectPlace")).toBeTruthy();
    expect(screen.getByText("moderation.reportsSubjectHuman")).toBeTruthy();
    // Deleted-subject / degraded-hydration posture: raw id chip, no link.
    expect(screen.getByText(basePlaceReport.subjectId)).toBeTruthy();
    expect(document.querySelector("a")).toBeNull();
    expect(screen.getByText(basePlaceReport.reporterHumanId)).toBeTruthy();
    expect(
      screen.getAllByText(/^moderation\.reportsReportedAt /).length,
    ).toBe(2);
  });

  it("renders OTHER details as text with line breaks preserved, and a no-details fallback", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport, otherReportWithDetails]}
      />,
    );

    // The regex matcher normalizes whitespace to FIND the node; the raw
    // textContent assertion proves the newline itself survived (the view
    // renders details verbatim and preserves breaks via CSS pre-wrap).
    const details = screen.getByText(/First line of context\./);
    expect(details.textContent).toBe(
      "First line of context.\nSecond line of context.",
    );
    expect(screen.getByText("moderation.reportsNoDetails")).toBeTruthy();
  });

  it("clamps long details behind a Show more toggle", () => {
    const long = { ...otherReportWithDetails, details: "x".repeat(400) };
    render(<EntityReportQueueView {...baseProps} items={[long]} />);

    const toggle = screen.getByText("moderation.reportsShowMore");
    fireEvent.click(toggle);
    expect(screen.getByText("moderation.reportsShowLess")).toBeTruthy();
  });

  it("does not offer a toggle for short details", () => {
    render(
      <EntityReportQueueView {...baseProps} items={[otherReportWithDetails]} />,
    );
    expect(screen.queryByText("moderation.reportsShowMore")).toBeNull();
  });

  it("renders the hydrated reporter name, uuid chip only as the null fallback", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[
          { ...basePlaceReport, reporterName: "Jane Reporter" },
          otherReportWithDetails,
        ]}
      />,
    );

    // Named reporter: name shown, uuid suppressed.
    expect(screen.getByText("Jane Reporter")).toBeTruthy();
    expect(screen.queryByText(basePlaceReport.reporterHumanId)).toBeNull();
    // Null reporter (deleted human / degraded hydration): uuid fallback.
    expect(
      screen.getByText(otherReportWithDetails.reporterHumanId),
    ).toBeTruthy();
  });

  it("gives every Review CTA a unique accessible name (subject name or chip text)", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[
          {
            ...basePlaceReport,
            subjectName: "The Velvet Room",
            subjectSlug: "velvet-room",
          },
          otherReportWithDetails,
        ]}
      />,
    );

    const ctas = screen.getAllByText("moderation.reportsReviewCta");
    const labels = ctas.map((el) =>
      el.closest("button")?.getAttribute("aria-label"),
    );
    // Named row uses the subject name; nameless row uses the type + id chip
    // text — both unique, neither a bare "Review".
    expect(labels).toEqual([
      "moderation.reportsReviewAria The Velvet Room",
      `moderation.reportsReviewAria moderation.reportsSubjectHuman ${otherReportWithDetails.subjectId}`,
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("focuses the note textarea when the panel opens", () => {
    render(
      <EntityReportQueueView {...baseProps} items={[basePlaceReport]} />,
    );
    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    expect(document.activeElement).toBe(
      screen.getByTestId("moderation-report-note"),
    );
  });

  it("returns focus to the row's Review CTA on Close", () => {
    render(
      <EntityReportQueueView {...baseProps} items={[basePlaceReport]} />,
    );
    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    fireEvent.click(screen.getByText("moderation.close"));

    const cta = screen
      .getByText("moderation.reportsReviewCta")
      .closest("button");
    expect(document.activeElement).toBe(cta);
  });

  it("resolves with the trimmed note, closes the panel, and moves focus to the heading", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        onReview={onReview}
      />,
    );

    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    fireEvent.change(screen.getByTestId("moderation-report-note"), {
      target: { value: "  handled it  " },
    });
    fireEvent.click(screen.getByText("moderation.reportsResolve"));

    // `onReview` is invoked from a microtask (Promise.resolve().then) — flush
    // before asserting.
    await act(async () => {});
    expect(onReview).toHaveBeenCalledWith(
      "report-1",
      "RESOLVED",
      "handled it",
    );
    // Panel closed → note textarea gone, Review CTA back, focus on heading.
    expect(screen.queryByTestId("moderation-report-note")).toBeNull();
    expect(screen.getByText("moderation.reportsReviewCta")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByText("moderation.reportsTitle"),
    );
  });

  it("dismisses with no note as undefined", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        onReview={onReview}
      />,
    );

    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    fireEvent.click(screen.getByText("moderation.reportsDismiss"));

    await act(async () => {});
    expect(onReview).toHaveBeenCalledWith("report-1", "DISMISSED", undefined);
  });

  it("keeps the panel (and note) open when the review fails", async () => {
    const onReview = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        onReview={onReview}
      />,
    );

    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    fireEvent.change(screen.getByTestId("moderation-report-note"), {
      target: { value: "my note" },
    });
    fireEvent.click(screen.getByText("moderation.reportsResolve"));
    await act(async () => {});

    const textarea = screen.getByTestId(
      "moderation-report-note",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("my note");
  });

  it("keys the success-close to the submitting row: a late success on A never wipes B's panel", async () => {
    let resolveA!: () => void;
    const onReview = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport, otherReportWithDetails]}
        onReview={onReview}
      />,
    );

    // Open A's panel and submit (promise stays pending).
    fireEvent.click(
      screen.getAllByText("moderation.reportsReviewCta")[0],
    );
    fireEvent.click(screen.getByText("moderation.reportsResolve"));
    await act(async () => {});
    expect(onReview).toHaveBeenCalledWith("report-1", "RESOLVED", undefined);

    // Moderator moves on: opens B's panel and starts typing a note.
    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    fireEvent.change(screen.getByTestId("moderation-report-note"), {
      target: { value: "b-note" },
    });

    // A's verdict lands late — B's panel and in-progress note must survive.
    resolveA();
    await act(async () => {});
    const textarea = screen.getByTestId(
      "moderation-report-note",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("b-note");
  });

  it("marks the decorative X icon aria-hidden (as the Check already is)", () => {
    render(
      <EntityReportQueueView {...baseProps} items={[basePlaceReport]} />,
    );
    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));

    const x = document.querySelector('[data-icon="x"]');
    expect(x?.getAttribute("aria-hidden")).toBe("true");
    const check = document.querySelector('[data-icon="check"]');
    expect(check?.getAttribute("aria-hidden")).toBe("true");
  });

  it("disables review controls while a mutation is pending", () => {
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        isReviewPending
      />,
    );
    fireEvent.click(screen.getByText("moderation.reportsReviewCta"));
    const resolveBtn = screen
      .getByText("moderation.reportsResolve")
      .closest("button");
    expect(resolveBtn?.disabled).toBe(true);
  });

  it("shows Load more when a next page exists", () => {
    const onLoadMore = vi.fn();
    render(
      <EntityReportQueueView
        {...baseProps}
        items={[basePlaceReport]}
        hasNextPage
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByText("moderation.loadMore"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
