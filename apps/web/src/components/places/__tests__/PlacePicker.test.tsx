/**
 * PlacePicker — the grouped venue search (venue-confirmation spec, event
 * builder): ONE box, "Your places" (owned) then "All places" (any ACTIVE
 * place from the public index) then "Add a place".
 *
 * Pinned here:
 *   1. The default picker is byte-for-byte the old one: no index query, no
 *      group headers, the "Manage places" footer. Four other consumers rely
 *      on that.
 *   2. Grouped mode: owned places under "Your places"; "All places" only
 *      once two characters are typed, de-duplicated against the owned list;
 *      "Add a place" tail.
 *   3. An "All places" pick is HYDRATED — `places.getPlacePublic`, then
 *      `places.resolveTimezone` from its coordinates — before `onChange`
 *      fires, so the builder receives a full `PlacePickerItem` (the zone is
 *      what its wall-clock logic needs). A failed read keeps the list open
 *      with an inline error and never hands up a half-built item.
 *
 * MOCKS: tamagui / @th/ui reduced to DOM; the debounce hook is identity so
 * the index query keys off the typed value synchronously.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import en from "@/i18n/messages/en";

/** Shipped copy from the `admin` block (the catalog's static type is a node tree). */
const ADMIN = (en as Record<string, Record<string, string>>).admin!;
const msg = (key: string): string => {
  const value = ADMIN[key];
  if (typeof value !== "string") throw new Error(`missing message: admin.${key}`);
  return value;
};

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  autocompleteUseQuery: vi.fn(),
  getPlacePublicFetch: vi.fn(),
  resolveTimezoneFetch: vi.fn(),
  push: vi.fn(),
  traced: vi.fn(),
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    testMocks.traced(label, err),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|onKeyDown)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "span",
        { "data-testid": rest["data-testid"], role: rest.role },
        children,
      ),
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: (e: { stopPropagation: () => void }) => void;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: (e: { stopPropagation: () => void }) => onPress?.(e),
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    useTranslations: () => (key: string) => {
      const [ns, leaf] = key.split(".");
      const section = (en as Record<string, Record<string, string>>)[
        ns as string
      ];
      const template = section?.[leaf as string];
      if (typeof template !== "string") {
        throw new Error(`missing message: ${key}`);
      }
      return template;
    },
  };
});

vi.mock("lucide-react", () => ({
  MapPin: () => null,
  ChevronDown: () => null,
  Search: () => null,
  X: () => null,
  Plus: () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testMocks.push }),
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlacePublic: { fetch: testMocks.getPlacePublicFetch },
        resolveTimezone: { fetch: testMocks.resolveTimezoneFetch },
      },
    }),
    places: {
      listHumanPlaces: {
        useQuery: (...args: unknown[]) => testMocks.listUseQuery(...args),
      },
    },
    search: {
      autocomplete: {
        useQuery: (...args: unknown[]) =>
          testMocks.autocompleteUseQuery(...args),
      },
    },
  },
}));

const { PlacePicker } = await import("../PlacePicker");

const OWNED_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

const OWNED = {
  placeId: OWNED_ID,
  name: "My Bar",
  formattedAddress: "1 Mine St",
  city: "Nashville",
  region: "TN",
  lat: 36.1,
  lng: -86.7,
  postalCode: "37203",
  timezone: "America/Chicago",
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  access: { orgIds: [] as string[] },
};

const suggestion = (placeId: string, title: string) => ({
  type: "place" as const,
  id: `place:${placeId}`,
  placeId,
  title,
  subtitle: `${title} — 2 Their St`,
  helper: null,
  slug: null,
  city: "Nashville",
});

const IDLE = { data: undefined, isLoading: false, isFetching: false };

beforeEach(() => {
  testMocks.listUseQuery.mockReset();
  testMocks.autocompleteUseQuery.mockReset();
  testMocks.getPlacePublicFetch.mockReset();
  testMocks.resolveTimezoneFetch.mockReset();
  testMocks.push.mockReset();
  testMocks.traced.mockReset();
  testMocks.listUseQuery.mockReturnValue({
    data: { places: [OWNED] },
    isLoading: false,
  });
  testMocks.autocompleteUseQuery.mockReturnValue(IDLE);
});

