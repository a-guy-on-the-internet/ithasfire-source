/**
 * LocationSection — the builder's venue field with the THIRD-PARTY cascade
 * (venue-confirmation spec, "UI / Flow › Event builder").
 *
 * What this pins, in order of how wrong the surface can be:
 *   1. Owned and granted venues see NOTHING new — no intent, no calendar —
 *      and no placement is ever minted for them. The owner's ruling.
 *   2. A third party gets the cascade with ONLY the offered intents enabled
 *      (unavailable ones disabled with a hint, not hidden), defaults committed
 *      as soon as the options load for a venue picked this session.
 *   3. NO intent picks a room. The room is settled at accept/confirm, on the
 *      draft event; the cascade prints the calendar's rooms read-only and the
 *      placement carries no `spaceId` at all.
 *   4. A hydrated venue shows the cascade but commits NOTHING until touched
 *      (the stored placement is unknown and must not be overwritten).
 *   5. Loading / error / "not taking requests" states, and the radiogroup's
 *      keyboard model (arrows skip disabled radios, focus follows selection).
 *
 * MOCKS: tamagui and @th/ui are reduced to DOM elements that forward the
 * attributes the assertions read — INCLUDING `id`, `tabIndex`, `type`,
 * `onKeyDown`, `htmlFor` and `aria-*` — because a mock that drops those would
 * pass an inaccessible tree silently. `useTranslations` interpolates the REAL
 * en catalog so every assertion is on shipped copy. The maps stack, the
 * address autocomplete and the PlacePicker are stubbed: they have their own
 * suites and only need to stay out of the way.
 */
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import en from "@/i18n/messages/en";
import { shouldRetryPlacePrivacyRead } from "@/lib/places/venue-location-ceiling";

/** Shipped copy from the `admin` block (the catalog's static type is a node tree). */
const ADMIN = (en as Record<string, Record<string, string>>).admin!;
const msg = (key: string): string => {
  const value = ADMIN[key];
  if (typeof value !== "string") throw new Error(`missing message: admin.${key}`);
  return value;
};

const testMocks = vi.hoisted(() => ({
  bookingOptionsUseQuery: vi.fn(),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP =
    /^(data-|aria-)|^(id|role|style|title|tabIndex|type|htmlFor|disabled|onKeyDown)$/;
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
    Stack,
    styled: (_base: unknown, config?: { tag?: string }) =>
      makeStack(config?.tag === "button" ? "button" : "div"),
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role)$/;
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [k: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement("span", domProps, children);
  };
  return {
    Text,
    NextLinkAnchor: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children?: ReactNode;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "a",
        { href, "data-testid": rest["data-testid"] },
        children,
      ),
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "data-testid": rest["data-testid"],
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    Spinner: () => null,
    Money: {
      format: (cents: number, opts?: { currency?: string }) =>
        `${opts?.currency ?? "USD"} ${(cents / 100).toFixed(2)}`,
    },
    StyledSelect: ({
      value,
      options,
      onChange,
      testId,
      selectId,
      ariaDescribedBy,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
      testId?: string;
      selectId?: string;
      ariaDescribedBy?: string;
    }) =>
      React.createElement(
        "select",
        {
          id: selectId,
          "data-testid": testId,
          "aria-describedby": ariaDescribedBy,
          value,
          onChange: (e: { currentTarget: { value: string } }) =>
            onChange(e.currentTarget.value),
        },
        options.map((o) =>
          React.createElement("option", { key: o.value, value: o.value }, o.label),
        ),
      ),
    useTranslations:
      () => (key: string, args?: Record<string, string | number>) => {
        const [ns, leaf] = key.split(".");
        const section = (en as Record<string, Record<string, string>>)[
          ns as string
        ];
        const template = section?.[leaf as string];
        if (typeof template !== "string") {
          throw new Error(`missing message: ${key}`);
        }
        return template.replace(
          /\{(\w+)\}/g,
          (_m, name: string) => String(args?.[name] ?? `{${name}}`),
        );
      },
  };
});

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  MapPin: () => null,
  RotateCcw: () => null,
  Lock: () => null,
  LockOpen: () => null,
  ExternalLink: () => null,
  ShieldAlert: () => null,
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/config/maps", () => ({ isMapEnabled: false }));
vi.mock("@/lib/maps/geocoding", () => ({ reverseGeocode: vi.fn() }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/maps/LocationAutocomplete", () => ({
  default: () => null,
}));
vi.mock("@/components/places/PlacePicker", () => ({
  PlacePicker: ({
    includeAllVenues,
    ownedVenues = true,
    orgId,
    adminSlug,
  }: {
    includeAllVenues?: boolean;
    ownedVenues?: boolean;
    orgId?: string;
    adminSlug?: string;
  }) => (
    <div
      data-testid="place-picker-stub"
      data-include-all={includeAllVenues ? "1" : "0"}
      data-owned={ownedVenues ? "1" : "0"}
      data-org-id={orgId ?? ""}
      data-admin-slug={adminSlug ?? ""}
    />
  ),
}));

