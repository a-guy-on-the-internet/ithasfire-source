import { describe, expect, it, vi, beforeEach } from "vitest";

// NOTE: We can't easily execute Next.js server `redirect()` (it throws an
// internal NEXT_REDIRECT error), but we *can* assert that the layout attempts
// to redirect to the intended destination. This gate is defense-in-depth
// alongside the middleware-level gate (see
// `apps/web/src/middleware/staff-route-gate.ts`) — both are covered.

describe("/moderate layout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("redirects to sign-in when there is no session", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi.fn().mockResolvedValue(null);
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const checkModeratorAccessServer = vi
      .fn()
      .mockResolvedValue({ allowed: false, secondFactorEnrolled: false });
    vi.doMock("@/server/moderator-access", () => ({
      checkModeratorAccessServer,
    }));

    const { default: ModerateLayout } = await import("../layout");
    await expect(
      ModerateLayout({ children: null }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(getServerSession).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "/sign-in?redirect_url=%2Fmoderate",
    );
    // Should short-circuit before ever checking moderator access.
    expect(checkModeratorAccessServer).not.toHaveBeenCalled();
    // The FIRST `import("../layout")` cold-transforms the whole ModerateShell
    // module graph (~4-5s), which sits right at the default 5s timeout and
    // flakes under load — give the graph-loading test explicit headroom. The
    // later tests reuse the transform cache and stay on the default.
  }, 15_000);

  it("redirects to /access-denied when signed in but not a moderator", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi
      .fn()
      .mockResolvedValue({ user: { id: "human_1" }, session: {} });
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const checkModeratorAccessServer = vi
      .fn()
      .mockResolvedValue({ allowed: false, secondFactorEnrolled: false });
    vi.doMock("@/server/moderator-access", () => ({
      checkModeratorAccessServer,
    }));

    const { default: ModerateLayout } = await import("../layout");
    await expect(
      ModerateLayout({ children: null }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(checkModeratorAccessServer).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/access-denied");
  });

  it("redirects to /enroll-2fa when signed in and a moderator but missing an enrolled 2nd factor", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi
      .fn()
      .mockResolvedValue({ user: { id: "human_1" }, session: {} });
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const checkModeratorAccessServer = vi
      .fn()
      .mockResolvedValue({ allowed: true, secondFactorEnrolled: false });
    vi.doMock("@/server/moderator-access", () => ({
      checkModeratorAccessServer,
    }));

    const { default: ModerateLayout } = await import("../layout");
    await expect(
      ModerateLayout({ children: null }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith(
      "/enroll-2fa?redirect_url=%2Fmoderate",
    );
  });

  it("renders ModerateShell without redirecting when signed in, a moderator, and 2nd-factor enrolled", async () => {
    const redirect = vi.fn();
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi
      .fn()
      .mockResolvedValue({ user: { id: "human_1" }, session: {} });
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const checkModeratorAccessServer = vi
      .fn()
      .mockResolvedValue({ allowed: true, secondFactorEnrolled: true });
    vi.doMock("@/server/moderator-access", () => ({
      checkModeratorAccessServer,
    }));

    const ModerateShell = () => null;
    vi.doMock("../_components/ModerateShell", () => ({ ModerateShell }));

    const { default: ModerateLayout } = await import("../layout");
    const result = await ModerateLayout({ children: null });

    expect(redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(ModerateShell);
  });
});
