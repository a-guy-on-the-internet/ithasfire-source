// The `/vitest` entry both runs `expect.extend(matchers)` AND augments
// vitest's `Assertion` types — the previous manual `expect.extend` left
// `toBeInTheDocument` & co. untyped, so every DOM-matcher assertion failed
// `tsc --noEmit` while passing at runtime.
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

// The global nav progress bar swaps `useRouter` from `next/navigation` to
// `@bprogress/next/app` app-wide. That hook calls `useProgress()`, which throws
// outside an `<AppProgressProvider>` (not mounted in unit tests). Alias the
// module to `next/navigation` so every existing per-test router mock applies
// unchanged — identical `push`/`replace` signatures, no provider, no wrapping.
vi.mock("@bprogress/next/app", () => import("next/navigation"));

if (typeof window !== "undefined") {
  const existingMatchMedia = (
    window as Window &
      typeof globalThis & { matchMedia?: typeof window.matchMedia }
  ).matchMedia;

  if (typeof existingMatchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: "(prefers-reduced-motion: no-preference)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  // JSDOM doesn't include ResizeObserver, but some Tamagui components (e.g. Tabs)
  // rely on it for layout measurement.
  if (
    typeof (window as Window & typeof globalThis & { ResizeObserver?: unknown })
      .ResizeObserver === "undefined"
  ) {
    class ResizeObserver {
      observe() {
        // noop
      }
      unobserve() {
        // noop
      }
      disconnect() {
        // noop
      }
    }
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      value: ResizeObserver,
    });
  }
}