vi.mock("@/components/places/PlaceOrAddressField", () => ({
  // The field's own archived notice, rendered as its name + a dismiss button
  // (the real one has its own suite).
  ArchivedPlaceNotice: ({
    name,
    onDismiss,
    testIdBase,
  }: {
    name: string;
    onDismiss: () => void;
    testIdBase: string;
  }) => (
    <div data-testid={`${testIdBase}-notice`}>
      {`archived:${name}`}
      <button type="button" data-testid="stub-dismiss-archived" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ),
  // Buttons fire the same callbacks the real field does (it has its own suite).
  PlaceOrAddressField: ({
    value,
    testIdBase,
    archivedName,
    onPickPlace,
    onPickAddress,
    onClear,
  }: {
    value: { kind: string } | null;
    testIdBase?: string;
    archivedName?: string | null;
    onPickPlace: (p: unknown) => void;
    onPickAddress: (a: unknown) => void;
    onClear: () => void;
  }) => (
    <div
      data-testid="place-or-address-stub"
      data-value-kind={value?.kind ?? ""}
      data-test-id-base={testIdBase ?? ""}
      data-archived-name={archivedName ?? ""}
    >
      <button type="button" data-testid="stub-pick-place" onClick={() => onPickPlace(OTHER_PLACE)}>
        pick place
      </button>
      <button
        type="button"
        data-testid="stub-pick-address"
        onClick={() =>
          onPickAddress({
            formatted: "2190 Nolensville Pike, Nashville, TN 37211",
            line1: "2190 Nolensville Pike",
            poiName: null,
            city: "Nashville",
            region: "TN",
            postalCode: "37211",
            countryCode: "US",
            lat: 36.12,
            lng: -86.74,
          })
        }
      >
        pick address
      </button>
      <button type="button" data-testid="stub-clear" onClick={onClear}>
        clear
      </button>
    </div>
  ),
}));

const OTHER_PLACE = {
  placeId: "00000000-0000-4000-8000-0000000000d4",
  name: "Corner Bar South",
  formattedAddress: "2190A Nolensville Pike, Nashville, TN 37211",
  city: "Nashville",
  region: "TN",
  lat: 36.12,
  lng: -86.74,
  timezone: "America/Chicago",
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
};

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getBookingOptions: {
        useQuery: (...args: unknown[]) =>
          testMocks.bookingOptionsUseQuery(...args),
      },
    },
  },
}));

const { LocationSection } = await import("../LocationSection");
const { resolveBuilderPlacement } = await import(
  "../builder-placement.helpers"
);
const { buildCommunityUpdateFields } = await import(
  "../community-builder.helpers"
);
type LocationState = LocationSectionProps["location"];
type LocationSectionProps = import("../LocationSection").LocationSectionProps;
type BuilderPlacement =
  import("../builder-placement.helpers").BuilderPlacement;
type PlacePickerItem = import("@/components/places/PlacePicker").PlacePickerItem;

const PLACE = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000009";
const MAIN = "00000000-0000-4000-8000-0000000000c1";
const SIDE = "00000000-0000-4000-8000-0000000000c2";
const ROOM_A = "00000000-0000-4000-8000-0000000000a1";
const ROOM_B = "00000000-0000-4000-8000-0000000000a2";

const VENUE: PlacePickerItem = {
  placeId: PLACE,
  name: "The Blue Room",
  formattedAddress: "1 Blue St",
  city: "Nashville",
  region: "TN",
  lat: null,
  lng: null,
  timezone: "America/Chicago",
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
};