function openPicker() {
  fireEvent.click(screen.getByRole("combobox"));
}

describe("PlacePicker — default (owned only)", () => {
  it("never queries the index, shows no group headers, and keeps the Manage places footer", () => {
    render(<PlacePicker value={null} onChange={vi.fn()} adminSlug="acme" />);
    openPicker();

    expect(screen.getByRole("option", { name: /My Bar/ })).toBeInTheDocument();
    expect(screen.queryByText(msg("ebVenueSearchYours"))).not.toBeInTheDocument();
    expect(screen.queryByText(msg("ebVenueSearchAll"))).not.toBeInTheDocument();
    expect(screen.getByText(msg("pckManagePlaces"))).toBeInTheDocument();
    expect(screen.queryByTestId("place-picker-add-place")).toBeNull();
    // The index query is mounted but parked.
    expect(testMocks.autocompleteUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe("PlacePicker — picking an owned place", () => {
  it("hands up the place's postcode with its address", () => {
    const onChange = vi.fn();
    render(<PlacePicker value={null} onChange={onChange} adminSlug="acme" />);
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /My Bar/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: OWNED_ID,
        formattedAddress: "1 Mine St",
        postalCode: "37203",
      }),
    );
  });
});

describe("PlacePicker — grouped search", () => {
  it("groups owned places under 'Your places' and asks for two characters before searching all places", () => {
    render(
      <PlacePicker
        value={null}
        onChange={vi.fn()}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();

    const yours = screen.getByRole("group", { name: msg("ebVenueSearchYours") });
    expect(yours).toContainElement(screen.getByRole("option", { name: /My Bar/ }));
    expect(screen.getByTestId("place-picker-type-to-search")).toHaveTextContent(
      msg("ebVenueSearchTypeToSearch"),
    );
    expect(screen.queryByRole("group", { name: msg("ebVenueSearchAll") })).toBeNull();
    expect(screen.getByTestId("place-picker-add-place")).toHaveTextContent(
      "Add a place",
    );
    expect(testMocks.autocompleteUseQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("searches ALL active places (types: place, no directory filter) and de-duplicates against the owned list", () => {
    testMocks.autocompleteUseQuery.mockImplementation(
      (input: { query: string }) =>
        input.query === "ba"
          ? {
              data: {
                suggestions: [
                  suggestion(OWNED_ID, "My Bar"),
                  suggestion(OTHER_ID, "Their Bar"),
                ],
              },
              isLoading: false,
              isFetching: false,
            }
          : IDLE,
    );
    render(
      <PlacePicker
        value={null}
        onChange={vi.fn()}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    fireEvent.change(screen.getByPlaceholderText(msg("pckSearchPlaces")), {
      target: { value: "ba" },
    });

    expect(testMocks.autocompleteUseQuery).toHaveBeenLastCalledWith(
      { query: "ba", types: ["place"], limit: 10 },
      expect.objectContaining({ enabled: true }),
    );
    const all = screen.getByRole("group", { name: msg("ebVenueSearchAll") });
    expect(all).toContainElement(screen.getByRole("option", { name: /Their Bar/ }));
    // The owned place appears ONCE — under "Your places", not again under "All".
    expect(screen.getAllByRole("option", { name: /My Bar/ })).toHaveLength(1);
    expect(screen.queryByTestId("place-picker-type-to-search")).toBeNull();
  });

  it("hydrates an 'All places' pick — place read, then its zone — before handing it up", async () => {
    testMocks.autocompleteUseQuery.mockReturnValue({
      data: { suggestions: [suggestion(OTHER_ID, "Their Bar")] },
      isLoading: false,
      isFetching: false,
    });
    testMocks.getPlacePublicFetch.mockResolvedValue({
      place: {
        placeId: OTHER_ID,
        name: "Their Bar",
        formattedAddress: "2 Their St",
        city: "Nashville",
        region: "TN",
        countryCode: "US",
        lat: 36.2,
        lng: -86.8,
        capacity: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    testMocks.resolveTimezoneFetch.mockResolvedValue({
      timezone: "America/Chicago",
    });
    const onChange = vi.fn();
    render(
      <PlacePicker
        value={null}
        onChange={onChange}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    fireEvent.change(screen.getByPlaceholderText(msg("pckSearchPlaces")), {
      target: { value: "their" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Their Bar/ }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        placeId: OTHER_ID,
        name: "Their Bar",
        formattedAddress: "2 Their St",
        city: "Nashville",
        region: "TN",
        lat: 36.2,
        lng: -86.8,
        timezone: "America/Chicago",
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      }),
    );
    expect(testMocks.getPlacePublicFetch).toHaveBeenCalledWith(
      { placeId: OTHER_ID },
      expect.anything(),
    );
    expect(testMocks.resolveTimezoneFetch).toHaveBeenCalledWith(
      { lat: 36.2, lng: -86.8 },
      expect.anything(),
    );
    // The list closes after a successful pick.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("a failed zone lookup degrades to timezone: null AND is reported; a failed place read keeps the list open with an error", async () => {
    testMocks.autocompleteUseQuery.mockReturnValue({
      data: { suggestions: [suggestion(OTHER_ID, "Their Bar")] },
      isLoading: false,
      isFetching: false,
    });
    testMocks.getPlacePublicFetch.mockResolvedValueOnce({
      place: {
        placeId: OTHER_ID,
        name: "Their Bar",
        formattedAddress: null,
        city: null,
        region: null,
        countryCode: null,
        lat: 36.2,
        lng: -86.8,
        capacity: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    const tzFailure = new Error("down");
    testMocks.resolveTimezoneFetch.mockRejectedValueOnce(tzFailure);
    const onChange = vi.fn();
    const { unmount } = render(
      <PlacePicker
        value={null}
        onChange={onChange}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    fireEvent.change(screen.getByPlaceholderText(msg("pckSearchPlaces")), {
      target: { value: "their" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Their Bar/ }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: OTHER_ID, timezone: null }),
      ),
    );
    // Degraded, not silent: the swallow is recorded with a stable label.
    expect(testMocks.traced).toHaveBeenCalledWith(
      "placePicker.resolveTimezone",
      tzFailure,
    );
    unmount();

    testMocks.getPlacePublicFetch.mockRejectedValueOnce(new Error("gone"));
    onChange.mockClear();
    render(
      <PlacePicker
        value={null}
        onChange={onChange}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    fireEvent.change(screen.getByPlaceholderText(msg("pckSearchPlaces")), {
      target: { value: "their" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Their Bar/ }));
    await waitFor(() =>
      expect(screen.getByTestId("place-picker-hydrate-error")).toHaveTextContent(
        msg("ebVenueLoadFailed"),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("a hydration that resolves AFTER the picker was closed hands nothing up (staleness token)", async () => {
    testMocks.autocompleteUseQuery.mockReturnValue({
      data: { suggestions: [suggestion(OTHER_ID, "Their Bar")] },
      isLoading: false,
      isFetching: false,
    });
    let resolvePlace: (value: unknown) => void = () => {};
    testMocks.getPlacePublicFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePlace = resolve;
      }),
    );
    const onChange = vi.fn();
    render(
      <PlacePicker
        value={null}
        onChange={onChange}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    const input = screen.getByPlaceholderText(msg("pckSearchPlaces"));
    fireEvent.change(input, { target: { value: "their" } });
    fireEvent.click(screen.getByRole("option", { name: /Their Bar/ }));
    // Still hydrating: the row says so, and the OWNED rows are parked so two
    // picks can never race.
    expect(screen.getByRole("option", { name: /Their Bar/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(screen.getByRole("option", { name: /My Bar/ }));
    expect(onChange).not.toHaveBeenCalled();

    // Escape closes the picker → the token moves on.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    resolvePlace({
      place: {
        placeId: OTHER_ID,
        name: "Their Bar",
        formattedAddress: null,
        city: null,
        region: null,
        countryCode: null,
        lat: null,
        lng: null,
        capacity: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    await waitFor(() => expect(testMocks.getPlacePublicFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a place read that FAILS after the picker moved on shows no error but is reported", async () => {
    testMocks.autocompleteUseQuery.mockReturnValue({
      data: { suggestions: [suggestion(OTHER_ID, "Their Bar")] },
      isLoading: false,
      isFetching: false,
    });
    let rejectPlace: (err: unknown) => void = () => {};
    testMocks.getPlacePublicFetch.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlace = reject;
      }),
    );
    const onChange = vi.fn();
    render(
      <PlacePicker
        value={null}
        onChange={onChange}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    const input = screen.getByPlaceholderText(msg("pckSearchPlaces"));
    fireEvent.change(input, { target: { value: "their" } });
    fireEvent.click(screen.getByRole("option", { name: /Their Bar/ }));
    fireEvent.keyDown(input, { key: "Escape" });

    const failure = new Error("gone");
    rejectPlace(failure);
    await waitFor(() =>
      expect(testMocks.traced).toHaveBeenCalledWith(
        "placePicker.hydratePlace",
        failure,
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("place-picker-hydrate-error")).toBeNull();
  });

  it("'Add a place' goes to the places admin (the index can lag a just-created place)", () => {
    render(
      <PlacePicker
        value={null}
        onChange={vi.fn()}
        adminSlug="acme"
        includeAllVenues
      />,
    );
    openPicker();
    fireEvent.click(screen.getByTestId("place-picker-add-place"));
    expect(testMocks.push).toHaveBeenCalledWith("/admin/acme/places");
  });
});

describe("PlacePicker — all venues only (community listing)", () => {
  it("parks the owned list, renders no 'Your places', and offers no 'Add a place' without an admin slug", () => {
    // The double would hand back an owned place if asked: the picker must
    // neither ask nor show it.
    render(
      <PlacePicker
        value={null}
        onChange={vi.fn()}
        includeAllVenues
        ownedVenues={false}
      />,
    );
    openPicker();

    expect(testMocks.listUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByRole("group", { name: msg("ebVenueSearchYours") })).toBeNull();
    expect(screen.queryByRole("option", { name: /My Bar/ })).toBeNull();
    expect(screen.getByTestId("place-picker-type-to-search")).toBeInTheDocument();
    expect(screen.queryByTestId("place-picker-add-place")).toBeNull();
  });

  it("still searches every active venue, the owned one included, under a neutral placeholder", () => {
    testMocks.autocompleteUseQuery.mockImplementation(
      (input: { query: string }) =>
        input.query === "ba"
          ? {
              data: {
                suggestions: [
                  suggestion(OWNED_ID, "My Bar"),
                  suggestion(OTHER_ID, "Their Bar"),
                ],
              },
              isLoading: false,
              isFetching: false,
            }
          : IDLE,
    );
    render(
      <PlacePicker
        value={null}
        onChange={vi.fn()}
        includeAllVenues
        ownedVenues={false}
      />,
    );
    openPicker();
    // No owned list, so the box does not say "your places".
    expect(screen.queryByPlaceholderText(msg("pckSearchPlaces"))).toBeNull();
    const venuesPlaceholder = (
      en as unknown as { search: Record<string, string> }
    ).search.placeholderVenues!;
    fireEvent.change(screen.getByPlaceholderText(venuesPlaceholder), {
      target: { value: "ba" },
    });

    const all = screen.getByRole("group", { name: msg("ebVenueSearchAll") });
    // Nothing is de-duplicated away: with no owned list, "My Bar" is just a venue.
    expect(all).toContainElement(screen.getByRole("option", { name: /My Bar/ }));
    expect(all).toContainElement(screen.getByRole("option", { name: /Their Bar/ }));
  });
});
