import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mock @th/ui — passthrough useTranslations ───────────────────────────
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { useFormErrors } from "../useFormErrors";

describe("useFormErrors", () => {
  // ── 1. Initial state ─────────────────────────────────────────────────
  it("starts with no errors and hasErrors is false", () => {
    const { result } = renderHook(() => useFormErrors());

    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.formError).toBeNull();
    expect(result.current.hasErrors).toBe(false);
  });

  // ── 2. setError with a string ─────────────────────────────────────────
  it("setError with a string sets formError", () => {
    const { result } = renderHook(() => useFormErrors());

    act(() => {
      result.current.setError("Payment failed");
    });

    expect(result.current.formError).toBe("Payment failed");
    expect(result.current.hasErrors).toBe(true);
  });

  // ── 3. setError with an Error object ──────────────────────────────────
  it("setError with an Error object normalizes to formError", () => {
    const { result } = renderHook(() => useFormErrors());

    act(() => {
      result.current.setError(new Error("Network timeout occurred"));
    });

    expect(result.current.formError).toBe("Network timeout occurred");
    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.hasErrors).toBe(true);
  });

  // ── 4. setFieldError sets a field error ───────────────────────────────
  it('setFieldError("email", "Required") sets that field error', () => {
    const { result } = renderHook(() => useFormErrors<"email" | "name">());

    act(() => {
      result.current.setFieldError("email", "Required");
    });

    expect(result.current.fieldErrors).toEqual({ email: "Required" });
    expect(result.current.hasErrors).toBe(true);
  });

  // ── 5. clearField removes a specific field error ──────────────────────
  it("clearField removes that field error", () => {
    const { result } = renderHook(() => useFormErrors<"email" | "name">());

    act(() => {
      result.current.setFieldError("email", "Required");
      result.current.setFieldError("name", "Too short");
    });

    expect(result.current.fieldErrors).toEqual({
      email: "Required",
      name: "Too short",
    });

    act(() => {
      result.current.clearField("email");
    });

    expect(result.current.fieldErrors).toEqual({ name: "Too short" });
    expect(result.current.hasErrors).toBe(true);
  });

  // ── 6. clearAll resets everything ─────────────────────────────────────
  it("clearAll resets all errors", () => {
    const { result } = renderHook(() => useFormErrors<"email">());

    act(() => {
      result.current.setError("Form is invalid");
      result.current.setFieldError("email", "Bad format");
    });

    expect(result.current.hasErrors).toBe(true);

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.formError).toBeNull();
    expect(result.current.hasErrors).toBe(false);
  });

  // ── 7. hasErrors reflects formError or fieldErrors ────────────────────
  it("hasErrors is true when only formError exists", () => {
    const { result } = renderHook(() => useFormErrors());

    act(() => {
      result.current.setError("Server error");
    });

    expect(result.current.hasErrors).toBe(true);
    expect(result.current.fieldErrors).toEqual({});
  });

  it("hasErrors is true when only fieldErrors exist", () => {
    const { result } = renderHook(() => useFormErrors<"name">());

    act(() => {
      result.current.setFieldError("name", "Required");
    });

    expect(result.current.hasErrors).toBe(true);
    expect(result.current.formError).toBeNull();
  });

  it("hasErrors is false after clearing the only error", () => {
    const { result } = renderHook(() => useFormErrors<"name">());

    act(() => {
      result.current.setFieldError("name", "Required");
    });
    expect(result.current.hasErrors).toBe(true);

    act(() => {
      result.current.clearField("name");
    });
    expect(result.current.hasErrors).toBe(false);
  });
});
