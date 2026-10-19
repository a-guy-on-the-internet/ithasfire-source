import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The design-system providers are irrelevant to the mode/cookie logic under
// test; render them as pass-throughs.
vi.mock("@th/ui", () => ({
  IthasFireProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("tamagui", () => ({
  Theme: ({ children }: { children: ReactNode }) => children,
}));

import {
  AppThemeProvider,
  useAppTheme,
} from "@/components/theme/AppThemeProvider";

/**
 * `/embed/*` pins the provider to light (lib/route-context.ts). The lock must
 * not leak into the viewer's own preference: a visitor with `th-theme=dark`
 * who loads an embed on a church website must still get dark on ithasfire.com
 * afterwards. So a locked provider never rewrites the cookie, and toggle is
 * inert.
 */

const clearCookie = () => {
  document.cookie = "th-theme=;path=/;max-age=0";
};

let api: ReturnType<typeof useAppTheme> | null = null;
const Probe = () => {
  api = useAppTheme();
  return null;
};

afterEach(() => {
  clearCookie();
  api = null;
});

describe("AppThemeProvider lock", () => {
  it("unlocked: reconciles the cookie to the server-resolved mode", () => {
    document.cookie = "th-theme=dark;path=/";
    render(
      <AppThemeProvider initialMode="light">
        <Probe />
      </AppThemeProvider>,
    );
    expect(document.cookie).toContain("th-theme=light");
  });

  it("locked: renders light but leaves the viewer's dark cookie alone", () => {
    document.cookie = "th-theme=dark;path=/";
    render(
      <AppThemeProvider initialMode="light" locked>
        <Probe />
      </AppThemeProvider>,
    );
    expect(api?.mode).toBe("light");
    expect(api?.appearance).toBe("stub");
    expect(document.cookie).toContain("th-theme=dark");
  });

  it("locked: toggle is a no-op", () => {
    render(
      <AppThemeProvider initialMode="light" locked>
        <Probe />
      </AppThemeProvider>,
    );
    act(() => api?.toggle());
    expect(api?.mode).toBe("light");
    expect(document.cookie).not.toContain("th-theme=dark");
  });
});
