import { describe, expect, it, vi, beforeEach } from "vitest";

// NOTE: We can't easily execute Next.js server `redirect()` (it throws an
// internal NEXT_REDIRECT error), but we *can* assert that the layout attempts
// to redirect to the intended destination. This gate is defense-in-depth
// alongside the middleware-level gate (see
// `apps/web/src/middleware/staff-route-gate.ts`) — both are covered.

describe("/admin/[slug] layout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("redirects to sign-in with a redirect_url back to /admin/<slug> when there is no session", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi.fn().mockResolvedValue(null);
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    // Not exercised on this branch (redirect() throws before the shell is
    // ever rendered), but the layout module still statically imports it —
    // mock it out so the test doesn't pay for evaluating the real
    // Tamagui/lucide-heavy component tree.
    const AdminShellFrame = () => null;
    vi.doMock("../_components/AdminShellFrame", () => ({ AdminShellFrame }));

    const { default: AdminLayout } = await import("../layout");
    await expect(
      AdminLayout({
        children: null,
        params: Promise.resolve({ slug: "acme" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(getServerSession).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "/sign-in?redirect_url=%2Fadmin%2Facme",
    );
  });

  it("renders the admin shell frame without redirecting when a session is present", async () => {
    const redirect = vi.fn();
    vi.doMock("next/navigation", () => ({ redirect }));

    const getServerSession = vi
      .fn()
      .mockResolvedValue({ user: { id: "human_1" }, session: {} });
    vi.doMock("@/lib/auth/get-server-session", () => ({ getServerSession }));

    const AdminShellFrame = () => null;
    vi.doMock("../_components/AdminShellFrame", () => ({ AdminShellFrame }));

    const { default: AdminLayout } = await import("../layout");
    const result = await AdminLayout({
      children: null,
      params: Promise.resolve({ slug: "acme" }),
    });

    expect(getServerSession).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    // The layout wraps the shell in EventNavProvider (contextual-rail bridge,
    // event-builder regroup FR-202): provider outermost, then its workspace
    // twin AdminPageSectionsProvider (Payouts' in-page rail anchors), then the
    // frame. `AdminShellFrame` rather than `AdminShell` itself because a
    // printable document nested under /admin has to render BARE — the frame
    // owns that branch (see its header, and `AdminShellFrame.test.tsx`), and
    // it must stay a client component so `usePathname` is available. The
    // server-side session gate above runs either way.
    const { EventNavProvider } = await import(
      "../_components/event-nav-context"
    );
    const { AdminPageSectionsProvider } = await import(
      "../_components/admin-page-sections"
    );
    expect(result.type).toBe(EventNavProvider);
    const sections = result.props.children;
    expect(sections.type).toBe(AdminPageSectionsProvider);
    expect(sections.props.children.type).toBe(AdminShellFrame);
  });
});
