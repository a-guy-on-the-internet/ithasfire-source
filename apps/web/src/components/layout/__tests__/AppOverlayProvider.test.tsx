import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

const { mobileState } = vi.hoisted(() => ({
  mobileState: { current: false },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mobileState.current,
}));

vi.mock("@th/ui", () => ({
  OverlayHost: ({ children }: { children?: ReactNode }) => (
    <div data-testid="overlay-host">{children}</div>
  ),
}));

vi.mock("@/components/auth/UnifiedAuthOverlay", () => ({
  UnifiedAuthOverlay: ({
    initialPanel,
    redirectOverride,
  }: {
    initialPanel: string;
    redirectOverride?: string;
  }) => (
    <div
      data-testid="auth-overlay"
      data-panel={initialPanel}
      data-redirect={redirectOverride ?? ""}
    />
  ),
}));

let AppOverlayProvider: (typeof import("../AppOverlayProvider"))["AppOverlayProvider"];
let useAppOverlay: (typeof import("../AppOverlayProvider"))["useAppOverlay"];

const Trigger = ({
  redirect,
  mode = "sign-in",
}: {
  redirect?: string;
  mode?: "sign-in" | "sign-up";
}) => {
  const { showSignInOverlay, showSignUpOverlay } = useAppOverlay();

  return (
    <button
      type="button"
      onClick={() => {
        if (mode === "sign-up") {
          showSignUpOverlay({ redirect });
          return;
        }

        showSignInOverlay({ redirect });
      }}
    >
      {mode === "sign-up" ? "Open sign up" : "Open sign in"}
    </button>
  );
};

describe("AppOverlayProvider", () => {
  beforeAll(async () => {
    ({ AppOverlayProvider, useAppOverlay } =
      await import("../AppOverlayProvider"));
  });

  beforeEach(() => {
    pushMock.mockReset();
    mobileState.current = false;
  });

  it("keeps desktop sign-in requests in the auth overlay", () => {
    render(
      <AppOverlayProvider>
        <Trigger redirect="/events/test-show" />
      </AppOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open sign in/i }));

    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-overlay")).toHaveAttribute(
      "data-panel",
      "sign-in",
    );
    expect(screen.getByTestId("auth-overlay")).toHaveAttribute(
      "data-redirect",
      "/events/test-show",
    );
  });

  it("drops unsafe desktop redirects before opening the auth overlay", () => {
    render(
      <AppOverlayProvider>
        <Trigger redirect="//evil.example" />
      </AppOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open sign in/i }));

    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-overlay")).toHaveAttribute(
      "data-panel",
      "sign-in",
    );
    expect(screen.getByTestId("auth-overlay")).toHaveAttribute(
      "data-redirect",
      "",
    );
  });

  it("sends mobile sign-in requests to the standalone page and preserves redirect", () => {
    mobileState.current = true;

    render(
      <AppOverlayProvider>
        <Trigger redirect="/events/test-show?tab=tickets" />
      </AppOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open sign in/i }));

    expect(pushMock).toHaveBeenCalledWith(
      "/sign-in?redirect_url=%2Fevents%2Ftest-show%3Ftab%3Dtickets",
    );
    expect(screen.queryByTestId("auth-overlay")).not.toBeInTheDocument();
  });

  it("sends mobile sign-up requests to the standalone page and preserves redirect", () => {
    mobileState.current = true;

    render(
      <AppOverlayProvider>
        <Trigger mode="sign-up" redirect="/account/settings" />
      </AppOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open sign up/i }));

    expect(pushMock).toHaveBeenCalledWith(
      "/sign-up?redirect_url=%2Faccount%2Fsettings",
    );
    expect(screen.queryByTestId("auth-overlay")).not.toBeInTheDocument();
  });

  it("drops unsafe mobile redirects before routing to standalone auth", () => {
    mobileState.current = true;

    render(
      <AppOverlayProvider>
        <Trigger redirect="//evil.example" />
      </AppOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open sign in/i }));

    expect(pushMock).toHaveBeenCalledWith("/sign-in");
    expect(screen.queryByTestId("auth-overlay")).not.toBeInTheDocument();
  });
});
