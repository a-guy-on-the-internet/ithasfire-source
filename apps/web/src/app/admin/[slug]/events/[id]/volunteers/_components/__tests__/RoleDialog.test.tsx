import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock("tamagui", async () => {
  const React = await import("react");
  type StackProps = {
    children?: ReactNode;
    tag?: string;
    onPress?: () => void;
    "data-testid"?: string;
    "aria-pressed"?: boolean;
    "aria-label"?: string;
  };
  const createStack =
    () =>
    ({
      children,
      tag,
      onPress,
      ["data-testid"]: testId,
      ["aria-pressed"]: ariaPressed,
      ["aria-label"]: ariaLabel,
    }: StackProps) =>
      React.createElement(
        tag === "button" ? "button" : "div",
        {
          type: tag === "button" ? "button" : undefined,
          onClick: onPress,
          "data-testid": testId,
          "aria-pressed": ariaPressed,
          "aria-label": ariaLabel,
        },
        children,
      );
  return {
    XStack: createStack(),
    YStack: createStack(),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");

  const ModalRoot = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ModalPanel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ModalHeader = ({ title }: { title?: string }) => <h1>{title}</h1>;
  const ModalBody = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ModalFooter = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(ModalRoot, {
    Panel: ModalPanel,
    Header: ModalHeader,
    Body: ModalBody,
    Footer: ModalFooter,
  });

  return {
    Modal,
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled}>
        {children}
      </button>
    ),
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value?: string;
      onChangeText?: (value: string) => void;
      testId?: string;
    }) => (
      <input
        data-testid={testId}
        value={value ?? ""}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    useTranslations: () => (key: string) => key,
    useNotify: () => ({
      toast: { success: vi.fn(), danger: vi.fn() },
    }),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      roles: {
        create: {
          useMutation: () => ({ mutate: createMutate, isPending: false }),
        },
        update: {
          useMutation: () => ({ mutate: updateMutate, isPending: false }),
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { RoleDialog } from "../RoleDialog";

describe("RoleDialog auto-approve tri-state", () => {
  beforeEach(() => {
    createMutate.mockClear();
    updateMutate.mockClear();
  });

  const fillName = (value: string) => {
    fireEvent.change(screen.getByTestId("volunteer-role-name"), {
      target: { value },
    });
  };

  it("create mode: pre-selects Event default and submits autoApprove null when untouched", () => {
    render(
      <RoleDialog
        mode="create"
        eventId="e1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("volunteer-role-auto-approve-inherit"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByTestId("volunteer-role-auto-approve-always"),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByTestId("volunteer-role-auto-approve-never"),
    ).toHaveAttribute("aria-pressed", "false");

    fillName("Door Security");
    fireEvent.click(screen.getByText("common.create"));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: null }),
    );
  });

  it("create mode: selecting Always auto-approve submits autoApprove true", () => {
    render(
      <RoleDialog
        mode="create"
        eventId="e1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fillName("Door Security");
    fireEvent.click(screen.getByTestId("volunteer-role-auto-approve-always"));
    fireEvent.click(screen.getByText("common.create"));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: true }),
    );
  });

  it("create mode: selecting Always require review submits autoApprove false", () => {
    render(
      <RoleDialog
        mode="create"
        eventId="e1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fillName("Door Security");
    fireEvent.click(screen.getByTestId("volunteer-role-auto-approve-never"));
    fireEvent.click(screen.getByText("common.create"));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: false }),
    );
  });

  it("edit mode: initial autoApprove null pre-selects Event default and re-sends null untouched", () => {
    render(
      <RoleDialog
        mode="edit"
        eventId="e1"
        roleId="r1"
        initial={{
          name: "Door Security",
          description: null,
          capacity: null,
          autoApprove: null,
        }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("volunteer-role-auto-approve-inherit"),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByText("common.save"));

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", autoApprove: null }),
    );
  });

  it("edit mode: initial autoApprove true pre-selects Always approve and re-sends true untouched", () => {
    render(
      <RoleDialog
        mode="edit"
        eventId="e1"
        roleId="r1"
        initial={{
          name: "Door Security",
          description: null,
          capacity: null,
          autoApprove: true,
        }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("volunteer-role-auto-approve-always"),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByText("common.save"));

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", autoApprove: true }),
    );
  });

  it("edit mode: initial autoApprove false pre-selects Always require review and re-sends false untouched — regression guard for the inherit-pinning bug", () => {
    render(
      <RoleDialog
        mode="edit"
        eventId="e1"
        roleId="r1"
        initial={{
          name: "Door Security",
          description: null,
          capacity: null,
          autoApprove: false,
        }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("volunteer-role-auto-approve-never"),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByText("common.save"));

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", autoApprove: false }),
    );
  });
});
