import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react-native";

import {
  Column,
  Panel,
  ScreenSurface,
  SquarePrimaryButton,
  Text,
  TopBar,
} from "@th/ui-native";

import { safeReport } from "../lib/report";

/**
 * The scanner's root error boundary.
 *
 * ## Why it exists
 *
 * There was none, so an error thrown while rendering unmounts the whole tree
 * and leaves the operator on a blank screen with the camera off. Such an error
 * now lands on this screen instead, with one button that mounts the app again.
 *
 * It only catches errors thrown during render, commit and lifecycles. The
 * 10-13 door crash ("Maximum update depth exceeded" from the scan queue's
 * re-render loop, fixed in `use-scan-queue.ts`) was thrown from TanStack's
 * notify callback, outside React, so it went to the global handler and this
 * boundary would not have caught it.
 *
 * ## What "Back to scanning" does
 *
 * Clears the error, which mounts the children afresh: every hook under the
 * boundary starts over (session, queue, sync), exactly as a cold start would
 * minus the splash. Nothing on the device is lost: the scan queue, the manifest
 * and the sign-in all live in SQLite / SecureStore, not in React state.
 *
 * ## Reporting
 *
 * React does not send an error a boundary caught to the global handler, so
 * Sentry's own crash capture never sees it. It is reported here, with the
 * component stack (component names only, no props or values). A throwing
 * reporter must not stop the fallback from rendering.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    safeReport(() => {
      Sentry.captureException(error, {
        tags: { feature: "app", branch: "root_render_crash" },
        contexts: { react: { componentStack: info.componentStack ?? null } },
      });
    });
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) return <AppCrashScreen onReset={this.reset} />;
    return this.props.children;
  }
}

/**
 * The fallback. Theme-aware through `ScreenSurface` / `Text`, so it reads on
 * Ember (dark) and Stub alike. It never shows the error message: an operator
 * cannot act on it, and a message can carry a ticket code.
 */
const AppCrashScreen = ({ onReset }: { onReset: () => void }) => (
  <ScreenSurface testID="app-crash-screen">
    <TopBar title="Something went wrong" />
    <Column flex justify="center" gap={16}>
      <Panel>
        <Text variant="body">The scanner stopped. Queued scans are kept.</Text>
        <SquarePrimaryButton
          label="Back to scanning"
          onPress={onReset}
          accessibilityHint="Reopens the scanner."
          testID="app-crash-reset-button"
        />
      </Panel>
    </Column>
  </ScreenSurface>
);
