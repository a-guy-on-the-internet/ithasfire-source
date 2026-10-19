import { vi } from "vitest";

/**
 * `@sentry/react-native`. `lib/report.ts` stays REAL and calls through to
 * these spies, so a test asserts the branch tag that would reach Sentry —
 * not that some wrapper was called.
 */
export const captureException = vi.fn();
export const addBreadcrumb = vi.fn();
export const captureMessage = vi.fn();
export const setTag = vi.fn();
export const setContext = vi.fn();
