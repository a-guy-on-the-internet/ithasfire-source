import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Server-side gate for `/platform/**` — defense in depth alongside the
 * middleware-level gate (`apps/web/src/middleware/staff-route-gate.ts`); both
 * are covered.
 *
 * Unlike its sibling `moderate-layout.test.ts`, these assert on the RETURNED
 * element rather than on a thrown `NEXT_REDIRECT`, because this layout
 * deliberately does not call `redirect()` — see the layout's own doc for why
 * (an RSC `redirect()` did not reliably produce a real 3xx for a full-document
 * request in this repo's production standalone build, so a fallback layer
 * built on it could fail open and serve the console anyway).
 */

type Rendered = { type: unknown; props: Record<string, unknown> };

const PlatformShell = () => null;
const StatusScreen = () => null;

/**
 * The presentation leaves are stubbed, not exercised: `PagePrimitives` and
 * `lucide-react` (one icon imported by the layout directly, plus the ~27 the
 * nav config pulls in through `_components/platform-nav-sections`) are pure
 * view modules with nothing to assert here, and re-evaluating that graph on
 * every `vi.resetModules()` is what pushed this file past the default timeout
 * when the whole `src/app/platform` suite runs in parallel.
 *
 * Stubbing them makes the assertions STRONGER, not weaker: `result.type` can
 * now be compared against a known identity (`StatusScreen` vs `PlatformShell`)
 * instead of a loose "not the shell".
 */
const mockPresentationLeaves = () => {
  vi.doMock("@/components/layout/PagePrimitives", () => ({
    StatusScreen,
    ButtonPrimary: () => null,
    ButtonRow: () => null,
    STATUS_ICON: "#000",
    STATUS_ICON_BG: "#fff",
  }));
  // `lucide-react` is deliberately NOT mocked. A catch-all `Proxy` namespace
  // is the obvious move and fails twice over: a callable `then` makes the
  // namespace look thenable to `await import(...)` and hangs the run (observed:
  // 5/5 timing out at 35s against a 112ms transform), and once that's fixed
  // Vitest rejects it anyway — it validates named exports against the mock's
  // OWN keys, which a get-only Proxy has none of. Enumerating every icon the
  // nav config imports would just be a list to keep in sync. The real module
  // is cheap enough with PagePrimitives stubbed out.
};

const loadLayout = async (opts: {
  session: unknown;
  access: { allowed: boolean; secondFactorEnrolled: boolean };
}) => {
  const getServerSession = vi.fn().mockResolvedValue(opts.session);
  vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

  const checkPlatformStaffAccessServer = vi.fn().mockResolvedValue(opts.access);
  vi.doMock("@/server/platform-staff-access", () => ({
    checkPlatformStaffAccessServer,
  }));

  vi.doMock("../_components/PlatformShell", () => ({ PlatformShell }));
  mockPresentationLeaves();

  const { default: PlatformLayout } = await import("../layout");
  const result = (await PlatformLayout({ children: null })) as Rendered;
  return { result, getServerSession, checkPlatformStaffAccessServer };
};

describe("/platform layout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders a sign-in prompt (not the shell) when there is no session", async () => {
    const { result, checkPlatformStaffAccessServer } = await loadLayout({
      session: null,
      access: { allowed: true, secondFactorEnrolled: true },
    });

    expect(result.props.title).toBe("Sign in required");
    expect(result.type).toBe(StatusScreen);
    // Short-circuits before ever probing staff access.
    expect(checkPlatformStaffAccessServer).not.toHaveBeenCalled();
    // The FIRST `import("../layout")` cold-transforms the layout's module
    // graph, which can sit near the default 5s timeout under load.
  }, 15_000);

  it("renders access-denied (not the shell) when signed in but not platform staff", async () => {
    const { result, checkPlatformStaffAccessServer } = await loadLayout({
      session: { user: { id: "human_1" }, session: {} },
      access: { allowed: false, secondFactorEnrolled: false },
    });

    expect(checkPlatformStaffAccessServer).toHaveBeenCalled();
    expect(result.props.title).toBe("Access denied");
    expect(result.type).toBe(StatusScreen);
  });

  it("renders the 2FA prompt when staff but missing an enrolled 2nd factor", async () => {
    const { result } = await loadLayout({
      session: { user: { id: "human_1" }, session: {} },
      access: { allowed: true, secondFactorEnrolled: false },
    });

    expect(result.props.title).toBe("Second factor required");
    expect(result.type).toBe(StatusScreen);
  });

  it("renders PlatformShell when signed in, staff, and 2nd-factor enrolled", async () => {
    const { result } = await loadLayout({
      session: { user: { id: "human_1" }, session: {} },
      access: { allowed: true, secondFactorEnrolled: true },
    });

    expect(result.type).toBe(PlatformShell);
  });

  it("fails closed: a denied probe never renders the shell even with a valid session", async () => {
    // `checkPlatformStaffAccessServer` resolves to DENIED on any error, so
    // "API down" arrives here as `allowed: false` — assert the layout's half
    // of that contract.
    const { result } = await loadLayout({
      session: { user: { id: "human_1" }, session: {} },
      access: { allowed: false, secondFactorEnrolled: true },
    });

    expect(result.type).toBe(StatusScreen);
    expect(result.props.title).toBe("Access denied");
  });
});
