import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react-native";

import { NativeThemeProvider } from "@th/ui-native";

import { AppErrorBoundary } from "../../ui/app-error-boundary";

/**
 * The scanner had no error boundary, so a crash anywhere under the root left
 * the operator on a blank screen with the camera off (2026-10-13). These pin
 * the three things the boundary is for: something readable instead of nothing,
 * a report to Sentry, and a way back without force-quitting.
 */
const crash = vi.hoisted(() => ({ on: true, mounts: 0 }));

/** A screen that throws while rendering until the test says otherwise. */
const Scanner = () => {
  // Fresh state on every mount, so the test can tell a remount from a re-render.
  const [mountId] = useState(() => ++crash.mounts);
  if (crash.on) throw new Error("render failed for tk_secret_code");
  return <span data-testid="scanner">mounted {mountId}</span>;
};

const show = (theme: "ember" | "stub") =>
  render(
    <NativeThemeProvider enabledThemes={[theme]} defaultTheme={theme}>
      <AppErrorBoundary>
        <Scanner />
      </AppErrorBoundary>
    </NativeThemeProvider>,
  );

beforeEach(() => {
  crash.on = true;
  crash.mounts = 0;
  vi.mocked(Sentry.captureException).mockReset();
  // React logs every error a boundary catches; that output is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("shows a plain message and a way back instead of a blank screen", () => {
    show("ember");

    const page = screen.getByTestId("app-crash-screen").textContent ?? "";
    expect(page).toContain("The scanner stopped. Queued scans are kept.");
    expect(screen.getByTestId("app-crash-reset-button").textContent).toContain(
      "Back to scanning",
    );
    // The error text is not for the operator, and it can carry a ticket code.
    expect(page).not.toContain("tk_secret_code");
    expect(screen.queryByTestId("scanner")).toBeNull();
  });

  it("reports the crash to Sentry with the component stack", () => {
    show("ember");

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect((error as Error).message).toContain("render failed");
    expect(context).toMatchObject({
      tags: { feature: "app", branch: "root_render_crash" },
    });
    expect(
      (context as { contexts: { react: { componentStack: string } } }).contexts
        .react.componentStack,
    ).toContain("Scanner");
  });

  it("Back to scanning mounts the app again from scratch", () => {
    show("ember");
    crash.on = false;

    act(() => {
      fireEvent.click(screen.getByTestId("app-crash-reset-button"));
    });

    expect(screen.queryByTestId("app-crash-screen")).toBeNull();
    // A new mount, not the old tree resumed: the crashed one never committed.
    expect(screen.getByTestId("scanner").textContent).toBe(
      `mounted ${crash.mounts}`,
    );
  });

  it("a crash that happens again lands on the same screen, not a blank one", () => {
    show("stub");

    act(() => {
      fireEvent.click(screen.getByTestId("app-crash-reset-button"));
    });

    expect(screen.getByTestId("app-crash-screen")).toBeTruthy();
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it("still shows the way back when the reporter itself throws", () => {
    vi.mocked(Sentry.captureException).mockImplementation(() => {
      throw new Error("sentry down");
    });

    show("ember");

    expect(screen.getByTestId("app-crash-reset-button")).toBeTruthy();
  });
});
