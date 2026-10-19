import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LocationAutocomplete from "../LocationAutocomplete";

const mocks = vi.hoisted(() => ({ forwardGeocode: vi.fn() }));

vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: mocks.forwardGeocode,
  autocompleteAddress: vi.fn(),
}));
vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return { ...actual, useTranslations: () => (key: string) => key };
});

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
};

describe("LocationAutocomplete states", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.forwardGeocode.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const type = async (value: string) => {
    const onChange = vi.fn();
    render(
      <LocationAutocomplete value="" onChange={onChange} onSelect={vi.fn()} />,
    );
    const input = screen.getByTestId("location-autocomplete-input");
    fireEvent.change(input, { target: { value } });
    await settle();
    return input;
  };

  it("shows no-results in flow, outside the popup, with a truthful combobox", async () => {
    mocks.forwardGeocode.mockResolvedValue([]);
    const input = await type("Corner Bar Nashville TN");
    const hint = screen.getByTestId("location-autocomplete-hint");
    expect(hint.textContent).toBe("admin.lacNoMatches");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(hint.closest("[role=listbox]")).toBeNull();
    // The icon and popup are positioned against the anchor that wraps only the
    // input; the hint must be OUTSIDE it, or top:50% / top:100% drift.
    const anchor = screen.getByTestId("location-autocomplete-anchor");
    expect(anchor.style.position).toBe("relative");
    expect(anchor.contains(hint)).toBe(false);
    expect(anchor.contains(input)).toBe(true);
    expect(anchor.parentElement).toBe(hint.parentElement);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
  });

  it("shows the error hint when the lookup throws (timeout)", async () => {
    mocks.forwardGeocode.mockRejectedValue(
      new DOMException("timed out", "TimeoutError"),
    );
    await type("Corner Bar Nashville TN");
    expect(screen.getByTestId("location-autocomplete-hint").textContent).toBe(
      "admin.lacSearchError",
    );
  });

  it("Escape dismisses the status-only state and does not bubble", async () => {
    mocks.forwardGeocode.mockResolvedValue([]);
    const input = await type("Corner Bar Nashville TN");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByTestId("location-autocomplete-hint")).toBeNull();
  });
});