const CALENDARS = [
  {
    id: MAIN,
    name: "Main stage",
    isDefault: true,
    acceptsPerform: true,
    acceptsRent: true,
    acceptsUse: false,
    rentalRateCents: 50_000,
    rentalRateCurrency: "USD",
    rentalRateVisible: true,
    spaces: [
      { id: ROOM_A, name: "Room A" },
      { id: ROOM_B, name: "Room B" },
    ],
  },
  {
    id: SIDE,
    name: "Side room",
    isDefault: false,
    acceptsPerform: true,
    acceptsRent: false,
    acceptsUse: false,
    rentalRateCents: null,
    rentalRateCurrency: null,
    rentalRateVisible: false,
    spaces: [{ id: "00000000-0000-4000-8000-0000000000a3", name: "Side" }],
  },
];

function options(overrides: {
  authority?: "owner" | "grant" | "none";
  calendars?: typeof CALENDARS;
  acceptsBookingRequests?: boolean;
  isClaimed?: boolean;
}) {
  return {
    data: {
      placeId: PLACE,
      isClaimed: overrides.isClaimed ?? true,
      acceptsBookingRequests: overrides.acceptsBookingRequests ?? true,
      calendars: overrides.calendars ?? CALENDARS,
      viewer: { authority: overrides.authority ?? "none" },
    },
    isSuccess: true,
    isError: false,
    isLoading: false,
  };
}

const LOADING = {
  data: undefined,
  isSuccess: false,
  isError: false,
  isLoading: true,
};
const FAILED = {
  data: undefined,
  isSuccess: false,
  isError: true,
  isLoading: false,
};

/** Holds the placement the way EventBuilder does, and records every commit. */
function Harness(
  props: Partial<LocationSectionProps> & {
    onCommit?: (p: BuilderPlacement | null) => void;
    /** What EventBuilder seeded on hydration (the STORED placement). */
    initialPlacement?: BuilderPlacement | null;
  },
) {
  const { onCommit, initialPlacement = null, bookingSkip = null, ...rest } = props;
  const [placement, setPlacement] = useState<BuilderPlacement | null>(
    initialPlacement,
  );
  const [locationMode, setLocationMode] = useState<
    LocationSectionProps["locationMode"]
  >(rest.locationMode ?? "place");
  return (
    <LocationSection
      location={{ thPlaceId: PLACE, thPlaceName: VENUE.name }}
      locationSearch=""
      selectedPlace={VENUE}
      visibilityMode="EXACT"
      visibilityRadius={null}
      ownerType="human"
      ownerId="human-1"
      slug="acme"
      hasSavedLocation={false}
      onLocationChange={vi.fn()}
      onLocationSearchChange={vi.fn()}
      onPlaceSelect={vi.fn()}
      onResetLocation={vi.fn()}
      placementSource="picked"
      placementIntentPending={false}
      {...rest}
      bookingSkip={bookingSkip}
      locationMode={locationMode}
      onLocationModeChange={(mode) => {
        rest.onLocationModeChange?.(mode);
        setLocationMode(mode);
      }}
      placement={placement}
      onPlacementChange={(next) => {
        onCommit?.(next);
        setPlacement(next);
      }}
    />
  );
}

beforeEach(() => {
  testMocks.bookingOptionsUseQuery.mockReset();
});

describe("LocationSection — mode toggle", () => {
  it("renders the Address / My Places toggle with aria-pressed and switches on press", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const onMode = vi.fn();
    render(<Harness onLocationModeChange={onMode} />);

    const address = screen.getByTestId("location-mode-address");
    const place = screen.getByTestId("location-mode-place");
    expect(place).toHaveAttribute("aria-pressed", "true");
    expect(address).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(address);
    expect(onMode).toHaveBeenCalledWith("address");
    expect(screen.getByTestId("location-mode-address")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Address mode has no venue, hence no cascade.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("asks for booking options under the OWNER the event saves as, and parks the read without a venue", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness ownerType="org" ownerId={ORG} />);
    expect(testMocks.bookingOptionsUseQuery).toHaveBeenCalledWith(
      { placeId: PLACE, owner: { kind: "org", orgId: ORG } },
      // One retry, transient failures only (an archived place's NOT_FOUND is final).
      expect.objectContaining({
        enabled: true,
        retry: shouldRetryPlacePrivacyRead,
      }),
    );

    testMocks.bookingOptionsUseQuery.mockClear();
    render(<Harness selectedPlace={null} location={{}} />);
    expect(testMocks.bookingOptionsUseQuery).toHaveBeenCalledWith(
      { placeId: "", owner: { kind: "human" } },
      expect.objectContaining({ enabled: false }),
    );
  });

  it("opts the picker into the grouped Your venues / All venues search", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness />);
    expect(screen.getByTestId("place-picker-stub")).toHaveAttribute(
      "data-include-all",
      "1",
    );
  });
});

