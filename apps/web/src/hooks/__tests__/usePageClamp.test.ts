import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePageClamp, type UsePageClampOptions } from "../usePageClamp";

function run(initial: UsePageClampOptions) {
  return renderHook((props: UsePageClampOptions) => usePageClamp(props), {
    initialProps: initial,
  });
}

describe("usePageClamp", () => {
  it("clamps an out-of-range page to the last real page", () => {
    const setPage = vi.fn();
    run({ page: 3, totalPages: 1, setPage });
    expect(setPage).toHaveBeenCalledTimes(1);
    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("does nothing while fetching", () => {
    const setPage = vi.fn();
    run({ page: 3, totalPages: 1, isFetching: true, setPage });
    expect(setPage).not.toHaveBeenCalled();
  });

  it("clamps once the fetch settles", () => {
    const setPage = vi.fn();
    const { rerender } = run({
      page: 3,
      totalPages: 1,
      isFetching: true,
      setPage,
    });
    rerender({ page: 3, totalPages: 1, isFetching: false, setPage });
    expect(setPage).toHaveBeenCalledTimes(1);
    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("never clamps against totalPages of 0 (empty dataset)", () => {
    const setPage = vi.fn();
    run({ page: 3, totalPages: 0, setPage });
    expect(setPage).not.toHaveBeenCalled();
  });

  it("never clamps against undefined totalPages (nothing loaded)", () => {
    const setPage = vi.fn();
    run({ page: 3, totalPages: undefined, setPage });
    expect(setPage).not.toHaveBeenCalled();
  });

  it("leaves an in-range page alone", () => {
    const setPage = vi.fn();
    run({ page: 2, totalPages: 5, setPage });
    expect(setPage).not.toHaveBeenCalled();
  });

  it("fires once — the clamped re-render does not loop", () => {
    const setPage = vi.fn();
    const { rerender } = run({ page: 3, totalPages: 2, setPage });
    expect(setPage).toHaveBeenCalledTimes(1);
    expect(setPage).toHaveBeenCalledWith(1);

    // Consumer applied the clamp; the effect re-runs and stays quiet.
    rerender({ page: 1, totalPages: 2, setPage });
    expect(setPage).toHaveBeenCalledTimes(1);
  });
});
