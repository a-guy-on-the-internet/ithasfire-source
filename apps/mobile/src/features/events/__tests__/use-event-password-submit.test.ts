import { describe, expect, it, vi } from "vitest";

import { VALIDATE_PASSWORD_MUTATION_OPTIONS } from "../event-password-challenge";
import { useEventPasswordSubmit } from "../use-event-password-submit";

// `vi.hoisted` / `vi.mock` run before the imports above. The hook is called
// as a plain function: React's hooks are stubbed, and the
// native / app modules it imports are mocked, so this runs in node.
const { useMutation } = vi.hoisted(() => ({
  useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));

vi.mock("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial: T) => [initial, vi.fn()],
}));
vi.mock("expo-linking", () => ({ createURL: vi.fn() }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("@sentry/react-native", () => ({ captureException: vi.fn() }));
vi.mock("@/config/api", () => ({ getWebBaseUrl: () => "https://ithasfire.com" }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    events: { validatePassword: { useMutation } },
  },
}));

describe("useEventPasswordSubmit", () => {
  it("passes the no-retry options to useMutation (app default is retry: 1)", () => {
    useEventPasswordSubmit({ eventId: "evt_1", onUnlocked: () => {} });
    expect(useMutation).toHaveBeenCalledTimes(1);
    expect(useMutation).toHaveBeenCalledWith(VALIDATE_PASSWORD_MUTATION_OPTIONS);
    expect(useMutation).toHaveBeenCalledWith(
      expect.objectContaining({ retry: false }),
    );
  });
});