describe("LocationSection — owned or granted venues see NOTHING new", () => {
  it.each(["owner", "grant"] as const)(
    "authority %s: no intent, no calendar, no space, and no placement minted",
    (authority) => {
      testMocks.bookingOptionsUseQuery.mockReturnValue(options({ authority }));
      const onCommit = vi.fn();
      render(<Harness onCommit={onCommit} />);

      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(screen.queryByTestId("venue-booking-cascade")).toBeNull();
      expect(screen.queryByTestId("venue-booking-loading")).toBeNull();
      expect(
        screen.queryByTestId("venue-booking-not-taking-requests"),
      ).toBeNull();
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("shows the 'verify this place' nudge ONLY to someone who can act on it", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ authority: "owner" }),
    );
    const { unmount } = render(<Harness />);
    expect(
      screen.getByText(msg("ebUnverifiedPlaceHint")),
    ).toBeInTheDocument();
    unmount();

    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ authority: "none" }),
    );
    render(<Harness />);
    // A third party cannot edit someone else's place — the link would 403.
    expect(
      screen.queryByText(msg("ebUnverifiedPlaceHint")),
    ).not.toBeInTheDocument();
  });
});

describe("LocationSection — third-party cascade", () => {
  it("renders only offered intents enabled — the rest disabled with a hint — and commits the defaults", async () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    const group = screen.getByRole("radiogroup", {
      name: msg("ebIntentLabel"),
    });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      "Play here",
      "Rent a space",
      "Use a space",
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[2]).toHaveAttribute("aria-disabled", "true");
    expect(radios[2]).toHaveAttribute("tabindex", "-1");
    expect(radios[1]).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("venue-booking-intent-hint")).toHaveTextContent(
      "Disabled options aren’t offered by this place.",
    );
    // Real <button type="button">s — Enter/Space select natively and none of
    // them can submit the builder's form.
    radios.forEach((r) => expect(r).toHaveAttribute("type", "button"));

    // Defaults committed for a venue PICKED this session: PERFORM on the
    // default calendar, no room.
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith({
        placeId: PLACE,
        bookingIntent: "PERFORM",
        calendarId: MAIN,
      }),
    );
    expect("spaceId" in (onCommit.mock.lastCall?.[0] as object)).toBe(false);

    // The one select is named by a real <label htmlFor>.
    const calendar = screen.getByTestId("venue-booking-calendar");
    expect(calendar).toHaveAccessibleName("Calendar");
    expect(calendar).toHaveValue(MAIN);
    expect(
      Array.from((calendar as HTMLSelectElement).options).map((o) => o.label),
    ).toEqual(["Main stage", "Side room"]);

    // No room CONTROL — the rooms are printed read-only under the calendar,
    // with one line saying who settles it and when.
    expect(screen.queryByTestId("venue-booking-space")).toBeNull();
    expect(screen.getByTestId("venue-booking-rooms")).toHaveTextContent(
      "Rooms: Room A · Room B",
    );
    expect(screen.getByText(msg("ebRoomsHint"))).toBeInTheDocument();
    // PERFORM shows no rental rate.
    expect(screen.queryByTestId("venue-booking-rental-rate")).toBeNull();
    expect(
      screen.getByText(msg("ebPlacementEditLater")),
    ).toBeInTheDocument();
  });

  it("RENT names no room — it prints the calendar's rooms and the rate, and sends no spaceId", async () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    await waitFor(() => expect(onCommit).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("radio", { name: "Rent a space" }));

    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith({
        placeId: PLACE,
        bookingIntent: "RENT",
        calendarId: MAIN,
      }),
    );
    expect(
      screen.getByRole("radio", { name: "Rent a space" }),
    ).toHaveAttribute("aria-checked", "true");

    // A room hire picks no room either: same read-only line as PERFORM.
    expect(screen.queryByTestId("venue-booking-space")).toBeNull();
    expect(screen.getByTestId("venue-booking-rooms")).toHaveTextContent(
      "Rooms: Room A · Room B",
    );
    // Only the calendar accepting RENT is listed.
    expect(
      Array.from(
        (screen.getByTestId("venue-booking-calendar") as HTMLSelectElement)
          .options,
      ).map((o) => o.label),
    ).toEqual(["Main stage"]);
    expect(screen.getByTestId("venue-booking-rental-rate")).toHaveTextContent(
      "USD 500.00 per booking",
    );

    // What the builder would send: the calendar and the intent, no room key.
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement: onCommit.mock.lastCall?.[0] as BuilderPlacement,
        dirty: true,
      }),
    ).toEqual({ calendarId: MAIN, bookingIntent: "RENT" });
  });

  it("a RENT calendar with NO active room does NOT offer RENT — the option is disabled", async () => {
    // Room gate restored 2026-09-23 (`calendarAcceptsIntent`), reversing the
    // 09-22 drop: a calendar with no active space is invalid data, so the
    // cascade withholds the room intents rather than routing a request that
    // could only ever land spaceless.
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ calendars: [{ ...CALENDARS[0]!, spaces: [] }] }),
    );
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    const rent = screen.getByRole("radio", { name: "Rent a space" });
    expect(rent).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("venue-booking-intent-hint")).toHaveTextContent(
      "Disabled options aren’t offered by this place.",
    );
    expect(screen.queryByTestId("venue-booking-rooms")).toBeNull();

    // Clicking it changes nothing — the placement stays on the pitch.
    fireEvent.click(rent);
    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith({
        placeId: PLACE,
        bookingIntent: "PERFORM",
        calendarId: MAIN,
      }),
    );
    expect(screen.queryByTestId("venue-booking-space")).toBeNull();
  });

  it("says the venue is not taking requests — no controls, nothing minted — when no calendar accepts anything or the venue opted out", () => {
    const onCommit = vi.fn();
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ acceptsBookingRequests: false }),
    );
    const { unmount } = render(<Harness onCommit={onCommit} />);
    expect(
      screen.getByTestId("venue-booking-not-taking-requests"),
    ).toHaveTextContent(
      "This place isn’t taking requests through Ithas Fire yet — it’ll show as an address on your event.",
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    unmount();

    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({
        calendars: CALENDARS.map((c) => ({
          ...c,
          acceptsPerform: false,
          acceptsRent: false,
          acceptsUse: false,
        })),
      }),
    );
    render(<Harness onCommit={onCommit} />);
    expect(
      screen.getByTestId("venue-booking-not-taking-requests"),
    ).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows the skeleton while a PICKED venue's options load, and nothing for a hydrated one", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(LOADING);
    const { unmount } = render(<Harness placementSource="picked" />);
    expect(screen.getByTestId("venue-booking-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    unmount();

    render(<Harness placementSource="hydrated" />);
    expect(screen.queryByTestId("venue-booking-loading")).toBeNull();
  });

  it.each(["picked", "hydrated"] as const)(
    "a failed options read (after one retry) renders NOTHING new — fail-closed, whoever the viewer is (%s)",
    (placementSource) => {
      testMocks.bookingOptionsUseQuery.mockReturnValue(FAILED);
      const onCommit = vi.fn();
      render(<Harness placementSource={placementSource} onCommit={onCommit} />);
      // Authority is unknown on error, so an OWNER must see nothing — and the
      // event still saves, as an address (the documented degraded path).
      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(screen.queryByTestId("venue-booking-cascade")).toBeNull();
      expect(screen.queryByTestId("venue-booking-loading")).toBeNull();
      expect(screen.queryByTestId("venue-booking-error")).toBeNull();
      expect(screen.queryByText(/booking options/i)).not.toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("a HYDRATED venue with nothing stored shows the defaults but commits nothing until touched", async () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const onCommit = vi.fn();
    render(<Harness placementSource="hydrated" onCommit={onCommit} />);

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(screen.getByTestId("venue-booking-calendar")).toHaveValue(MAIN);
    // Untouched: the save must leave the stored placement alone.
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Rent a space" }));
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(
        expect.objectContaining({ bookingIntent: "RENT", calendarId: MAIN }),
      ),
    );
  });

  it("while the hydrated intent is still pending, a third party sees the skeleton — never live controls seeded with a guess", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const stored: BuilderPlacement = {
      placeId: PLACE,
      bookingIntent: "PERFORM",
      calendarId: MAIN,
    };
    const onCommit = vi.fn();
    const { unmount } = render(
      <Harness
        placementSource="hydrated"
        initialPlacement={stored}
        placementIntentPending
        onCommit={onCommit}
      />,
    );
    expect(screen.getByTestId("venue-booking-loading")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
    unmount();

    // An OWNER sees nothing either way — the gate sits inside showCascade.
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({ authority: "owner" }));
    render(
      <Harness
        placementSource="hydrated"
        initialPlacement={stored}
        placementIntentPending
      />,
    );
    expect(screen.queryByTestId("venue-booking-loading")).toBeNull();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("a HYDRATED RENT event shows the STORED placement; touching only the calendar keeps RENT", async () => {
    const SIDE_ROOM = "00000000-0000-4000-8000-0000000000a3";
    const twoRentCalendars = [
      CALENDARS[0]!,
      { ...CALENDARS[1]!, acceptsRent: true, spaces: [{ id: SIDE_ROOM, name: "Side" }] },
    ];
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ calendars: twoRentCalendars }),
    );
    const stored: BuilderPlacement = {
      placeId: PLACE,
      bookingIntent: "RENT",
      calendarId: MAIN,
    };
    const onCommit = vi.fn();
    render(
      <Harness
        placementSource="hydrated"
        initialPlacement={stored}
        onCommit={onCommit}
      />,
    );

    // What was SAVED is what shows — not PERFORM / the default calendar.
    expect(screen.getByRole("radio", { name: "Rent a space" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("venue-booking-calendar")).toHaveValue(MAIN);
    expect(onCommit).not.toHaveBeenCalled();
    // Untouched → the save sends nothing.
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement: stored,
        dirty: false,
      }),
    ).toEqual({});

    fireEvent.change(screen.getByTestId("venue-booking-calendar"), {
      target: { value: SIDE },
    });
    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith({
        placeId: PLACE,
        bookingIntent: "RENT",
        calendarId: SIDE,
      }),
    );
    // Switching calendars re-prints the new calendar's rooms.
    expect(screen.getByTestId("venue-booking-rooms")).toHaveTextContent(
      "Rooms: Side",
    );
    // The payload the builder would send keeps RENT on the new calendar —
    // never PERFORM from a default, and never a room.
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement: onCommit.mock.lastCall?.[0] as BuilderPlacement,
        dirty: true,
      }),
    ).toEqual({ calendarId: SIDE, bookingIntent: "RENT" });
  });

  it("keyboard: one tab stop, arrows move focus AND selection through ENABLED radios only, wrapping", async () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness />);
    const play = screen.getByRole("radio", { name: "Play here" });
    const rent = screen.getByRole("radio", { name: "Rent a space" });
    const use = screen.getByRole("radio", { name: "Use a space" });

    expect(play).toHaveAttribute("tabindex", "0");
    expect(rent).toHaveAttribute("tabindex", "-1");
    expect(play.id).toBeTruthy();
    expect(rent.id).not.toBe(play.id);

    play.focus();
    fireEvent.keyDown(play, { key: "ArrowRight" });
    await waitFor(() => expect(rent).toHaveAttribute("aria-checked", "true"));
    expect(document.activeElement).toBe(rent);
    expect(rent).toHaveAttribute("tabindex", "0");
    expect(play).toHaveAttribute("tabindex", "-1");

    // USE is disabled: ArrowRight from RENT wraps to PLAY, never lands on it.
    fireEvent.keyDown(rent, { key: "ArrowRight" });
    await waitFor(() => expect(play).toHaveAttribute("aria-checked", "true"));
    expect(document.activeElement).toBe(play);
    expect(use).toHaveAttribute("aria-checked", "false");

    // Tab is not ours.
    fireEvent.keyDown(play, { key: "Tab" });
    expect(play).toHaveAttribute("aria-checked", "true");
  });
});

