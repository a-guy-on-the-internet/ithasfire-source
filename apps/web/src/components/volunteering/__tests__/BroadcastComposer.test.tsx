import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutate = vi.fn();
// Captured so tests can drive the component's onError (simulate a failed
// send) — the factory runs lazily, after this binding is initialized.
let capturedMutationOptions:
  | { onError?: (err: unknown) => void }
  | undefined;

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { YStack: passthrough, XStack: passthrough, styled: () => passthrough };
});

vi.mock("@th/ui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = ({ children }: { children?: ReactNode }) => (
    <div data-testid="modal">{children}</div>
  );
  Modal.Panel = passthrough;
  Modal.Header = ({ title }: { title?: string }) => <div>{title}</div>;
  Modal.Body = passthrough;
  Modal.Footer = passthrough;
  return {
    Modal,
    Button: ({
      children,
      onPress,
      disabled,
      "data-testid": testId,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      "data-testid"?: string;
    }) => (
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => onPress?.()}
      >
        {children}
      </button>
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value?: string;
      onChangeText?: (v: string) => void;
      testId?: string;
    }) => (
      <input
        data-testid={testId}
        value={value}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
    StyledSelect: ({
      value,
      options,
      onChange,
      testId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
      testId?: string;
    }) => (
      <select
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
    useTranslations: () => (key: string) => key,
    useNotify: () => ({
      toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
    }),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      broadcasts: {
        send: {
          useMutation: (opts?: { onError?: (err: unknown) => void }) => {
            capturedMutationOptions = opts;
            return { mutate: mockMutate, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import {
  BroadcastComposer,
  type BroadcastScopeOption,
} from "../BroadcastComposer";

const ownerScopes: BroadcastScopeOption[] = [
  { id: "all", label: "Everyone", scope: { kind: "ALL" } },
  { id: "pool", label: "Pool", scope: { kind: "POOL" } },
  { id: "role:r1", label: "Role: Door", scope: { kind: "ROLE", roleId: "r1" } },
  {
    id: "group:g1",
    label: "Group: Bar",
    scope: { kind: "GROUP", groupId: "g1" },
  },
];

const coordinatorScopes: BroadcastScopeOption[] = [
  {
    id: "group:g1",
    label: "Group: Bar",
    scope: { kind: "GROUP", groupId: "g1" },
  },
];

describe("BroadcastComposer", () => {
  beforeEach(() => {
    mockMutate.mockReset();
    capturedMutationOptions = undefined;
  });

  it("offers the full scope set to an owner", () => {
    render(
      <BroadcastComposer
        askId="ask-1"
        open
        scopes={ownerScopes}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByTestId(
      "volunteer-broadcast-scope",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["all", "pool", "role:r1", "group:g1"]);
  });

  it("offers ONLY the coordinator's own group scope", () => {
    render(
      <BroadcastComposer
        askId="ask-1"
        open
        scopes={coordinatorScopes}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByTestId(
      "volunteer-broadcast-scope",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["group:g1"]);
    expect(screen.queryByText("Everyone")).not.toBeInTheDocument();
  });

  it("disables send until subject and body are filled, then sends with a stable broadcastId", () => {
    render(
      <BroadcastComposer
        askId="ask-1"
        open
        scopes={coordinatorScopes}
        onClose={vi.fn()}
      />,
    );
    const sendButton = screen.getByTestId("volunteer-broadcast-send");
    expect(sendButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("volunteer-broadcast-subject"), {
      target: { value: "Shift moved" },
    });
    fireEvent.change(screen.getByTestId("volunteer-broadcast-body"), {
      target: { value: "We start at 6pm now." },
    });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const firstCall = mockMutate.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      askId: "ask-1",
      scope: { kind: "GROUP", groupId: "g1" },
      subject: "Shift moved",
      body: "We start at 6pm now.",
    });
    expect(firstCall.broadcastId).toMatch(/^[0-9a-f-]{36}$/);

    // A retry of the same message keeps the same idempotency key (the id
    // only rotates after a successful send, which our mock never fires).
    fireEvent.click(sendButton);
    const secondCall = mockMutate.mock.calls[1]?.[0];
    expect(secondCall.broadcastId).toBe(firstCall.broadcastId);
  });

  it("keeps the id across unedited retries after a failure, but rotates it once the content is edited", () => {
    // Every send fails: the component's onError marks the current id as
    // belonging to a failed attempt.
    mockMutate.mockImplementation(() => {
      capturedMutationOptions?.onError?.(new Error("network down"));
    });

    render(
      <BroadcastComposer
        askId="ask-1"
        open
        scopes={coordinatorScopes}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("volunteer-broadcast-subject"), {
      target: { value: "Shift moved" },
    });
    fireEvent.change(screen.getByTestId("volunteer-broadcast-body"), {
      target: { value: "We start at 6pm now." },
    });
    const sendButton = screen.getByTestId("volunteer-broadcast-send");

    // Failed send → unedited retry keeps the SAME idempotency key.
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    const firstId = mockMutate.mock.calls[0]?.[0]?.broadcastId;
    expect(mockMutate.mock.calls[1]?.[0]?.broadcastId).toBe(firstId);

    // Failed send → EDITED subject → resend uses a NEW id (edited content
    // must not replay the original ledger row).
    fireEvent.change(screen.getByTestId("volunteer-broadcast-subject"), {
      target: { value: "Shift moved (updated)" },
    });
    fireEvent.click(sendButton);
    const thirdCall = mockMutate.mock.calls[2]?.[0];
    expect(thirdCall?.subject).toBe("Shift moved (updated)");
    expect(thirdCall?.broadcastId).toMatch(/^[0-9a-f-]{36}$/);
    expect(thirdCall?.broadcastId).not.toBe(firstId);
  });
});
