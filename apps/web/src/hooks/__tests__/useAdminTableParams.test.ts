import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Router / navigation mocks ─────────────────────────────────────────────

const replace = vi.fn();
let searchParams = new URLSearchParams();
const pathname = "/admin/test-org/orders";

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ replace }),
}));

import { useAdminTableParams } from "../useAdminTableParams";

beforeEach(() => {
  replace.mockClear();
  searchParams = new URLSearchParams();
});

describe("useAdminTableParams ?p= sanitisation", () => {
  it("falls back to page 0 for non-numeric ?p=", () => {
    searchParams = new URLSearchParams("p=abc");
    const { result } = renderHook(() => useAdminTableParams());
    expect(result.current.page).toBe(0);
  });

  it("truncates fractional ?p= to an integer page", () => {
    searchParams = new URLSearchParams("p=1.5");
    const { result } = renderHook(() => useAdminTableParams());
    expect(result.current.page).toBe(0); // trunc(1.5) - 1

    searchParams = new URLSearchParams("p=3.9");
    const { result: r2 } = renderHook(() => useAdminTableParams());
    expect(r2.current.page).toBe(2); // trunc(3.9) - 1
  });

  it("floors negative ?p= at page 0", () => {
    searchParams = new URLSearchParams("p=-3");
    const { result } = renderHook(() => useAdminTableParams());
    expect(result.current.page).toBe(0);
  });

  it("falls back to the default page size for garbage ?ps=", () => {
    searchParams = new URLSearchParams("ps=abc");
    const { result } = renderHook(() => useAdminTableParams());
    expect(result.current.pageSize).toBe(25);

    searchParams = new URLSearchParams("ps=1.5");
    const { result: r2 } = renderHook(() => useAdminTableParams());
    expect(r2.current.pageSize).toBe(25);
  });
});

describe("useAdminTableParams extraKeys", () => {
  it("returns an empty extra map when no extraKeys are declared", () => {
    const { result } = renderHook(() => useAdminTableParams());
    expect(result.current.extra).toEqual({});
  });

  it("reads initial extra values from the URL", () => {
    searchParams = new URLSearchParams("status=PENDING");
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );
    expect(result.current.extra.status).toBe("PENDING");
  });

  it("setExtra sets the value and syncs it to the URL", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setExtra("status", "APPROVED"));

    expect(result.current.extra.status).toBe("APPROVED");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenLastCalledWith(
      `${pathname}?status=APPROVED`,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("setExtra(key, undefined) deletes the param from the URL", () => {
    searchParams = new URLSearchParams("status=PENDING");
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setExtra("status", undefined));

    expect(result.current.extra.status).toBeUndefined();
    expect(replace).toHaveBeenLastCalledWith(
      pathname,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("changing an extra key resets the page to the first page", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);

    act(() => result.current.setExtra("status", "PENDING"));

    expect(result.current.page).toBe(0);
    // The synced URL carries the filter but no stale page param.
    expect(replace).toHaveBeenLastCalledWith(
      `${pathname}?status=PENDING`,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("setting the same value again is a no-op (no URL churn, page kept)", () => {
    searchParams = new URLSearchParams("status=PENDING");
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setPage(3));
    replace.mockClear();

    act(() => result.current.setExtra("status", "PENDING"));

    expect(replace).not.toHaveBeenCalled();
    expect(result.current.page).toBe(3);
  });

  it("same-tick set-then-clear ends cleared (no last-write drop)", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => {
      result.current.setExtra("status", "PENDING");
      result.current.setExtra("status", undefined);
    });

    expect(result.current.extra.status).toBeUndefined();
    // The synced URL reflects the FINAL (cleared) state.
    expect(replace).toHaveBeenLastCalledWith(
      pathname,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("same-tick set-then-clear still resets the page (once)", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);

    act(() => {
      result.current.setExtra("status", "PENDING");
      result.current.setExtra("status", undefined);
    });

    expect(result.current.page).toBe(0);
    expect(result.current.extra.status).toBeUndefined();
    expect(replace).toHaveBeenLastCalledWith(
      pathname,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("ignores keys that were not declared in extraKeys", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setExtra("rogue", "value"));

    expect(result.current.extra).toEqual({ status: undefined });
    expect(replace).not.toHaveBeenCalled();
  });

  it("manages multiple extra keys independently", () => {
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status", "role"] }),
    );

    act(() => result.current.setExtra("status", "PENDING"));
    act(() => result.current.setExtra("role", "usher"));

    expect(result.current.extra).toEqual({ status: "PENDING", role: "usher" });
    expect(replace).toHaveBeenLastCalledWith(
      `${pathname}?status=PENDING&role=usher`,
      expect.objectContaining({ scroll: false }),
    );
  });

  it("preserves unmanaged params while syncing extras", () => {
    searchParams = new URLSearchParams("view=grid");
    const { result } = renderHook(() =>
      useAdminTableParams({ extraKeys: ["status"] }),
    );

    act(() => result.current.setExtra("status", "PENDING"));

    const lastUrl = replace.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain("view=grid");
    expect(lastUrl).toContain("status=PENDING");
  });
});