/**
 * The save's "request wasn't sent" notice renders in THIS column, under the
 * cascade — with the cascade, not in the tie band's slot at the top of the
 * page. The builder decides WHEN (snapshot gating, `event-first-skip.helpers`);
 * this section only places it.
 */
describe("LocationSection — the refused-ask notice", () => {
  const skip = {
    outcome: "skipped" as const,
    reason: "venue_not_accepting" as const,
    code: "PLACE_NOT_ACCEPTING_REQUESTS",
    message: "booking_requests_unconfigured",
    placeId: PLACE,
    placeName: VENUE.name,
    intent: "PERFORM" as const,
  };

  it("renders the notice under the cascade, naming the venue, when the builder hands one over", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness bookingSkip={skip} />);

    const cascade = screen.getByTestId("venue-booking-cascade");
    const notice = screen.getByTestId("event-first-skip-notice");
    expect(notice).toHaveAttribute("data-code", "PLACE_NOT_ACCEPTING_REQUESTS");
    expect(screen.getByTestId("event-first-skip-notice-headline")).toHaveTextContent(
      `${VENUE.name} hasn’t set its opening hours yet`,
    );
    // Placement: the notice is the cascade's NEXT SIBLING in the one column —
    // not merely somewhere after it in the document.
    expect(cascade.nextElementSibling).toBe(notice);
  });

  it("renders no notice at all when there is no refused ask", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness bookingSkip={null} />);

    expect(screen.getByTestId("venue-booking-cascade")).toBeInTheDocument();
    expect(screen.queryByTestId("event-first-skip-notice")).toBeNull();
  });
});

