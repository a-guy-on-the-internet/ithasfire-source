import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "admin.jobsEnabled": "Enabled",
      "admin.jobsDisabled": "Disabled",
      "admin.jobsOnDemand": "On demand",
      "admin.jobsNever": "Never",
      "admin.jobsRunNow": "Run now",
      "admin.jobsEnable": "Enable",
      "admin.jobsDisable": "Disable",
      "admin.jobsHistory": "History",
    };
    return dictionary[key] ?? key;
  },
}));

import {
  JobMobileCard,
  formatDuration,
  type JobMobileCardRow,
} from "../JobMobileCard";

const baseRow: JobMobileCardRow = {
  name: "search.full-reindex",
  description: "Rebuild the search index",
  enabled: true,
  schedule: { cron: "0 3 * * *", cronDescription: "Every day at 3 AM" },
  lastRun: {
    status: "success",
    finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    durationMs: 1500,
  },
};

describe("JobMobileCard", () => {
  it("renders name, enabled badge, schedule, last run, and wires all three actions", () => {
    const onRun = vi.fn();
    const onToggleEnabled = vi.fn();
    const onToggleHistory = vi.fn();

    render(
      <JobMobileCard
        row={baseRow}
        isRunning={false}
        historyOpen={false}
        onRun={onRun}
        onToggleEnabled={onToggleEnabled}
        onToggleHistory={onToggleHistory}
      />,
    );

    expect(screen.getByText("search.full-reindex")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(screen.getByText("Rebuild the search index")).toBeInTheDocument();
    expect(screen.getByText("Every day at 3 AM")).toBeInTheDocument();
    expect(screen.getByText(/5m ago \(1\.5s\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
    fireEvent.click(screen.getByRole("button", { name: /Disable/ }));
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(onToggleHistory).toHaveBeenCalledTimes(1);
  });

  it("handles disabled on-demand jobs that never ran, and disables Run while running", () => {
    const onRun = vi.fn();

    render(
      <JobMobileCard
        row={{
          ...baseRow,
          description: null,
          enabled: false,
          schedule: null,
          lastRun: null,
        }}
        isRunning
        historyOpen={false}
        onRun={onRun}
        onToggleEnabled={vi.fn()}
        onToggleHistory={vi.fn()}
      />,
    );

    expect(screen.getByText("Disabled")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(screen.getByText("On demand")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    // Disabled job exposes "Enable", and the run button is locked.
    expect(screen.getByRole("button", { name: /Enable/ })).toBeInTheDocument();
    const runButton = screen.getByRole("button", { name: /Run now/ });
    expect(runButton).toBeDisabled();
    fireEvent.click(runButton);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("formatDuration matches the table column's formatting", () => {
    expect(formatDuration(900)).toBe("900ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1.5m");
  });
});
