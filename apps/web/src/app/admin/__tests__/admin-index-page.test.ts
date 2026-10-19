import { describe, expect, it, vi, beforeEach } from "vitest";

// NOTE: We can't easily execute Next.js server `redirect()` (it throws an internal NEXT_REDIRECT error),
// but we *can* assert that the page attempts to redirect to the intended destination.

describe("/admin index", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("redirects to sign-in with a redirect_url back to /admin when there is no session", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi.fn().mockResolvedValue(null);
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    // Not exercised on this branch (redirect() throws before AdminRoot is
    // ever rendered), but the page module still statically imports it — mock
    // it out so the test doesn't pay for evaluating the real Tamagui-heavy
    // component tree.
    const AdminRoot = () => null;
    vi.doMock("../_components/AdminRoot", () => ({ AdminRoot }));

    const { default: AdminIndexPage } = await import("../page");
    await expect(AdminIndexPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(getServerSession).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/sign-in?redirect_url=%2Fadmin");
  });

  it("renders AdminRoot without redirecting when a session is present", async () => {
    const redirect = vi.fn();
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi
      .fn()
      .mockResolvedValue({ user: { id: "human_1" }, session: {} });
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const AdminRoot = () => null;
    vi.doMock("../_components/AdminRoot", () => ({ AdminRoot }));

    const { default: AdminIndexPage } = await import("../page");
    const result = await AdminIndexPage();

    expect(getServerSession).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(AdminRoot);
  });
});