describe("LocationSection — an ARCHIVED place says so in both modes", () => {
  it("org mode: the notice sits under the picker, names the place, and dismisses", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ authority: "owner" }),
    );
    render(<Harness placeArchivedName={VENUE.name} />);
    expect(screen.getByTestId("event-location-notice")).toHaveTextContent(
      `archived:${VENUE.name}`,
    );
    fireEvent.click(screen.getByTestId("stub-dismiss-archived"));
    expect(screen.queryByTestId("event-location-notice")).toBeNull();
  });

  it("org mode: no notice when the place is not known to be archived", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ authority: "owner" }),
    );
    render(<Harness />);
    expect(screen.queryByTestId("event-location-notice")).toBeNull();
  });

  it("community mode: the one box gets the name and shows its own notice (no second one here)", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(
      <Harness
        communityMode
        ownerType="org"
        ownerId={ORG}
        placeArchivedName={VENUE.name}
      />,
    );
    expect(screen.getByTestId("place-or-address-stub")).toHaveAttribute(
      "data-archived-name",
      VENUE.name,
    );
    expect(screen.queryByTestId("event-location-notice")).toBeNull();
  });
});

describe("LocationSection — community listing (ownerless, books nothing)", () => {
  const skip = {
    outcome: "skipped" as const,
    reason: "venue_not_accepting" as const,
    code: "PLACE_NOT_ACCEPTING_REQUESTS",
    message: "booking_requests_unconfigured",
    placeId: PLACE,
    placeName: VENUE.name,
    intent: "PERFORM" as const,
  };

  it("one box replaces the Address / Place toggle and the picker (owner, 2026-10-13)", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness communityMode ownerType="org" ownerId={ORG} />);

    expect(screen.queryByTestId("location-mode-address")).toBeNull();
    expect(screen.queryByTestId("location-mode-place")).toBeNull();
    // No owned list and no org-scoped picker: the owned PlacePicker is gone.
    expect(screen.queryByTestId("place-picker-stub")).toBeNull();
    const field = screen.getByTestId("place-or-address-stub");
    // The harness holds a picked place, so the field shows it.
    expect(field).toHaveAttribute("data-value-kind", "place");
    expect(field).toHaveAttribute("data-test-id-base", "community-location");
  });

  /** Holds location, mode and place the way EventBuilder does. */
  function CommunityHarness({
    onState,
  }: {
    onState: (s: {
      location: LocationState;
      locationMode: LocationSectionProps["locationMode"];
      selectedPlace: PlacePickerItem | null;
    }) => void;
  }) {
    const [location, setLocation] = useState<LocationState>({
      thPlaceId: PLACE,
      thPlaceName: VENUE.name,
    });
    const [locationMode, setLocationMode] =
      useState<LocationSectionProps["locationMode"]>("place");
    const [selectedPlace, setSelectedPlace] = useState<PlacePickerItem | null>(
      VENUE,
    );
    onState({ location, locationMode, selectedPlace });
    return (
      <LocationSection
        communityMode
        location={location}
        locationSearch=""
        selectedPlace={selectedPlace}
        visibilityMode="EXACT"
        visibilityRadius={null}
        ownerType="human"
        ownerId="human-1"
        slug="acme"
        hasSavedLocation={false}
        onLocationChange={setLocation}
        onLocationSearchChange={vi.fn()}
        onPlaceSelect={setSelectedPlace}
        onResetLocation={vi.fn()}
        placementSource="picked"
        placementIntentPending={false}
        bookingSkip={null}
        locationMode={locationMode}
        onLocationModeChange={setLocationMode}
        placement={null}
        onPlacementChange={vi.fn()}
      />
    );
  }

  it("picking a place in the one box links it, and the save carries its placeId", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    let state!: Parameters<Parameters<typeof CommunityHarness>[0]["onState"]>[0];
    render(<CommunityHarness onState={(s) => (state = s)} />);

    // Address first (unlinks the place), then a different place.
    fireEvent.click(screen.getByTestId("stub-pick-address"));
    expect(state.locationMode).toBe("address");
    expect(state.selectedPlace).toBeNull();
    expect(state.location.thPlaceId).toBeUndefined();
    expect(state.location).toMatchObject({ addressText: "2190 Nolensville Pike, Nashville, TN 37211", countryCode: "US", lat: 36.12 });

    fireEvent.click(screen.getByTestId("stub-pick-place"));
    expect(state.locationMode).toBe("place");
    expect(state.selectedPlace?.placeId).toBe(OTHER_PLACE.placeId);
    expect(state.location.thPlaceId).toBe(OTHER_PLACE.placeId);

    const fields = buildCommunityUpdateFields({
      title: "Thursday round",
      startsAtLocal: "",
      endsAtLocal: "",
      timezone: "America/Chicago",
      location: state.location,
      bodyContent: { type: "doc", content: [] },
      bodyBlockId: "b1",
      categoryId: null,
      savedPlaceId: PLACE,
    });
    expect(fields.placeId).toBe(OTHER_PLACE.placeId);
    expect(fields).not.toHaveProperty("addressText");
  });

  it("an owned event keeps its toggle and the owned picker", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    render(<Harness />);

    expect(screen.getByTestId("location-mode-address")).toBeInTheDocument();
    expect(screen.getByTestId("location-mode-place")).toHaveTextContent(
      msg("ebMyPlaces"),
    );
    expect(screen.queryByTestId("place-or-address-stub")).toBeNull();
  });

  it("never asks for booking options and mounts no cascade, even for a third-party venue picked this session", async () => {
    // The double ANSWERS as a third party with calendars, the exact case
    // that mounts the cascade and commits defaults for an owned event. The
    // gate must hold on its own, not because the read happened to be empty.
    testMocks.bookingOptionsUseQuery.mockReturnValue(options({}));
    const onCommit = vi.fn();
    render(
      <Harness
        communityMode
        ownerType="org"
        ownerId={ORG}
        placementSource="picked"
        onCommit={onCommit}
      />,
    );

    expect(testMocks.bookingOptionsUseQuery).toHaveBeenCalled();
    for (const [input, opts] of testMocks.bookingOptionsUseQuery.mock.calls) {
      expect(input).toMatchObject({ placeId: "" });
      expect(opts).toMatchObject({ enabled: false });
    }
    expect(screen.queryByTestId("venue-booking-cascade")).toBeNull();
    expect(screen.queryByTestId("venue-booking-loading")).toBeNull();
    expect(screen.queryByTestId("venue-booking-not-taking-requests")).toBeNull();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    // Give the commit effect its chance: nothing is minted.
    await waitFor(() => expect(onCommit).not.toHaveBeenCalled());
  });

  it("shows no refused-ask notice and no 'verify this place' nudge", () => {
    testMocks.bookingOptionsUseQuery.mockReturnValue(
      options({ authority: "owner" }),
    );
    render(<Harness communityMode bookingSkip={skip} />);

    expect(screen.queryByTestId("event-first-skip-notice")).toBeNull();
    expect(
      screen.queryByText(msg("ebUnverifiedPlaceHint")),
    ).not.toBeInTheDocument();
  });
});
