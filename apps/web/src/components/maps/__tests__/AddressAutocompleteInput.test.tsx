import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddressAutocompleteInput } from "../AddressAutocompleteInput";
import type { GeocodingResult } from "@/lib/maps/geocoding";

/**
 * The combobox contract (FR-016/FR-017 + the a11y floor).
 *
 * Tamagui is stubbed to plain DOM — the same technique the sibling admin suites
 * use — but everything the assertions touch is REAL: the raw `<input>`, the
 * `role="listbox"` popup, the ARIA wiring and the keyboard handler. That
 * matters here more than usual, because `@th/ui`'s TextInput was rejected for
 * this control precisely BECAUSE React Native Web drops `onKeyDown`; stubbing
 * the input away would have hidden the very defect the choice avoids.
 */
const mocks = vi.hoisted(() => ({
  autocompleteAddress: vi.fn(),
  forwardGeocode: vi.fn(),
}));

vi.mock("@/lib/maps/geocoding", () => ({
  autocompleteAddress: mocks.autocompleteAddress,
  forwardGeocode: mocks.forwardGeocode,
}));

vi.mock("tamagui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("tamagui");
  return {
    ...actual,
    YStack: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
    XStack: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return {
    ...actual,
    useTranslations: () => (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
    Text: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
    Spinner: () => <span data-testid="spinner" />,
  };
});

const suggestion = (
  street: string,
  overrides: Partial<GeocodingResult> = {},
): GeocodingResult => ({
  lat: 36.1408,
  lng: -86.7782,
  formattedAddress: `${street}, Nashville, TN 37203, United States`,
  name: null,
  streetLine: street,
  locality: "Nashville",
  region: "Tennessee",
  regionCode: "TN",
  countryCode: "US",
  postalCode: "37203",
  ...overrides,
});

const DEBOUNCE = 350;

function renderInput(
  props: Omit<
    Partial<React.ComponentProps<typeof AddressAutocompleteInput>>,
    "onSelect"
  > = {},
) {
  const onSelect = vi.fn();
  const utils = render(
    <AddressAutocompleteInput
      label="Find address"
      placeholder="Start typing…"
      {...props}
      onSelect={onSelect}
    />,
  );
  return { ...utils, onSelect };
}

const input = () => screen.getByTestId("address-autocomplete-input");

/** Type, run out the debounce, and drain the provider promise chain. */
async function typeAndSettle(value: string) {
  await act(async () => {
    fireEvent.change(input(), { target: { value } });
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("AddressAutocompleteInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.autocompleteAddress.mockReset().mockResolvedValue([]);
    mocks.forwardGeocode.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Debounce + endpoint (NFR-002) ───────────────────────────────────────

  it("hits the AUTOCOMPLETE endpoint once per typing burst, not per keystroke", async () => {
    renderInput();

    await act(async () => {
      for (const value of ["6 D", "6 De", "6 Del", "6 Dela", "6 Delan"]) {
        fireEvent.change(input(), { target: { value } });
      }
      await Promise.resolve();
    });
    expect(mocks.autocompleteAddress).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
      await Promise.resolve();
    });

    expect(mocks.autocompleteAddress).toHaveBeenCalledTimes(1);
    expect(mocks.autocompleteAddress.mock.calls[0]![0]).toBe("6 Delan");
    // The forward-geocode endpoint is for submit time; this control never
    // touches it.
    expect(mocks.forwardGeocode).not.toHaveBeenCalled();
  });

  it("stays silent below the 4-character minimum", async () => {
    renderInput();
    await typeAndSettle("6 D");
    expect(mocks.autocompleteAddress).not.toHaveBeenCalled();
  });

  // ── ARIA combobox wiring ────────────────────────────────────────────────

  it("is a labelled combobox that reports collapsed state before any search", () => {
    renderInput();
    const el = input();

    expect(el).toHaveAttribute("role", "combobox");
    expect(el).toHaveAttribute("aria-expanded", "false");
    expect(el).toHaveAttribute("aria-autocomplete", "list");
    expect(el).toHaveAttribute("aria-controls");
    expect(el).not.toHaveAttribute("aria-activedescendant");
    // Native <label for> association — clickable and screen-reader visible.
    expect(screen.getByLabelText("Find address")).toBe(el);
  });

  it("exposes results as a listbox of options and announces the count", async () => {
    mocks.autocompleteAddress.mockResolvedValue([
      suggestion("6 Delancey St"),
      suggestion("6 Delaware Ave"),
    ]);
    renderInput();
    await typeAndSettle("6 Delan");

    const el = input();
    expect(el).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe(el.getAttribute("aria-controls"));
    expect(screen.getAllByRole("option")).toHaveLength(2);

    expect(screen.getByRole("status")).toHaveTextContent(
      'admin.placeEditAddressSearchResultCount:{"count":2}',
    );
  });

  // ── Keyboard traversal ──────────────────────────────────────────────────

  it("traverses with arrows, tracks aria-activedescendant, and commits on Enter", async () => {
    mocks.autocompleteAddress.mockResolvedValue([
      suggestion("6 Delancey St"),
      suggestion("6 Delaware Ave"),
    ]);
    const { onSelect } = renderInput();
    await typeAndSettle("6 Delan");

    const el = input();
    const [first, second] = screen.getAllByRole("option");

    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el).toHaveAttribute("aria-activedescendant", first!.id);
    expect(first).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el).toHaveAttribute("aria-activedescendant", second!.id);

    // Clamped at the end — no wrap-around past the last option.
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el).toHaveAttribute("aria-activedescendant", second!.id);

    fireEvent.keyDown(el, { key: "Home" });
    expect(el).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(el, { key: "End" });
    expect(el).toHaveAttribute("aria-activedescendant", second!.id);

    await act(async () => {
      fireEvent.keyDown(el, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      line1: "6 Delaware Ave",
    });
  });

  it("dismisses on Escape WITHOUT clearing what was typed", async () => {
    mocks.autocompleteAddress.mockResolvedValue([suggestion("6 Delancey St")]);
    renderInput();
    await typeAndSettle("6 Delan");

    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).toHaveValue("6 Delan");
  });

  it("never traps Tab — focus moves on and the listbox just closes", async () => {
    mocks.autocompleteAddress.mockResolvedValue([suggestion("6 Delancey St")]);
    const { onSelect } = renderInput();
    await typeAndSettle("6 Delan");

    const tab = createEvent(input(), "Tab");
    fireEvent(input(), tab);

    expect(tab.defaultPrevented).toBe(false);
    // And Tab must NOT double as a commit (the shared hook's own key handler
    // does exactly that, which is why this component does not use it).
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // ── Selection payload (FR-017) ──────────────────────────────────────────

  it("resolves structured fields AND coordinates from a clicked suggestion", async () => {
    mocks.autocompleteAddress.mockResolvedValue([suggestion("6 Delancey St")]);
    const { onSelect } = renderInput();
    await typeAndSettle("6 Delan");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("option")[0]!);
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith({
      line1: "6 Delancey St",
      city: "Nashville",
      // The ISO subdivision CODE, not "Tennessee" — `Place.region` stores codes.
      region: "TN",
      postalCode: "37203",
      countryCode: "US",
      formatted: "6 Delancey St, Nashville, TN 37203, United States",
      lat: 36.1408,
      lng: -86.7782,
    });
  });

  it("leads a named POI with its NAME, so a venue and its building are distinguishable", async () => {
    // Geoapify answers "6 Delancey St, New York" with BOTH the amenity and the
    // building at that address. Leading with `streetLine` rendered two rows
    // reading exactly the same.
    mocks.autocompleteAddress.mockResolvedValue([
      suggestion("6 Delancey Street", { name: "Bowery Ballroom" }),
      suggestion("6 Delancey Street"),
    ]);
    renderInput();
    await typeAndSettle("6 Delancey");

    const [named, plain] = screen.getAllByRole("option");
    expect(named).toHaveTextContent("Bowery Ballroom");
    expect(named).toHaveTextContent("6 Delancey Street");
    expect(plain).not.toHaveTextContent("Bowery Ballroom");
    expect(named!.textContent).not.toBe(plain!.textContent);
  });

  it("falls back to the long-form region when no ISO code is returned", async () => {
    mocks.autocompleteAddress.mockResolvedValue([
      suggestion("12 Rue Test", { regionCode: null, region: "Occitanie" }),
    ]);
    const { onSelect } = renderInput();
    await typeAndSettle("12 Rue");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("option")[0]!);
      await Promise.resolve();
    });
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ region: "Occitanie" });
  });

  it("clears the search box after a commit — it is a tool, not a field", async () => {
    mocks.autocompleteAddress.mockResolvedValue([suggestion("6 Delancey St")]);
    renderInput();
    await typeAndSettle("6 Delan");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("option")[0]!);
      await Promise.resolve();
    });

    expect(input()).toHaveValue("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // ── Degradation to manual entry ─────────────────────────────────────────

  it("offers manual entry when the provider finds nothing", async () => {
    mocks.autocompleteAddress.mockResolvedValue([]);
    const onRequestManualEntry = vi.fn();
    renderInput({ onRequestManualEntry });
    await typeAndSettle("nowhere at all");

    // Scoped to the visible hint: the sr-only live region deliberately carries
    // the SAME sentence (announced on change, readable on browse), so an
    // unscoped text query matches twice.
    const hint = within(screen.getByTestId("address-autocomplete-hint"));
    expect(
      hint.getByText("admin.placeEditAddressSearchNoResults"),
    ).toBeInTheDocument();

    fireEvent.click(hint.getByText("admin.placeEditAddressManualCta"));
    expect(onRequestManualEntry).toHaveBeenCalledTimes(1);
  });

  it("degrades to manual entry — never a blocked form — when the provider fails", async () => {
    mocks.autocompleteAddress.mockRejectedValue(new Error("503"));
    const onRequestManualEntry = vi.fn();
    renderInput({ onRequestManualEntry });
    await typeAndSettle("6 Delancey");

    const hint = within(screen.getByTestId("address-autocomplete-hint"));
    expect(
      hint.getByText("admin.placeEditAddressSearchError"),
    ).toBeInTheDocument();
    // Distinct from "we looked and found nothing".
    expect(
      hint.queryByText("admin.placeEditAddressSearchNoResults"),
    ).toBeNull();
    // The input is still usable, and so is the escape hatch.
    expect(input()).not.toBeDisabled();
    fireEvent.click(hint.getByText("admin.placeEditAddressManualCta"));
    expect(onRequestManualEntry).toHaveBeenCalledTimes(1);
  });
});

/** A cancelable keydown we can inspect for `preventDefault`. */
function createEvent(el: Element, key: string) {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
}
