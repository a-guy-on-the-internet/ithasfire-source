import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Button: ({
    children,
    onPress,
    "aria-label": ariaLabel,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "aria-label"?: string;
    disabled?: boolean;
  }) => (
    <button aria-label={ariaLabel} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));

// Mirrors RewardsTab.test.tsx's ConfirmDialog mock convention: a minimal
// stand-in that renders a clickable confirm affordance only while `open`, so
// tests can drive the confirm/cancel flow without pulling in the real Modal.
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onCancel,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title?: string;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button type="button" onClick={onConfirm}>
          confirm
        </button>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
    ) : null,
}));

import { RoleBadgeList } from "../RoleBadgeList";

describe("RoleBadgeList", () => {
  it("renders an em-dash badge when the human holds no roles", () => {
    render(
      <RoleBadgeList roles={[]} isPlatformAdmin={true} onRevoke={vi.fn()} />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders one badge per held role, tagging ADMIN with the info tone", () => {
    render(
      <RoleBadgeList
        roles={["USER", "ADMIN"]}
        isPlatformAdmin={true}
        onRevoke={vi.fn()}
      />,
    );

    expect(screen.getByText("USER")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("ADMIN")).toHaveAttribute("data-tone", "info");
  });

  it("hides the revoke button for non-admin staff (read-only roster)", () => {
    render(
      <RoleBadgeList
        roles={["SUPPORT"]}
        isPlatformAdmin={false}
        onRevoke={vi.fn()}
      />,
    );

    expect(screen.getByText("SUPPORT")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke SUPPORT" }),
    ).not.toBeInTheDocument();
  });

  it("calls onRevoke with the role when the revoke button is pressed", () => {
    const onRevoke = vi.fn();
    render(
      <RoleBadgeList
        roles={["SUPPORT", "REVIEWER"]}
        isPlatformAdmin={true}
        onRevoke={onRevoke}
      />,
    );

    screen.getByRole("button", { name: "Revoke SUPPORT" }).click();

    expect(onRevoke).toHaveBeenCalledWith("SUPPORT");
    expect(onRevoke).not.toHaveBeenCalledWith("REVIEWER");
  });

  it("disables revoke buttons while a mutation is in flight", () => {
    render(
      <RoleBadgeList
        roles={["SUPPORT"]}
        isPlatformAdmin={true}
        onRevoke={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole("button", { name: "Revoke SUPPORT" })).toBeDisabled();
  });

  describe("own-row ADMIN self-revoke confirmation", () => {
    it("does not fire onRevoke immediately when revoking ADMIN on the actor's own row", () => {
      const onRevoke = vi.fn();
      render(
        <RoleBadgeList
          roles={["ADMIN"]}
          isPlatformAdmin={true}
          onRevoke={onRevoke}
          isOwnRow
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Revoke ADMIN" }));

      expect(onRevoke).not.toHaveBeenCalled();
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });

    it("fires onRevoke only after the confirm dialog is confirmed", () => {
      const onRevoke = vi.fn();
      render(
        <RoleBadgeList
          roles={["ADMIN"]}
          isPlatformAdmin={true}
          onRevoke={onRevoke}
          isOwnRow
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Revoke ADMIN" }));
      fireEvent.click(screen.getByRole("button", { name: "confirm" }));

      expect(onRevoke).toHaveBeenCalledWith("ADMIN");
    });

    it("does not fire onRevoke when the confirm dialog is cancelled", () => {
      const onRevoke = vi.fn();
      render(
        <RoleBadgeList
          roles={["ADMIN"]}
          isPlatformAdmin={true}
          onRevoke={onRevoke}
          isOwnRow
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Revoke ADMIN" }));
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));

      expect(onRevoke).not.toHaveBeenCalled();
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    });

    it("still fires onRevoke immediately for a non-ADMIN role on the actor's own row", () => {
      const onRevoke = vi.fn();
      render(
        <RoleBadgeList
          roles={["SUPPORT"]}
          isPlatformAdmin={true}
          onRevoke={onRevoke}
          isOwnRow
        />,
      );

      screen.getByRole("button", { name: "Revoke SUPPORT" }).click();

      expect(onRevoke).toHaveBeenCalledWith("SUPPORT");
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    });

    it("still fires onRevoke immediately for ADMIN when the row is NOT the actor's own", () => {
      const onRevoke = vi.fn();
      render(
        <RoleBadgeList
          roles={["ADMIN"]}
          isPlatformAdmin={true}
          onRevoke={onRevoke}
          isOwnRow={false}
        />,
      );

      screen.getByRole("button", { name: "Revoke ADMIN" }).click();

      expect(onRevoke).toHaveBeenCalledWith("ADMIN");
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    });
  });
});
