/**
 * EventGateSettings — the organiser-side waitlist ("Notify Me") section is
 * behind the default-OFF `waitlists` feature gate.
 *
 * Only the JOIN half of waitlists exists: nothing ever sets the `NOTIFIED`
 * status, and there is no release trigger, job, or admin roster. So the whole
 * section must be ABSENT while the gate is off — not rendered disabled, which
 * would still advertise a capability the platform can't deliver. The rest of
 * the gate settings (visibility, access gate) are untouched by the flag.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-")) domProps[key] = value;
    }
    return React.createElement("span", domProps, children);
  };
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const ModalRoot = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: ReactNode;
  }) => (open ? React.createElement("div", null, children) : null);
  const Modal = Object.assign(ModalRoot, {
    Panel: Passthrough,
    Header: () => null,
    Body: Passthrough,
    Footer: Passthrough,
  });
  return {
    Text,
    Modal,
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "data-testid": rest["data-testid"],
        },
        children,
      ),
    TextInput: ({ testId }: { testId?: string }) =>
      React.createElement("input", { "data-testid": testId }),
    // Key-echoing translator so assertions target stable i18n keys.
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getApplicationForm: { invalidate: vi.fn() } },
    }),
    events: {
      updateAccessControls: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      // Application lifecycle settings (spec Phase 2) render inside the
      // APPLICATION branch; these tests use the default NONE gate, but the
      // hooks are called unconditionally.
      getApplicationForm: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
      upsertApplicationForm: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
  },
}));

// Mutable so each test can pick the gate state.
let mockGates: Partial<FeatureGatesSnapshot> | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates, isLoading: false }),
}));

// The picker is its own dialog with its own queries; it is exercised by
// ApplicationTemplatePickerDialog.test.tsx, not here.
vi.mock("../ApplicationTemplatePickerDialog", () => ({
  ApplicationTemplatePickerDialog: () => null,
}));

import { EventGateSettings } from "../EventGateSettings";

beforeEach(() => {
  mockGates = undefined;
});

const renderSettings = () =>
  render(
    <EventGateSettings
      eventId="11111111-1111-4111-8111-111111111111"
      slug="dev-qa-collective"
      templateOwner={{
        ownerScope: "ORGANIZATION",
        ownerId: "22222222-2222-4222-8222-222222222222",
      }}
      initialWaitlistStatus="OPEN"
      initialWaitlistDescription="We'll let you know."
      initialWaitlistCap={50}
    />,
  );

describe("EventGateSettings — `waitlists` gate", () => {
  it("omits the whole waitlist section when the gate is off", () => {
    mockGates = { waitlists: false };
    renderSettings();

    expect(screen.queryByText("admin.gsNotifyMe")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("waitlist-option-disabled"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("waitlist-option-open"),
    ).not.toBeInTheDocument();
    // Not merely disabled — the config inputs are gone too.
    expect(
      screen.queryByTestId("waitlist-description"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("waitlist-cap")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("waitlist-save-details-btn"),
    ).not.toBeInTheDocument();
  });

  it("fails closed while the gates are still loading (undefined)", () => {
    mockGates = undefined;
    renderSettings();

    expect(screen.queryByText("admin.gsNotifyMe")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("waitlist-option-open"),
    ).not.toBeInTheDocument();
  });

  it("leaves the ungated visibility + access sections rendering with the gate off", () => {
    mockGates = { waitlists: false };
    renderSettings();

    expect(screen.getByText("admin.gsVisibility")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-public")).toBeInTheDocument();
    expect(screen.getByTestId("gate-option-none")).toBeInTheDocument();
  });

  it("renders the waitlist section when the gate is on", () => {
    mockGates = { waitlists: true };
    renderSettings();

    expect(screen.getByText("admin.gsNotifyMe")).toBeInTheDocument();
    expect(screen.getByTestId("waitlist-option-disabled")).toBeInTheDocument();
    expect(screen.getByTestId("waitlist-option-open")).toBeInTheDocument();
    // OPEN initial status → the detail config is expanded.
    expect(screen.getByTestId("waitlist-description")).toBeInTheDocument();
    expect(screen.getByTestId("waitlist-cap")).toBeInTheDocument();
  });
});
