/**
 * useConsent — the anonymous id must not exist until the user decides.
 *
 * `th-anon-id` is a persistent, per-device identifier in localStorage. It used
 * to be minted in the mount effect "so it exists by the time the user clicks",
 * which meant every visitor who merely *saw* the banner — including one who
 * read it and left — got a durable id. Minting an identifier to audit a consent
 * that was never given is the exact tracking the banner asks permission for.
 *
 * It is now minted lazily inside the decision handlers. These tests pin that:
 * rendering alone must write nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const mockRecordMutate = vi.fn((_input: unknown) => {});
vi.mock("@/trpc", () => ({
  trpc: {
    consent: {
      record: {
        useMutation: () => ({ mutate: mockRecordMutate }),
      },
    },
  },
}));

import { useConsent } from "@/hooks/useConsent";

const ANON_ID_KEY = "th-anon-id";

beforeEach(() => {
  mockRecordMutate.mockClear();
  window.localStorage.clear();
  // Expire any consent cookie left behind by a previous test.
  document.cookie = "th-consent=; path=/; max-age=0; SameSite=Lax";
});

describe("useConsent — anonymous id lifecycle", () => {
  it("does not mint an anonymous id just because the banner rendered", () => {
    const { result } = renderHook(() => useConsent());

    expect(result.current.ready).toBe(true);
    expect(result.current.consent).toBeNull();
    expect(window.localStorage.getItem(ANON_ID_KEY)).toBeNull();
    expect(mockRecordMutate).not.toHaveBeenCalled();
  });

  it("mints the id only once the user accepts all", () => {
    const { result } = renderHook(() => useConsent());
    expect(window.localStorage.getItem(ANON_ID_KEY)).toBeNull();

    act(() => {
      result.current.acceptAll("BANNER");
    });

    const id = window.localStorage.getItem(ANON_ID_KEY);
    expect(id).toBeTruthy();
    expect(result.current.consent).toBe("all");
    expect(mockRecordMutate).toHaveBeenCalledTimes(1);
    expect(mockRecordMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        anonymousId: id,
        choice: "ALL",
        source: "BANNER",
      }),
    );
  });

  it("mints the id when the user picks essentials only", () => {
    const { result } = renderHook(() => useConsent());

    act(() => {
      result.current.acceptEssential("BANNER");
    });

    expect(window.localStorage.getItem(ANON_ID_KEY)).toBeTruthy();
    expect(result.current.consent).toBe("essential");
    expect(mockRecordMutate).toHaveBeenCalledWith(
      expect.objectContaining({ choice: "ESSENTIAL", source: "BANNER" }),
    );
  });

  it("reuses the same id across decisions so the audit trail stitches", () => {
    const { result } = renderHook(() => useConsent());

    act(() => {
      result.current.acceptEssential("BANNER");
    });
    const first = window.localStorage.getItem(ANON_ID_KEY);

    act(() => {
      result.current.resetConsent("FOOTER_MANAGE");
    });
    const second = window.localStorage.getItem(ANON_ID_KEY);

    expect(second).toBe(first);
    expect(result.current.consent).toBeNull();
    expect(mockRecordMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ choice: "RESET", source: "FOOTER_MANAGE" }),
    );
  });
});
