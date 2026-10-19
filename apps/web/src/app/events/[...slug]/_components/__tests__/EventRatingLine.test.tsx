import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EventRatingLine (attendee-reviews FR-005c): a quiet snapshot-only rating line
 * under the organizer attribution on the public event page. Pins:
 *  - it renders the line only when a published aggregate summary exists,
 *  - it renders NOTHING (never blocks the page) while loading, on error, or
 *    when the subject is below threshold (snapshot / summary absent),
 *  - it reads the EVENT aggregate keyed by eventId (the "this event" framing).
 */

let queryResult: { data?: unknown } = {};
const useQuery = vi.fn((..._args: unknown[]) => queryResult);

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
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
    attendeeReviews: {
      getAggregate: {
        useQuery: (input: unknown, opts: unknown) => useQuery(input, opts),
      },
    },
  },
}));

import { EventRatingLine } from "../EventRatingLine";

describe("EventRatingLine", () => {
  beforeEach(() => {
    queryResult = {};
    useQuery.mockClear();
  });

  it("renders the rating line when a published summary exists", () => {
    queryResult = {
      data: {
        subjectType: "EVENT",
        subjectId: "e1",
        snapshot: {
          version: 1,
          summary: { reviewCountBand: "20+", overallScore: 4.5 },
        },
        computedAt: new Date(),
      },
    };
    render(<EventRatingLine eventId="e1" />);

    expect(screen.getByTestId("event-rating-line")).toHaveTextContent(
      "eventDetail.attendeeRatingLine score=4.5 count=20+",
    );
  });

  it("queries the EVENT aggregate keyed by eventId, retry disabled", () => {
    render(<EventRatingLine eventId="evt-123" />);
    expect(useQuery).toHaveBeenCalledWith(
      { subjectType: "EVENT", subjectId: "evt-123" },
      expect.objectContaining({ retry: false }),
    );
  });

  it("renders nothing while the query is empty/loading", () => {
    queryResult = { data: undefined };
    const { container } = render(<EventRatingLine eventId="e1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the aggregate is below threshold (no summary)", () => {
    queryResult = {
      data: {
        subjectType: "EVENT",
        subjectId: "e1",
        snapshot: { version: 1 },
        computedAt: null,
      },
    };
    const { container } = render(<EventRatingLine eventId="e1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no snapshot at all", () => {
    queryResult = {
      data: {
        subjectType: "EVENT",
        subjectId: "e1",
        snapshot: null,
        computedAt: null,
      },
    };
    const { container } = render(<EventRatingLine eventId="e1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
