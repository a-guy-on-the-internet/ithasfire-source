/**
 * QuotaExceededDialog — a PLACE's quota (images community moderators add to
 * an unowned place's page) offers no expansion request: one plain line says
 * the place is full. A person's or group's quota keeps the request form.
 *
 * MOCKS: tamagui and @th/ui reduced to DOM; tRPC is a double; `t` echoes keys.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack };
});

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  Clock: () => null,
  ArrowUpRight: () => null,
}));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Plain = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const Button = ({ children }: { children?: ReactNode }) =>
    React.createElement("button", { type: "button" }, children);
  const TextInput = ({ testId }: { testId?: string }) =>
    React.createElement("input", { "data-testid": testId });
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", { role: "dialog" }, children) : null,
    {
      Panel: Plain,
      Header: ({ title }: { title: string }) =>
        React.createElement("h2", null, title),
      Body: Plain,
      Footer: ({ children }: { children?: ReactNode }) =>
        React.createElement("footer", null, children),
    },
  );
  return {
    Button,
    Modal,
    Text,
    TextInput,
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    quotas: {
      requestExpansion: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { QuotaExceededDialog } from "../QuotaExceededDialog";

const META = {
  kind: "STORAGE_BYTES_PLACE",
  subjectType: "PLACE" as const,
  subjectId: "place-1",
  limitValue: "536870912",
  currentUsage: "536000000",
  hasPendingExpansionRequest: false,
};

describe("QuotaExceededDialog", () => {
  it("a place's storage: one plain line, no expansion request", () => {
    render(<QuotaExceededDialog open onClose={() => {}} meta={META} />);
    expect(screen.getByText("admin.quotaExceededPlaceStorage")).toBeTruthy();
    expect(screen.queryByText("admin.quotaExceededBody")).toBeNull();
    expect(screen.queryByText("admin.quotaRequestExpansion")).toBeNull();
    expect(screen.queryByTestId("quota-request-limit-input")).toBeNull();
    expect(screen.queryByText("admin.quotaRequestSubmit")).toBeNull();
  });

  it("a person's storage keeps the expansion request form", () => {
    render(
      <QuotaExceededDialog
        open
        onClose={() => {}}
        meta={{
          ...META,
          kind: "STORAGE_BYTES_HUMAN",
          subjectType: "HUMAN",
          subjectId: "human-1",
        }}
      />,
    );
    expect(screen.getByText("admin.quotaExceededBody")).toBeTruthy();
    expect(screen.queryByText("admin.quotaExceededPlaceStorage")).toBeNull();
    expect(screen.getByTestId("quota-request-limit-input")).toBeTruthy();
    expect(screen.getByText("admin.quotaRequestSubmit")).toBeTruthy();
  });
});
