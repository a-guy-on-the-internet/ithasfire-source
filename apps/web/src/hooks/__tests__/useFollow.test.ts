/**
 * useFollow — signed-out + auth-bounce behavior.
 *
 * The hook opens the IN-PLACE sign-in overlay (`showSignInOverlay`, redirect =
 * current page) for signed-out toggles and mid-flight UNAUTHORIZED bounces —
 * the same pattern as the booking CTAs / checkout — instead of the old
 * `router.push("/sign-in?next=…")` navigation. Signed-in toggles still fire
 * the follow mutation optimistically.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const mockDanger = vi.fn();
vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { danger: mockDanger } }),
  useTranslations: () => (key: string) => key,
}));
const mockShowSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mockShowSignInOverlay }),
}));

const mockUsePathname = vi.fn(() => "/p/some-band");
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

type SessionShape = { data: { user: { id: string } } | null };
const mockUseSession = vi.fn((): SessionShape => ({ data: null }));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mockUseSession() },
}));

type MutateOpts = {
  onError?: (err: { data?: { code?: string } }) => void;
  onSuccess?: () => void;
};
const mockFollowMutate = vi.fn((_input: unknown, _opts?: MutateOpts) => {});
const mockUnfollowMutate = vi.fn((_input: unknown, _opts?: MutateOpts) => {});
const invalidateIsFollowing = vi.fn();
const invalidateFollowerCount = vi.fn();
const invalidateList = vi.fn();

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      follows: {
        listFollowedEntities: { invalidate: invalidateList },
        isFollowing: { invalidate: invalidateIsFollowing },
        getFollowerCount: { invalidate: invalidateFollowerCount },
      },
    }),
    follows: {
      getFollowerCount: {
        useQuery: () => ({ data: { count: 0, isPublic: false } }),
      },
      isFollowing: {
        useQuery: () => ({ data: { isFollowing: false } }),
      },
      followEntity: {
        useMutation: () => ({ mutate: mockFollowMutate, isPending: false }),
      },
      unfollowEntity: {
        useMutation: () => ({ mutate: mockUnfollowMutate, isPending: false }),
      },
    },
  },
}));

import { useFollow } from "../useFollow";

describe("useFollow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFollowMutate.mockImplementation(() => {});
    mockUsePathname.mockReturnValue("/p/some-band");
    mockUseSession.mockReturnValue({ data: null });
  });

  it("signed-out toggle opens the sign-in overlay in place (redirect = current page) and never mutates", () => {
    const { result } = renderHook(() => useFollow("page-1"));

    act(() => result.current.toggle());

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/some-band",
    });
    expect(mockFollowMutate).not.toHaveBeenCalled();
    expect(mockUnfollowMutate).not.toHaveBeenCalled();
    // No optimistic flip for a signed-out viewer.
    expect(result.current.isFollowing).toBe(false);
  });

  it("signed-in toggle fires the follow mutation optimistically", () => {
    mockUseSession.mockReturnValue({ data: { user: { id: "u1" } } });
    const { result } = renderHook(() => useFollow("page-1"));

    act(() => result.current.toggle());

    expect(mockShowSignInOverlay).not.toHaveBeenCalled();
    expect(mockFollowMutate).toHaveBeenCalledWith(
      { entityPageId: "page-1" },
      expect.any(Object),
    );
    expect(result.current.isFollowing).toBe(true);
  });

  it("an UNAUTHORIZED bounce mid-flight opens the sign-in overlay and rolls back", () => {
    mockUseSession.mockReturnValue({ data: { user: { id: "u1" } } });
    mockFollowMutate.mockImplementation((_input, opts) => {
      opts?.onError?.({ data: { code: "UNAUTHORIZED" } });
    });
    const { result } = renderHook(() => useFollow("page-1"));

    act(() => result.current.toggle());

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/some-band",
    });
    // Optimistic flip rolled back on the auth failure.
    expect(result.current.isFollowing).toBe(false);
  });
});

describe("follow mutation feedback", () => {
  it("invalidates the Following list after success", () => {
    mockUseSession.mockReturnValue({ data: { user: { id: "u1" } } });
    mockFollowMutate.mockImplementation((_input, opts) => opts?.onSuccess?.());
    const { result } = renderHook(() => useFollow("page-1"));
    act(() => result.current.toggle());
    expect(invalidateList).toHaveBeenCalled();
  });
  it("shows a failure and rolls back the optimistic state", () => {
    mockDanger.mockClear();
    mockUseSession.mockReturnValue({ data: { user: { id: "u1" } } });
    mockFollowMutate.mockImplementation((_input, opts) =>
      opts?.onError?.({ data: { code: "INTERNAL_SERVER_ERROR" } }),
    );
    const { result } = renderHook(() => useFollow("page-1"));
    act(() => result.current.toggle());
    expect(result.current.isFollowing).toBe(false);
    expect(mockDanger).toHaveBeenCalledWith({
      title: "account.sFollowingToggleError",
    });
  });
});
