import "@testing-library/jest-dom/vitest";

/**
 * React Native's `__DEV__` global. `theme.tsx` reads it on the SecureStore
 * failure path.
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
