import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The payout clock on /platform/settlements reads `platformJobs.listStatus`
 * and has to say the truthful thing for EACH shape that payload can take.
 * `@th/ui` and tamagui are mocked to bare DOM so the assertions are about
 * which fact is rendered — and, above all, that a batch which will not run
 * never renders a date.
 *
 * Two "off" states are distinct on purpose (see the component header): the
 * top-level `enabled` is the RUNTIME pause staff set from /platform/jobs;
 * `schedule.enabled` is the manifest default. The first was not read at all
 * before 2026-09-15, which is the regression the "paused" case pins.
 */

type StatusJob = {
  name: string;
  description: string | null;
  scheduled: boolean;
  schedule: {
    cron: string;
    timezone: string;
    enabled: boolean;
    cronDescription: string;
    nextRun: string | null;
  } | null;
  enabled: boolean;
  lastRun: null;
};

const testState = vi.hoisted(() => ({
  data: null as { jobs: unknown[] } | null,
  isLoading: false,
  isError: false,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone} data-testid="clock-badge">
      {children}
    </span>
  ),
  DateTime: ({
    value,
    timeZone,
    format,
  }: {
    value: Date | string | number;
    timeZone: string;
    format?: string;
  }) => (
    <time data-testid="clock-date" data-tz={timeZone} data-format={format}>
      {new Date(value).toISOString()}
    </time>
  ),
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => (
    <a>{children}</a>
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    platformJobs: {
      listStatus: {
        useQuery: () => ({
          data: testState.data,
          isLoading: testState.isLoading,
          isError: testState.isError,
        }),
      },
    },
  },
}));

import { BatchClock } from "../BatchClock";

const NEXT_RUN = "2026-09-16T05:00:00.000Z";

function batchJob(overrides: Partial<StatusJob> = {}): StatusJob {
  return {
    name: "settlements.run-batch",
    description: null,
    scheduled: true,
    schedule: {
      cron: "0 0 * * *",
      timezone: "America/Chicago",
      enabled: true,
      cronDescription: "Daily at 00:00 America/Chicago",
      nextRun: NEXT_RUN,
    },
    enabled: true,
    lastRun: null,
    ...overrides,
  };
}

function setStatus(jobs: StatusJob[]) {
  testState.data = { jobs };
  testState.isLoading = false;
  testState.isError = false;
}

describe("BatchClock", () => {
  beforeEach(() => {
    testState.data = null;
    testState.isLoading = false;
    testState.isError = false;
  });

  it("renders the next run as a date once the reader's zone resolves", async () => {
    setStatus([batchJob()]);
    render(<BatchClock />);

    // `usePlatformTimeZone` resolves in an effect AFTER mount, so the date is
    // withheld on the first paint and appears on the next.
    const date = await waitFor(() => screen.getByTestId("clock-date"));
    expect(date).toHaveTextContent(NEXT_RUN);
    expect(date.getAttribute("data-format")).toBe("meta");
    expect(screen.getByText("admin.pstClockNext")).toBeInTheDocument();
    expect(
      screen.getByText("Daily at 00:00 America/Chicago"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("clock-badge")).toBeNull();
  });

  it("says PAUSED, and renders no date, when the runtime pause is set (top-level enabled: false)", async () => {
    // The manifest schedule is still ON here — that is the exact shape the
    // jobs page produces when staff pause the batch, and the one this clock
    // used to render as "Next batch · <date>".
    setStatus([batchJob({ enabled: false })]);
    render(<BatchClock />);

    const badge = screen.getByTestId("clock-badge");
    expect(badge).toHaveTextContent("admin.pstClockPaused");
    expect(badge.getAttribute("data-tone")).toBe("danger");

    // Let the zone effect run, then assert the date still never appears.
    await waitFor(() => expect(screen.getByTestId("clock-badge")).toBeTruthy());
    expect(screen.queryByTestId("clock-date")).toBeNull();
    expect(screen.queryByText("admin.pstClockNext")).toBeNull();
  });

  it("says OFF when the manifest schedule is disabled (schedule.enabled: false)", async () => {
    setStatus([
      batchJob({
        schedule: { ...batchJob().schedule!, enabled: false },
      }),
    ]);
    render(<BatchClock />);

    const badge = screen.getByTestId("clock-badge");
    expect(badge).toHaveTextContent("admin.pstClockDisabled");
    expect(badge.getAttribute("data-tone")).toBe("danger");
    await waitFor(() => expect(screen.getByTestId("clock-badge")).toBeTruthy());
    expect(screen.queryByTestId("clock-date")).toBeNull();
  });

  it("says UNSCHEDULED when the job carries no schedule", () => {
    setStatus([batchJob({ scheduled: false, schedule: null })]);
    render(<BatchClock />);

    const badge = screen.getByTestId("clock-badge");
    expect(badge).toHaveTextContent("admin.pstClockUnscheduled");
    expect(screen.queryByTestId("clock-date")).toBeNull();
  });

  it("says UNKNOWN when the status read fails", () => {
    testState.isError = true;
    render(<BatchClock />);

    const badge = screen.getByTestId("clock-badge");
    expect(badge).toHaveTextContent("admin.pstClockUnknown");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    expect(screen.queryByTestId("clock-date")).toBeNull();
  });

  it("says UNKNOWN when the payload has no settlement batch job", () => {
    setStatus([batchJob({ name: "some.other-job" })]);
    render(<BatchClock />);

    expect(screen.getByTestId("clock-badge")).toHaveTextContent(
      "admin.pstClockUnknown",
    );
  });

  it("says UNPROJECTABLE beside the raw cron, with no date and no NEXT label, when nextRun is null", async () => {
    // The jobs service returns `nextRun: null` for a cron shape it refuses to
    // project, and for exactly those shapes `cronDescription` is the raw cron
    // string. This used to render under the "NEXT BATCH" label — "NEXT BATCH
    // 0 0 * 1 *" — which reads like a time. It must read like a warning.
    setStatus([
      batchJob({
        schedule: {
          ...batchJob().schedule!,
          cron: "0 0 * 1 *",
          cronDescription: "0 0 * 1 *",
          nextRun: null,
        },
      }),
    ]);
    render(<BatchClock />);

    const badge = screen.getByTestId("clock-badge");
    expect(badge).toHaveTextContent("admin.pstClockUnprojectable");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    expect(screen.getByText("0 0 * 1 *")).toBeInTheDocument();
    expect(screen.queryByText("admin.pstClockNext")).toBeNull();

    // Let the zone effect run, then assert a date still never appears.
    await waitFor(() => expect(screen.getByTestId("clock-badge")).toBeTruthy());
    expect(screen.queryByTestId("clock-date")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });

  it("renders nothing while loading", () => {
    testState.isLoading = true;
    const { container } = render(<BatchClock />);
    expect(container).toBeEmptyDOMElement();
  });
});
