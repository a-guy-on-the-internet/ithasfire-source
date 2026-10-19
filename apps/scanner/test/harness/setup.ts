
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Setup for the `screen` vitest project (see `vitest.config.ts`).
 *
 * Third-party native modules are ALIASED to stubs in the config. Scanner
 * modules that touch the device are replaced HERE, with `vi.mock`, by the
 * in-memory fakes in this folder. Everything else in `src/` runs for real:
 * the planners, `lib/feedback.ts` (its output channels are captured, see
 * `feedback-recorder.ts`), `lib/report.ts` (it calls the Sentry stub),
 * `use-scan-undo`, `use-express-dwell`, the result views, `@th/ui-native`.
 */

// The device's SQLite.
vi.mock("../../src/lib/local-db", () => import("./fake-local-db"));
// The server.
vi.mock("../../src/trpc", () => import("./fake-server"));
// Ambient device state.
vi.mock("../../src/features/network/use-network-state", () =>
  import("./fake-device-hooks"),
);
vi.mock("../../src/lib/use-screen-reader", () => import("./fake-device-hooks"));
vi.mock("../../src/lib/use-reduced-motion", () => import("./fake-device-hooks"));
vi.mock("../../src/lib/use-brightness-boost", () =>
  import("./fake-device-hooks"),
);
vi.mock("../../src/lib/use-people-search", () => import("./fake-device-hooks"));
// `require()` of a .wav / .png is a Metro transform; vite cannot load either.
vi.mock("../../src/lib/feedback-tones", () => ({
  TONE_ASSETS: { valid: 1, already_scanned: 2, wrong_event: 3, rejected: 4 },
}));
vi.mock("../../src/ui/loading-state", () => ({
  LoadingState: ({ label }: { label?: string }) => label ?? null,
}));

/** React Native's `__DEV__` global. */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

beforeEach(async () => {
  const { resetHarness } = await import("./render-scan-screen");
  resetHarness();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
