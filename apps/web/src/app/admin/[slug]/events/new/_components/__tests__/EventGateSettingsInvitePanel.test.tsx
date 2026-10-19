/**
 * EventGateSettings mounts the invite panel (gated-event invite links, step 7)
 * only behind the gate the SERVER holds: PASSWORD with a saved password, or
 * APPLICATION. The card selection alone must not move it: picking Password
 * only changes local state until a password is saved.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const Stack = ({
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
    return React.createElement("div", domProps, children);
  };
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
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const Modal = Object.assign(
    ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", null, children) : null,
    { Panel: Passthrough, Header: () => null, Body: Passthrough, Footer: Passthrough },
  );
  return {
    Text: Passthrough,
    Modal,
    Switch: () => null,
    Button: ({
      children,
      onPress,
    }: {
      children?: ReactNode;
      onPress?: () => void;
    }) =>
      React.createElement("button", { type: "button", onClick: onPress }, children),
    TextInput: () => React.createElement("input"),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined, isLoading: false }),
}));
vi.mock("../ApplicationTemplatePickerDialog", () => ({
  ApplicationTemplatePickerDialog: () => null,
}));
vi.mock("../_form-bits", () => ({ NativeDateTimeInput: () => null }));

// Stub panel: records the gate type it was mounted for.
vi.mock("../EventInviteSettings", () => ({
  EventInviteSettings: ({ gateType }: { gateType: string }) => (
    <div data-testid="invite-panel-stub" data-gate={gateType} />
  ),
}));

// What the server answers to updateAccessControls; `onSuccess` gets it.
const saved = vi.hoisted(() => ({
  response: { gateType: "NONE", passwordSet: false } as {
    gateType: string;
    passwordSet: boolean;
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getApplicationForm: { invalidate: vi.fn() } },
    }),
    events: {
      updateAccessControls: {
        useMutation: (opts?: {
          onSuccess?: (res: typeof saved.response) => void;
        }) => ({
          mutateAsync: () => {
            opts?.onSuccess?.(saved.response);
            return Promise.resolve(saved.response);
          },
        }),
      },
      getApplicationForm: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
      upsertApplicationForm: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
  },
}));

import { EventGateSettings } from "../EventGateSettings";

type Gate = "NONE" | "PASSWORD" | "APPLICATION";

const renderSettings = (gate: Gate, passwordSet: boolean) =>
  render(
    <EventGateSettings
      eventId="11111111-1111-4111-8111-111111111111"
      templateOwner={{
        ownerScope: "ORGANIZATION",
        ownerId: "22222222-2222-4222-8222-222222222222",
      }}
      initialGateType={gate}
      initialPasswordSet={passwordSet}
    />,
  );

const panel = () => screen.queryByTestId("invite-panel-stub");

beforeEach(() => {
  saved.response = { gateType: "NONE", passwordSet: false };
});

describe("EventGateSettings — invite panel mount", () => {
  it("is hidden with no gate", () => {
    renderSettings("NONE", false);
    expect(panel()).toBeNull();
  });

  it("is hidden on PASSWORD with no saved password", () => {
    renderSettings("PASSWORD", false);
    expect(panel()).toBeNull();
  });

  it("shows on PASSWORD with a saved password", () => {
    renderSettings("PASSWORD", true);
    expect(panel()?.getAttribute("data-gate")).toBe("PASSWORD");
  });

  it("shows on APPLICATION", () => {
    renderSettings("APPLICATION", false);
    expect(panel()?.getAttribute("data-gate")).toBe("APPLICATION");
  });

  it("follows the SAVED gate, not a Password card picked locally", () => {
    // A password exists from earlier, but the event is on APPLICATION.
    renderSettings("APPLICATION", true);
    fireEvent.click(screen.getByTestId("gate-option-password"));
    // Selecting Password with a password already set only changes local
    // state; nothing was saved, so the panel still reflects APPLICATION.
    expect(panel()?.getAttribute("data-gate")).toBe("APPLICATION");
  });

  it("appears once the server confirms a gate change", async () => {
    saved.response = { gateType: "APPLICATION", passwordSet: false };
    renderSettings("NONE", false);
    expect(panel()).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("gate-option-application"));
      await Promise.resolve();
    });
    expect(panel()?.getAttribute("data-gate")).toBe("APPLICATION");
  });
});
