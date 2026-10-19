import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { EntityReportQueueViewProps } from "../EntityReportQueueView";

/**
 * Container tests for EntityReportQueue: data mapping, mutation payload, and
 * the toast branches (success / CONFLICT race / generic failure / 2FA).
 * The pure view is mocked out and its props captured; the mutation OPTIONS
 * passed to `useMutation` are captured so onSuccess/onError run directly.
 */

type MutationOptions = {
  meta?: { silent?: boolean };
  onSuccess?: (data: unknown, vars: { verdict: string }) => void;
  onError?: (err: unknown) => void;
};

const testState = vi.hoisted(() => ({
  viewProps: null as EntityReportQueueViewProps | null,
  mutationOptions: null as MutationOptions | null,
  mutateAsync: vi.fn(),
  invalidate: vi.fn(),
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    danger: vi.fn(),
    warning: vi.fn(),
  },
  handleSecondFactor: vi.fn(() => false),
  infiniteData: {
    pages: [
      {
        items: [
          {
            id: "report-1",
            subjectType: "PLACE",
            subjectId: "11111111-1111-4111-8111-111111111111",
            subjectName: "The Velvet Room",
            subjectSlug: "velvet-room",
            reporterHumanId: "22222222-2222-4222-8222-222222222222",
            reporterName: "Jane Reporter",
            reason: "SPAM",
            details: null,
            status: "PENDING",
            reviewedByHumanId: null,
            reviewedAt: null,
            reviewNote: null,
            createdAt: new Date("2026-08-17T10:00:00.000Z"),
            updatedAt: new Date("2026-08-17T10:00:00.000Z"),
          },
        ],
        nextCursor: "cursor-1",
        pendingCount: 3,
      },
      // A second (fresher) page whose pendingCount reflects reviews that
      // happened since the first fetch — the container must surface THIS one.
      {
        items: [],
        nextCursor: null,
        pendingCount: 2,
      },
    ],
  },
}));

vi.mock("../EntityReportQueueView", () => ({
  EntityReportQueueView: (props: EntityReportQueueViewProps) => {
    testState.viewProps = props;
    return <div data-testid="queue-view" />;
  },
}));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: testState.toast }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => testState.handleSecondFactor,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    entityReports: {
      listForModeration: {
        useInfiniteQuery: () => ({
          data: testState.infiniteData,
          isLoading: false,
          isError: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          refetch: vi.fn(),
          fetchNextPage: vi.fn(),
        }),
      },
      review: {
        useMutation: (options: MutationOptions) => {
          testState.mutationOptions = options;
          return { mutateAsync: testState.mutateAsync, isPending: false };
        },
      },
    },
    useUtils: () => ({
      entityReports: {
        listForModeration: { invalidate: testState.invalidate },
      },
    }),
  },
}));

import { EntityReportQueue } from "../EntityReportQueue";

describe("EntityReportQueue container", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.viewProps = null;
    testState.mutationOptions = null;
    testState.handleSecondFactor.mockReturnValue(false);
  });

  it("maps list pages to view items with ISO createdAt", () => {
    render(<EntityReportQueue />);
    expect(testState.viewProps?.items).toEqual([
      {
        id: "report-1",
        subjectType: "PLACE",
        subjectId: "11111111-1111-4111-8111-111111111111",
        subjectName: "The Velvet Room",
        subjectSlug: "velvet-room",
        reporterHumanId: "22222222-2222-4222-8222-222222222222",
        reporterName: "Jane Reporter",
        reason: "SPAM",
        details: null,
        createdAt: "2026-08-17T10:00:00.000Z",
      },
    ]);
  });

  it("surfaces the FRESHEST page's pendingCount to the view", () => {
    render(<EntityReportQueue />);
    expect(testState.viewProps?.pendingCount).toBe(2);
  });

  it("opts out of the global mutation error toast (it handles all branches)", () => {
    render(<EntityReportQueue />);
    expect(testState.mutationOptions?.meta).toEqual({ silent: true });
  });

  it("submits verdict + trimmed note through mutateAsync", async () => {
    testState.mutateAsync.mockResolvedValue({});
    render(<EntityReportQueue />);

    await testState.viewProps?.onReview("report-1", "RESOLVED", "  note  ");
    expect(testState.mutateAsync).toHaveBeenCalledWith({
      reportId: "report-1",
      verdict: "RESOLVED",
      reviewNote: "note",
    });

    await testState.viewProps?.onReview("report-1", "DISMISSED", undefined);
    expect(testState.mutateAsync).toHaveBeenLastCalledWith({
      reportId: "report-1",
      verdict: "DISMISSED",
      reviewNote: undefined,
    });
  });

  it("toasts per verdict and invalidates on success", () => {
    render(<EntityReportQueue />);

    testState.mutationOptions?.onSuccess?.({}, { verdict: "RESOLVED" });
    expect(testState.toast.success).toHaveBeenCalledWith({
      title: "moderation.reportsResolvedToast",
    });

    testState.mutationOptions?.onSuccess?.({}, { verdict: "DISMISSED" });
    expect(testState.toast.success).toHaveBeenLastCalledWith({
      title: "moderation.reportsDismissedToast",
    });
    expect(testState.invalidate).toHaveBeenCalledTimes(2);
  });

  it("handles the CONFLICT race with an info toast + refetch, not a hard error", () => {
    render(<EntityReportQueue />);

    testState.mutationOptions?.onError?.(
      new Error("report_already_reviewed"),
    );

    expect(testState.toast.info).toHaveBeenCalledWith({
      title: "moderation.reportsAlreadyReviewedToast",
    });
    expect(testState.invalidate).toHaveBeenCalledTimes(1);
    expect(testState.toast.danger).not.toHaveBeenCalled();
  });

  it("shows a danger toast for other failures", () => {
    render(<EntityReportQueue />);

    testState.mutationOptions?.onError?.(new Error("entity_report_not_found"));

    expect(testState.toast.danger).toHaveBeenCalledTimes(1);
    expect(testState.toast.info).not.toHaveBeenCalled();
  });

  it("defers to the 2FA step-up handler before any other branch", () => {
    testState.handleSecondFactor.mockReturnValue(true);
    render(<EntityReportQueue />);

    testState.mutationOptions?.onError?.(new Error("SECOND_FACTOR_REQUIRED"));

    expect(testState.handleSecondFactor).toHaveBeenCalledTimes(1);
    expect(testState.toast.danger).not.toHaveBeenCalled();
    expect(testState.toast.info).not.toHaveBeenCalled();
  });
});
