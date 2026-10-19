import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventDealPage } from "../EventDealPage";

/**
 * The payee deal page (freeze-the-deal FR-007): the link in the deal-change
 * notice. Pinned: someone not on the deal gets a plain "not yours" state and
 * no deal; a missing event says so; a payee sees the event, the freeze and
 * every change, before struck → after.
 */

const EVENT_ID = "44444444-4444-4444-8444-444444444444";

type Result = { data?: unknown; error?: unknown; isLoading?: boolean };
let result: Result = {};
let visibility: "FULL" | "OWN_LINE" = "FULL";
const summaryRendered = vi.fn();

vi.mock("@/components/deals/DealChanges", async (orig) => {
  const real = await orig<typeof import("@/components/deals/DealChanges")>();
  return {
    ...real,
    useDealChangesFirstPage: () => ({
      data: result.data,
      error: result.error ?? null,
      isLoading: result.isLoading ?? false,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});
vi.mock("@/components/deals/DealSummary", () => ({
  DealSummary: ({ label }: { label?: ReactNode }) => {
    summaryRendered();
    return (
      <>
        {label}
        <p data-testid="summary">summary</p>
      </>
    );
  },
}));
vi.mock("@/trpc", () => ({
  trpc: {
    deals: {
      getTermsDeal: {
        useQuery: () => ({ data: { visibility } }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  Button: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  ),
  DateTime: { format: (d: Date) => d.toISOString().slice(0, 10) },
  NextLinkAnchor: ({
    children,
    href,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    href: string;
    "data-testid"?: string;
  }) => (
    <a href={href} data-testid={testId}>
      {children}
    </a>
  ),
  Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
  Spinner: () => <span />,
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { Info: Icon, Lock: Icon };
});

const appError = (appCode: string) =>
  Object.assign(new Error(appCode), { data: { appCode, code: "FORBIDDEN" } });

describe("EventDealPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    result = {};
    visibility = "FULL";
  });
  afterEach(cleanup);

  it("someone not on the deal is told so, and sees no deal", () => {
    result = { error: appError("INSUFFICIENT_ROLE") };
    render(<EventDealPage eventId={EVENT_ID} />);
    const box = screen.getByTestId("deal-page-not-allowed");
    expect(box.textContent).toContain("deals.page.notAllowedTitle");
    expect(box.textContent).toContain("deals.page.notAllowedBody");
    expect(screen.queryByTestId("summary")).toBeNull();
    expect(summaryRendered).not.toHaveBeenCalled();
  });

  it("an event that is gone says so", () => {
    result = { error: appError("EVENT_NOT_FOUND") };
    render(<EventDealPage eventId={EVENT_ID} />);
    expect(screen.getByTestId("deal-page-not-found").textContent).toContain(
      "deals.page.notFoundTitle",
    );
  });

  it("a payee sees the event, the freeze and each change", () => {
    result = {
      data: {
        eventId: EVENT_ID,
        event: {
          title: "Lowlight at Marrow Hall",
          startsAt: new Date("2026-10-25T01:00:00.000Z"),
          timezone: "America/Chicago",
          dealFrozenAt: new Date("2026-10-14T23:30:00.000Z"),
          frozenBy: null,
        },
        items: [
          {
            id: "dc-1",
            eventId: EVENT_ID,
            createdAt: new Date("2026-10-16T02:04:00.000Z"),
            actor: { humanId: "h-sam", name: "Sam Ortiz" },
            lines: [
              {
                section: "TICKETS",
                payeeName: "Marrow Hall",
                label: null,
                before: null,
                after: null,
                text: {
                  subject: "Ticket sales, Marrow Hall",
                  before: "15% of ticket money",
                  after: "18% of ticket money",
                },
              },
            ],
          },
        ],
        nextCursor: null,
      },
    };
    render(<EventDealPage eventId={EVENT_ID} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Lowlight at Marrow Hall",
    );
    expect(screen.getByTestId("deal-page-frozen").textContent).toContain(
      "deals.freeze.frozenSinceAuto",
    );
    expect(screen.getByTestId("summary")).toBeTruthy();
    const item = screen.getByTestId("deal-page-changes-item");
    expect(item.querySelector("s")?.textContent).toContain("15% of ticket money");
    expect(item.textContent).toContain("18% of ticket money");
  });

  it("a session that ran out is offered sign-in, back to this page", () => {
    result = {
      error: Object.assign(new Error("UNAUTHORIZED"), {
        data: { code: "UNAUTHORIZED" },
      }),
    };
    render(<EventDealPage eventId={EVENT_ID} />);
    const link = screen.getByTestId("deal-page-sign-in");
    expect(link.getAttribute("href")).toBe(
      `/sign-in?redirect=${encodeURIComponent(`/deals/${EVENT_ID}`)}`,
    );
    expect(screen.queryByTestId("deal-page-retry")).toBeNull();
  });

  it("says a payee sees only their lines, and doesn't tell the organiser so", () => {
    const page = {
      eventId: EVENT_ID,
      event: {
        title: "Lowlight",
        startsAt: null,
        timezone: "America/Chicago",
        dealFrozenAt: null,
        frozenBy: null,
      },
      items: [],
      nextCursor: null,
    };
    result = { data: page };
    render(<EventDealPage eventId={EVENT_ID} />);
    expect(screen.queryByTestId("deal-page-now-hint")).toBeNull();
    cleanup();
    visibility = "OWN_LINE";
    render(<EventDealPage eventId={EVENT_ID} />);
    expect(screen.getByTestId("deal-page-now-hint").textContent).toBe(
      "deals.page.nowHint",
    );
  });
});
