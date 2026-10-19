import { act, renderHook } from "@testing-library/react";
import { createTranslator } from "@th/locale";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";
import { formatErrorMessage } from "@/lib/format-error-message";

import { describeSaveOutcome, type SaveCounts } from "../seat-price-save";
import type { SelectionAction } from "../seat-price-selection";
import { useSeatPriceSave, type SeatPriceWrite } from "../useSeatPriceSave";

const t = createTranslator("en", enMessages as never).t;
const translate = (key: string) => String(t(key));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const seatIds = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => `seat-${from + index}`);
const counts = (updated: number, sold = 0): SaveCounts => ({
  updated,
  skipped: { sold, held: 0, busy: 0, notFound: 0 },
});

describe("useSeatPriceSave (the editor's save, with a mocked mutation)", () => {
  it("partial failure, then a retry of the seats that were not sent", async () => {
    const networkError = new Error("Failed to fetch");
    const write = vi
      .fn<Parameters<SeatPriceWrite>, ReturnType<SeatPriceWrite>>()
      // Try 1: the first 500 go through, the second chunk fails.
      .mockResolvedValueOnce(counts(499, 1))
      .mockRejectedValueOnce(networkError)
      // Try 2: the 200 left over go through.
      .mockResolvedValueOnce(counts(200));
    const refresh = vi.fn(() => Promise.resolve());
    const dispatch = vi.fn<[SelectionAction], void>();

    const { result } = renderHook(() =>
      useSeatPriceSave({ write, refresh, translate, dispatch }),
    );

    const all = seatIds(700);
    await act(async () => {
      await result.current.save(all, { kind: "set", priceCents: 6000 }, "Front");
    });

    // The note rides on every chunk; the second chunk was the failing one.
    expect(write).toHaveBeenNthCalledWith(1, {
      seatIds: all.slice(0, 500),
      priceOverride: { priceCents: 6000, reason: "Front" },
    });
    expect(write).toHaveBeenCalledTimes(2);

    const failed = result.current.outcome!;
    // The error goes through formatErrorMessage WITH the translator.
    expect(failed.errorMessage).toBe(formatErrorMessage(networkError, translate));
    expect(failed.unsentCount).toBe(200);
    // Only what was not sent stays selected.
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "keepOnly",
      seatIds: all.slice(500),
    });
    // The read is refetched even though the save partly failed.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(false);

    const failedView = describeSaveOutcome(failed, t, usd);
    expect(failedView.tone).toBe("error");
    expect(failedView.title).toBe("499 seats updated to $60.00.");
    expect(failedView.failure).toBe(
      "200 seats were not saved. They are still selected, so you can try again.",
    );

    // Retry. The old error is gone the moment the retry starts.
    let resolveRetry: (value: SaveCounts) => void = () => undefined;
    write.mockReset();
    write.mockImplementationOnce(
      () => new Promise<SaveCounts>((resolve) => (resolveRetry = resolve)),
    );
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.save(all.slice(500), { kind: "set", priceCents: 6000 }, "Front");
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.outcome).toBeNull();

    await act(async () => {
      resolveRetry(counts(200));
      await pending;
    });

    const done = result.current.outcome!;
    expect(done.errorMessage).toBeNull();
    expect(dispatch).toHaveBeenLastCalledWith({ type: "clear" });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(describeSaveOutcome(done, t, usd)).toMatchObject({
      tone: "success",
      title: "200 seats updated to $60.00.",
      failure: null,
      failureReason: null,
    });
  });

  it("ignores a second press while a save is running", async () => {
    let finish: (value: SaveCounts) => void = () => undefined;
    const write = vi.fn<Parameters<SeatPriceWrite>, ReturnType<SeatPriceWrite>>(
      () => new Promise<SaveCounts>((resolve) => (finish = resolve)),
    );
    const { result } = renderHook(() =>
      useSeatPriceSave({
        write,
        refresh: () => Promise.resolve(),
        translate,
        dispatch: vi.fn(),
      }),
    );
    let first: Promise<unknown> = Promise.resolve();
    let second: unknown;
    await act(async () => {
      first = result.current.save(["a"], { kind: "clear" }, null);
      second = await result.current.save(["a"], { kind: "clear" }, null);
    });
    expect(second).toBeNull();
    await act(async () => {
      finish(counts(1));
      await first;
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ seatIds: ["a"], priceOverride: null });
  });

  it("a refetch that fails does not turn a good save into an error", async () => {
    const { result } = renderHook(() =>
      useSeatPriceSave({
        write: () => Promise.resolve(counts(3)),
        refresh: () => Promise.reject(new Error("offline")),
        translate,
        dispatch: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.save(seatIds(3), { kind: "clear" }, null);
    });
    expect(result.current.outcome?.errorMessage).toBeNull();
    expect(result.current.saving).toBe(false);
  });
});
