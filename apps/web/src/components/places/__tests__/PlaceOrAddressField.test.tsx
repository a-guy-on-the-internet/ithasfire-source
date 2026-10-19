/**
 * PlaceOrAddressField — the one-box community Location field (board option
 * A) and its PlaceDialog.
 *
 * Pinned:
 *   1. Groups and order: "On Ithas Fire" places, then geocoder "Addresses",
 *      then "Add a place" (moderators only); keyboard runs across groups.
 *   2. Two places (or two businesses) at one address read differently.
 *   3. A search that matched nothing says so in flow, and the tail offers
 *      the query as a place; a dead geocoder says so; a dead place index
 *      leaves addresses working.
 *   4. "Add a place" prefills Name with the query.
 *   5. The second-factor and editability refusals are said BEFORE any form.
 *   6. PLACE_ALREADY_EXISTS → "Use this place" selects the existing place.
 *
 * MOCKS: tamagui and the @th/ui pieces used here are reduced to DOM;
 * `useTranslations` reads the REAL en catalog, so assertions are on shipped
 * copy. tRPC and the geocoder are doubles.
 */
import * as React from "react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import en from "@/i18n/messages/en";

const CATALOG = en as Record<string, Record<string, string>>;
function translate(key: string, values?: Record<string, unknown>): string {
  const [ns, leaf] = key.split(".");
  const template = CATALOG[ns as string]?.[leaf as string];
  if (typeof template !== "string") throw new Error(`missing message: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    values && name in values ? String(values[name]) : `{${name}}`,
  );
}
const cc = (leaf: string, values?: Record<string, unknown>) =>
  translate(`communityCreate.${leaf}`, values);

const m = vi.hoisted(() => ({
  moderator: { allowed: true, secondFactorEnrolled: true },
  autocomplete: vi.fn(),
  forwardGeocode: vi.fn(),
  getPlacePublic: vi.fn(),
  resolveTimezone: vi.fn(),
  editability: vi.fn(),
  createPlace: vi.fn(),
  updatePlace: vi.fn(),
  archivePlace: vi.fn(),
  refetch: vi.fn(),
  invalidatePlace: vi.fn(),
  invalidateSearch: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/@dev/events/new/community" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(v: T) => v,
}));
vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: m.forwardGeocode,
  autocompleteAddress: m.forwardGeocode,
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
  isAbortError: (e: unknown) =>
    e instanceof DOMException && e.name === "AbortError",
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
    const dom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (/^(data-|aria-)|^(id|role)$/.test(k)) dom[k] = v;
    }
    return React.createElement("div", dom, children);
  };
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const pass = (rest: Record<string, unknown>) => {
    const dom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (/^(data-|aria-)|^(id|role)$/.test(k)) dom[k] = v;
    }
    return dom;
  };
  const Text = ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) =>
    React.createElement("span", pass(rest), children);
  const Button = ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "data-testid": testID },
      children,
    );
  const TextInput = ({
    value,
    onChangeText,
    id,
    testId,
  }: {
    value: string;
    onChangeText: (v: string) => void;
    id?: string;
    testId?: string;
  }) =>
    React.createElement("input", {
      id,
      value,
      "data-testid": testId,
      onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
    });
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", { role: "dialog" }, children) : null,
    {
      Panel: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
      Header: ({ title, subtitle }: { title: string; subtitle?: string }) =>
        React.createElement(
          "div",
          null,
          React.createElement("h2", null, title),
          subtitle ? React.createElement("p", null, subtitle) : null,
        ),
      Body: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
      Footer: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
    },
  );
  return {
    Text,
    Button,
    TextInput,
    Modal,
    useLocale: () => "en",
    useTranslations: () => translate,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlacePublic: {
          fetch: m.getPlacePublic,
          invalidate: m.invalidatePlace,
        },
        resolveTimezone: { fetch: m.resolveTimezone },
      },
      community: { getPlaceEditability: { fetch: m.editability } },
      search: { autocomplete: { invalidate: m.invalidateSearch } },
    }),
    community: {
      checkModeratorAccess: {
        useQuery: () => ({ data: m.moderator, refetch: m.refetch }),
      },
      createPlace: {
        useMutation: () => ({ mutateAsync: m.createPlace, isPending: false }),
      },
      updatePlace: {
        useMutation: () => ({ mutateAsync: m.updatePlace, isPending: false }),
      },
      archivePlace: {
        useMutation: () => ({ mutateAsync: m.archivePlace, isPending: false }),
      },
    },
    search: {
      autocomplete: {
        useQuery: (input: { query: string }, opts: { enabled: boolean }) =>
          m.autocomplete(input, opts),
      },
    },
  },
}));

const { PlaceOrAddressField } = await import("../PlaceOrAddressField");
type Value = import("../PlaceOrAddressField").PlaceOrAddressValue;

const PLACE_A = "00000000-0000-4000-8000-0000000000a1";
const PLACE_B = "00000000-0000-4000-8000-0000000000b2";

const placeHit = (placeId: string, title: string, subtitle: string) => ({
  type: "place",
  id: `place_${placeId}`,
  placeId,
  title,
  subtitle,
  helper: null,
  pageSlug: null,
  city: "Nashville",
});

const geoHit = (name: string | null, street: string) => ({
  lat: 36.12,
  lng: -86.74,
  formattedAddress: `${name ? `${name}, ` : ""}${street}, Nashville, TN 37211, United States`,
  name,
  streetLine: street,
  locality: "Nashville",
  region: "Tennessee",
  regionCode: "TN",
  countryCode: "US",
  postalCode: "37211",
});

function placesAnswer(hits: unknown[], extra: Record<string, unknown> = {}) {
  m.autocomplete.mockImplementation(
    (_input: unknown, opts: { enabled: boolean }) => ({
      data: opts.enabled ? { suggestions: hits } : undefined,
      isFetching: false,
      isError: false,
      ...extra,
    }),
  );
}

function renderField(
  value: Value = null,
  handlers: Partial<{
    onPickPlace: ReturnType<typeof vi.fn>;
    onPickAddress: ReturnType<typeof vi.fn>;
    onClear: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const props = {
    onPickPlace: handlers.onPickPlace ?? vi.fn(),
    onPickAddress: handlers.onPickAddress ?? vi.fn(),
    onClear: handlers.onClear ?? vi.fn(),
  };
  render(<PlaceOrAddressField value={value} {...props} />);
  return props;
}

async function type(text: string) {
  const input = screen.getByTestId("place-or-address-input");
  fireEvent.change(input, { target: { value: text } });
  // The geocoder's 350ms debounce, then its promise.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  return input;
}

const optionTexts = () =>
  screen.getAllByRole("option").map((o) => o.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  m.moderator = { allowed: true, secondFactorEnrolled: true };
  m.refetch.mockImplementation(() => Promise.resolve({ data: m.moderator }));
  placesAnswer([]);
  m.forwardGeocode.mockResolvedValue([]);
});

describe("PlaceOrAddressField — one box, places first", () => {
  it("lists our places, then addresses, then Add a place, in that order", async () => {
    placesAnswer([placeHit(PLACE_A, "Plaza Mariachi", "3955 Nolensville Pike")]);
    m.forwardGeocode.mockResolvedValue([
      geoHit(null, "2190 Nolensville Pike"),
    ]);
    renderField();
    await type("2190 Nolensville");

    const listbox = screen.getByRole("listbox");
    const groups = within(listbox).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      cc("pfGroupPlaces"),
      cc("pfGroupAddresses"),
    ]);
    const texts = optionTexts();
    expect(texts[0]).toContain("Plaza Mariachi");
    expect(texts[1]).toContain("2190 Nolensville Pike");
    expect(texts[2]).toBe(cc("pfAddPlace"));
    expect(texts).toHaveLength(3);
  });

  it("two places, and two businesses, at one address read differently", async () => {
    placesAnswer([
      placeHit(PLACE_A, "Corner Bar South", "2190 Nolensville Pike"),
      placeHit(PLACE_B, "Taqueria La Hacienda", "2190 Nolensville Pike"),
    ]);
    m.forwardGeocode.mockResolvedValue([
      geoHit("Corner Bar", "2190 Nolensville Pike"),
      geoHit("Las Palmas", "2190 Nolensville Pike"),
    ]);
    renderField();
    await type("2190 Nolensville");

    const texts = optionTexts().slice(0, 4);
    expect(new Set(texts).size).toBe(4);
    // The street line still shows on each, under the name.
    for (const text of texts) expect(text).toContain("2190 Nolensville Pike");
    // Place rows carry the city when the street line does not.
    expect(texts[0]).toContain("2190 Nolensville Pike, Nashville");
  });

  it("arrows run across both groups and Enter picks; Escape closes without bubbling", async () => {
    placesAnswer([placeHit(PLACE_A, "Plaza Mariachi", "3955 Nolensville Pike")]);
    const hit = geoHit("Corner Bar", "2190 Nolensville Pike");
    m.forwardGeocode.mockResolvedValue([hit]);
    const { onPickAddress } = renderField();
    const input = await type("2190 Nolensville");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      "place-or-address-option-0",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      "place-or-address-option-1",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPickAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        poiName: "Corner Bar",
        line1: "2190 Nolensville Pike",
        countryCode: "US",
      }),
    );

    await type("2190 Nolensville");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says nothing matched above the tail, and offers the query as a place", async () => {
    renderField();
    await type("Corner Bar Nashville TN");

    const said = cc("pfNoMatches", { query: "Corner Bar Nashville TN" });
    const hint = screen.getByTestId("place-or-address-hint");
    expect(hint.textContent).toBe(said);
    // Inside the popup (which would cover a line under the input), not an
    // option, and announced once through the live region.
    expect(hint.closest("[role=listbox]")).not.toBeNull();
    expect(hint.getAttribute("role")).toBe("presentation");
    expect(screen.getByRole("status").textContent).toBe(said);
    expect(optionTexts()).toEqual([
      cc("pfAddQueryAsPlace", { query: "Corner Bar Nashville TN" }),
    ]);
    expect(screen.queryByText(cc("pfSearching"))).toBeNull();
  });

  it("with no popup to hold it (not a moderator), the no-match line sits in flow", async () => {
    m.moderator = { allowed: false, secondFactorEnrolled: false };
    renderField();
    await type("Corner Bar Nashville TN");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("place-or-address-hint").textContent).toBe(
      cc("pfNoMatches", { query: "Corner Bar Nashville TN" }),
    );
  });

  it("a dead geocoder says so; our places still answer", async () => {
    placesAnswer([placeHit(PLACE_A, "Plaza Mariachi", "3955 Nolensville Pike")]);
    m.forwardGeocode.mockRejectedValue(
      new DOMException("timed out", "TimeoutError"),
    );
    renderField();
    await type("2190 Nolensville");

    expect(optionTexts()[0]).toContain("Plaza Mariachi");
    expect(
      within(screen.getByRole("listbox")).getByText(
        translate("admin.lacSearchError"),
      ),
    ).toBeInTheDocument();
  });

  it("a dead place index leaves addresses working", async () => {
    placesAnswer([], { isError: true, data: undefined });
    m.forwardGeocode.mockResolvedValue([geoHit(null, "2190 Nolensville Pike")]);
    renderField();
    await type("2190 Nolensville");

    expect(optionTexts()[0]).toContain("2190 Nolensville Pike");
    expect(
      within(screen.getByRole("listbox")).getByText(cc("pfPlacesError")),
    ).toBeInTheDocument();
  });

  it("someone who is not a moderator gets the box without Add or Edit", async () => {
    m.moderator = { allowed: false, secondFactorEnrolled: false };
    m.forwardGeocode.mockResolvedValue([geoHit(null, "2190 Nolensville Pike")]);
    renderField();
    await type("2190 Nolensville");
    expect(optionTexts().join("|")).not.toContain(cc("pfAddPlace"));
  });

  it("picking a place hands up the hydrated place, zone included", async () => {
    placesAnswer([placeHit(PLACE_A, "Plaza Mariachi", "3955 Nolensville Pike")]);
    m.getPlacePublic.mockResolvedValue({
      place: {
        placeId: PLACE_A,
        name: "Plaza Mariachi",
        formattedAddress: "3955 Nolensville Pike",
        city: "Nashville",
        region: "TN",
        countryCode: "US",
        lat: 36.1,
        lng: -86.7,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    m.resolveTimezone.mockResolvedValue({ timezone: "America/Chicago" });
    const { onPickPlace } = renderField();
    await type("Plaza");
    fireEvent.click(screen.getAllByRole("option")[0]!);
    await waitFor(() =>
      expect(onPickPlace).toHaveBeenCalledWith(
        expect.objectContaining({
          placeId: PLACE_A,
          timezone: "America/Chicago",
          lat: 36.1,
        }),
      ),
    );
  });
});

describe("PlaceOrAddressField — adding and editing places", () => {
  it("Add a place opens the dialog with the query as the Name", async () => {
    renderField();
    await type("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-or-address-add"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(cc("pdAddTitle"))).toBeInTheDocument();
    expect(
      (within(dialog).getByTestId("place-dialog-name") as HTMLInputElement)
        .value,
    ).toBe("Corner Bar South");
  });

  it("a missing second factor is said before any dialog, with a new-tab setup link", async () => {
    m.moderator = { allowed: true, secondFactorEnrolled: false };
    renderField();
    await type("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-or-address-add"));

    const link = await screen.findByTestId("place-second-factor-link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("href")).toContain("/enroll-2fa");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.refetch).toHaveBeenCalled();
  });

  it("Edit place says why not BEFORE any form when the place can't be edited", async () => {
    m.editability.mockResolvedValue({
      placeId: PLACE_A,
      status: "ACTIVE",
      canEdit: false,
      canArchive: false,
      canRestore: false,
      reason: "CLAIM_PENDING",
      linkedListingCount: 0,
    });
    renderField({
      kind: "place",
      place: {
        placeId: PLACE_A,
        name: "Plaza Mariachi",
        formattedAddress: "3955 Nolensville Pike",
        city: "Nashville",
        region: "TN",
        lat: 1,
        lng: 2,
        timezone: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));

    expect(
      await screen.findByText(cc("pfRefusedClaimTitle")),
    ).toBeInTheDocument();
    expect(screen.getByText(cc("pfRefusedClaimBody"))).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.editability).toHaveBeenCalledWith(
      { placeId: PLACE_A },
      expect.anything(),
    );
  });

  it.each([
    ["restorable (reason null)", null],
    ["a duplicate is active", "DUPLICATE_ACTIVE"],
    ["archived by staff", "NOT_COMMUNITY_ARCHIVED"],
  ])("an archived place says it is archived (%s), not that staff look after it", async (_label, reason) => {
    m.editability.mockResolvedValue({
      placeId: PLACE_A,
      status: "ARCHIVED",
      canEdit: false,
      canArchive: false,
      canRestore: reason === null,
      reason,
      linkedListingCount: 0,
    });
    renderField({
      kind: "place",
      place: {
        placeId: PLACE_A,
        name: "Plaza Mariachi",
        formattedAddress: null,
        city: null,
        region: null,
        lat: null,
        lng: null,
        timezone: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    expect(
      await screen.findByText(cc("pfArchivedTitle", { name: "Plaza Mariachi" })),
    ).toBeInTheDocument();
    expect(screen.getByText(cc("pfIsArchivedBody"))).toBeInTheDocument();
    expect(screen.queryByText(cc("pfRefusedNotActiveBody"))).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a place the caller knows is archived says so on open, with no click, and only once after Edit", async () => {
    m.editability.mockResolvedValue({
      placeId: PLACE_A,
      status: "ARCHIVED",
      canEdit: false,
      canArchive: false,
      canRestore: true,
      reason: null,
      linkedListingCount: 0,
    });
    render(
      <PlaceOrAddressField
        value={{
          kind: "place",
          place: {
            placeId: PLACE_A,
            name: "Plaza Mariachi",
            formattedAddress: null,
            city: null,
            region: null,
            lat: null,
            lng: null,
            timezone: null,
            status: "ACTIVE",
            verificationStatus: "UNVERIFIED",
          },
        }}
        onPickPlace={vi.fn()}
        onPickAddress={vi.fn()}
        onClear={vi.fn()}
        archivedName="Plaza Mariachi"
      />,
    );
    const title = cc("pfArchivedTitle", { name: "Plaza Mariachi" });
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(cc("pfIsArchivedBody"))).toBeInTheDocument();
    expect(m.editability).not.toHaveBeenCalled();

    // "Edit place" lands on the same notice: one, never two.
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    await waitFor(() => expect(m.editability).toHaveBeenCalled());
    expect(await screen.findAllByText(title)).toHaveLength(1);
  });

  it("the archived notice survives a NEW value object for the same place, a dismissal holds, and another place shows none", () => {
    const placeValue = (placeId: string, name: string) => ({
      kind: "place" as const,
      place: {
        placeId,
        name,
        formattedAddress: null,
        city: null,
        region: null,
        lat: null,
        lng: null,
        timezone: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    const field = (value: ReturnType<typeof placeValue>, archivedName: string | null) => (
      <PlaceOrAddressField
        value={value}
        onPickPlace={vi.fn()}
        onPickAddress={vi.fn()}
        onClear={vi.fn()}
        archivedName={archivedName}
      />
    );
    const title = cc("pfArchivedTitle", { name: "Plaza Mariachi" });
    const { rerender } = render(field(placeValue(PLACE_A, "Plaza Mariachi"), "Plaza Mariachi"));
    expect(screen.getByText(title)).toBeInTheDocument();

    // The builder rebuilds `value` on any location change: same place, new object.
    rerender(field(placeValue(PLACE_A, "Plaza Mariachi"), "Plaza Mariachi"));
    expect(screen.getByText(title)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: cc("pfDismiss") }));
    expect(screen.queryByText(title)).toBeNull();
    rerender(field(placeValue(PLACE_A, "Plaza Mariachi"), "Plaza Mariachi"));
    expect(screen.queryByText(title)).toBeNull();

    // Another place, not known to be archived: nothing.
    rerender(field(placeValue("00000000-0000-4000-8000-0000000000f2", "Other"), null));
    expect(screen.queryByTestId("place-or-address-notice")).toBeNull();
  });

  it("closing a refusal shown over the archived notice brings the archived notice back", async () => {
    m.editability.mockRejectedValue(new Error("network down"));
    render(
      <PlaceOrAddressField
        value={{
          kind: "place",
          place: {
            placeId: PLACE_A,
            name: "Plaza Mariachi",
            formattedAddress: null,
            city: null,
            region: null,
            lat: null,
            lng: null,
            timezone: null,
            status: "ACTIVE",
            verificationStatus: "UNVERIFIED",
          },
        }}
        onPickPlace={vi.fn()}
        onPickAddress={vi.fn()}
        onClear={vi.fn()}
        archivedName="Plaza Mariachi"
      />,
    );
    const title = cc("pfArchivedTitle", { name: "Plaza Mariachi" });
    expect(screen.getByText(title)).toBeInTheDocument();

    // The check fails: "Edit place" shows its error in the archived one's slot.
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    expect(await screen.findByText(cc("pfEditabilityFailed"))).toBeInTheDocument();
    expect(screen.queryByText(title)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: cc("pfDismiss") }));
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it("an address value never shows the archived notice", () => {
    render(
      <PlaceOrAddressField
        value={null}
        onPickPlace={vi.fn()}
        onPickAddress={vi.fn()}
        onClear={vi.fn()}
        archivedName="Plaza Mariachi"
      />,
    );
    expect(
      screen.queryByText(cc("pfArchivedTitle", { name: "Plaza Mariachi" })),
    ).toBeNull();
  });

  it("an unknown reason on a live place degrades to generic copy", async () => {
    m.editability.mockResolvedValue({
      placeId: PLACE_A,
      status: "SUSPENDED",
      canEdit: false,
      canArchive: false,
      canRestore: false,
      reason: "SOMETHING_NEW",
      linkedListingCount: 0,
    });
    renderField({
      kind: "place",
      place: {
        placeId: PLACE_A,
        name: "Plaza Mariachi",
        formattedAddress: null,
        city: null,
        region: null,
        lat: null,
        lng: null,
        timezone: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    expect(
      await screen.findByText(cc("pfRefusedNotActiveTitle")),
    ).toBeInTheDocument();
  });

  it("PLACE_ALREADY_EXISTS shows the existing place, and Use this place selects it", async () => {
    const existing = {
      placeId: PLACE_B,
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
    m.createPlace.mockRejectedValue(
      Object.assign(new Error("a place with this name already exists here"), {
        data: {
          appCode: "PLACE_ALREADY_EXISTS",
          meta: { existingPlace: existing },
        },
      }),
    );
    const { onPickPlace } = renderField({
      kind: "address",
      address: {
        formatted: "Corner Bar, 2190 Nolensville Pike, Nashville, TN 37211",
        line1: "2190 Nolensville Pike",
        poiName: "Corner Bar",
        city: "Nashville",
        region: "TN",
        postalCode: "37211",
        countryCode: "US",
        lat: 36.12,
        lng: -86.74,
      },
    });
    fireEvent.click(screen.getByTestId("place-or-address-make-place"));
    const dialog = await screen.findByRole("dialog");
    // "Make this a place": the business name fills Name, the address is set.
    expect(
      (within(dialog).getByTestId("place-dialog-name") as HTMLInputElement)
        .value,
    ).toBe("Corner Bar");
    fireEvent.change(within(dialog).getByTestId("place-dialog-unit"), {
      target: { value: "Unit A" },
    });
    fireEvent.click(within(dialog).getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.createPlace).toHaveBeenCalledTimes(1));
    expect(m.createPlace.mock.calls[0]![0]).toMatchObject({
      name: "Corner Bar",
      address: {
        // The unit goes on its own; the server folds it into the text.
        formatted: "Corner Bar, 2190 Nolensville Pike, Nashville, TN 37211",
        line1: "2190 Nolensville Pike",
        line2: "Unit A",
        countryCode: "US",
        lat: 36.12,
        lng: -86.74,
      },
    });
    expect(
      (m.createPlace.mock.calls[0]![0] as { clientKey: string }).clientKey
        .length,
    ).toBeGreaterThanOrEqual(8);

    expect(
      await screen.findByText(cc("pdExistsTitle", { name: "Corner Bar South" })),
    ).toBeInTheDocument();
    expect(screen.getByText(existing.formattedAddress)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("place-dialog-use-existing"));
    expect(onPickPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: PLACE_B, name: "Corner Bar South" }),
    );
  });

  it("an unknown failure keeps the key for a retry; a changed name gets a new one", async () => {
    m.createPlace.mockRejectedValue(new Error("The connection dropped."));
    renderField();
    await type("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-or-address-add"));
    const dialog = await screen.findByRole("dialog");
    // Give it an address so the submit reaches the server.
    const hit = geoHit("Corner Bar", "2190 Nolensville Pike");
    m.forwardGeocode.mockResolvedValue([hit]);
    fireEvent.change(within(dialog).getByTestId("place-dialog-address-input"), {
      target: { value: "2190 Nolensville" },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    fireEvent.click(await within(dialog).findByText("Corner Bar"));

    const keyOf = (n: number) =>
      (m.createPlace.mock.calls[n]![0] as { clientKey: string }).clientKey;
    fireEvent.click(within(dialog).getByTestId("place-dialog-submit"));
    await waitFor(() => expect(m.createPlace).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByTestId("place-dialog-submit"));
    await waitFor(() => expect(m.createPlace).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));

    fireEvent.change(within(dialog).getByTestId("place-dialog-name"), {
      target: { value: "Corner Bar Back Room" },
    });
    m.createPlace.mockRejectedValue(
      Object.assign(new Error("key reused"), {
        data: { appCode: "IDEMPOTENCY_KEY_CONFLICT" },
      }),
    );
    fireEvent.click(within(dialog).getByTestId("place-dialog-submit"));
    await waitFor(() => expect(m.createPlace).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(await within(dialog).findByText(cc("pdErrMaybeAdded"))).toBeInTheDocument();
  });

  it("archive refused for live listings on an archive-only dialog stays on the confirm step", async () => {
    m.editability.mockResolvedValue({
      placeId: PLACE_A,
      status: "ACTIVE",
      canEdit: false,
      canArchive: true,
      canRestore: false,
      reason: "ADDRESS_WITHHELD",
      linkedListingCount: 0,
    });
    m.archivePlace.mockRejectedValue(
      Object.assign(new Error("live listings"), {
        data: {
          appCode: "PLACE_HAS_LIVE_LISTINGS",
          meta: { linkedListingCount: 2 },
        },
      }),
    );
    renderField({
      kind: "place",
      place: {
        placeId: PLACE_A,
        name: "Plaza Mariachi",
        formattedAddress: null,
        city: null,
        region: null,
        lat: null,
        lng: null,
        timezone: null,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
      },
    });
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    fireEvent.click(await screen.findByTestId("place-or-address-notice-archive"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByTestId("place-dialog-archive-confirm-btn"));

    expect(
      await within(dialog).findByTestId("place-dialog-notice"),
    ).toHaveTextContent(/upcoming listing/);
    expect(within(dialog).queryByTestId("place-dialog-name")).toBeNull();
    expect(within(dialog).getByTestId("place-dialog-archive-confirm")).toBeInTheDocument();
  });
});

describe("PlaceOrAddressField — names and focus", () => {
  function Harness({ initial = null }: { initial?: Value }) {
    const [value, setValue] = React.useState<Value>(initial);
    return (
      <>
        <span id="loc-label">Location</span>
        <PlaceOrAddressField
          value={value}
          inputId="loc-input"
          labelledBy="loc-label"
          onPickPlace={(place) => setValue({ kind: "place", place })}
          onPickAddress={(address) => setValue({ kind: "address", address })}
          onClear={() => setValue(null)}
        />
      </>
    );
  }

  it("the combobox and its listbox are named by the visible label", async () => {
    m.forwardGeocode.mockResolvedValue([geoHit("Corner Bar", "2190 Nolensville Pike")]);
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveAttribute("id", "loc-input");
    await type("2190 Nolensville");
    expect(screen.getByRole("listbox", { name: "Location" })).toBeInTheDocument();
  });

  it("after a pick, focus lands on the card's control, not <body>", async () => {
    m.forwardGeocode.mockResolvedValue([geoHit("Corner Bar", "2190 Nolensville Pike")]);
    render(<Harness />);
    const input = await type("2190 Nolensville");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("place-or-address-make-place"),
      ),
    );
  });

  it("Escape with nothing showing is left for the surrounding sheet", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === "Escape" && outer()}>
        <Harness />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  const SELECTED: Value = {
    kind: "place",
    place: {
      placeId: PLACE_A,
      name: "Plaza Mariachi",
      formattedAddress: "3955 Nolensville Pike",
      city: "Nashville",
      region: "TN",
      lat: 1,
      lng: 2,
      timezone: null,
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
    },
  };

  it("a place already selected on mount takes no focus", async () => {
    render(<Harness initial={SELECTED} />);
    // Past the rAF the focus effect would use.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("Edit while the check is pending: one fetch, marked aria-disabled", async () => {
    let release!: (v: unknown) => void;
    m.editability.mockReturnValue(new Promise((r) => (release = r)));
    render(<Harness initial={SELECTED} />);
    const edit = screen.getByTestId("place-or-address-edit-place");
    fireEvent.click(edit);
    fireEvent.click(edit);
    await waitFor(() => expect(edit).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(edit);
    expect(m.editability).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({
        placeId: PLACE_A,
        status: "ACTIVE",
        canEdit: true,
        canArchive: true,
        canRestore: false,
        reason: null,
        linkedListingCount: 0,
      });
      await Promise.resolve();
    });
  });

  it("Edit, then Clear before the check returns: no dialog over the empty field", async () => {
    let release!: (v: unknown) => void;
    m.editability.mockReturnValue(new Promise((r) => (release = r)));
    m.getPlacePublic.mockReturnValue(new Promise(() => undefined));
    render(<Harness initial={SELECTED} />);
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    await waitFor(() => expect(m.editability).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("place-or-address-clear"));
    await act(async () => {
      release({
        placeId: PLACE_A,
        status: "ACTIVE",
        canEdit: true,
        canArchive: true,
        canRestore: false,
        reason: null,
        linkedListingCount: 0,
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("Edit with no second factor, then Clear before the refetch returns: no notice", async () => {
    m.moderator = { allowed: true, secondFactorEnrolled: false };
    let release!: (v: unknown) => void;
    m.refetch.mockReturnValue(new Promise((r) => (release = r)));
    m.getPlacePublic.mockReturnValue(new Promise(() => undefined));
    render(<Harness initial={SELECTED} />);
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    await waitFor(() => expect(m.refetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("place-or-address-clear"));
    await act(async () => {
      release({ data: m.moderator });
      await new Promise((r) => setTimeout(r, 0));
    });
    // The notice assertion pins the stale branch; "editability not called"
    // holds either way (no second factor stops both old and new code).
    expect(screen.queryByTestId("place-second-factor-link")).toBeNull();
    expect(m.editability).not.toHaveBeenCalled();
  });

  it("Edit with no second factor and no Clear: the notice shows", async () => {
    m.moderator = { allowed: true, secondFactorEnrolled: false };
    render(<Harness initial={SELECTED} />);
    fireEvent.click(screen.getByTestId("place-or-address-edit-place"));
    expect(
      await screen.findByTestId("place-second-factor-link"),
    ).toBeInTheDocument();
    expect(m.editability).not.toHaveBeenCalled();
  });
});

describe("PlaceOrAddressField — rows belong to the query in the box", () => {
  it("the last query's address rows vanish while the new lookup runs", async () => {
    m.forwardGeocode.mockResolvedValueOnce([
      geoHit("Steadfast South", "2190 Nolensville Pike"),
    ]);
    renderField();
    await type("2190 Nolensville");
    expect(screen.getByText("Steadfast South")).toBeInTheDocument();

    let release!: (v: unknown) => void;
    m.forwardGeocode.mockReturnValueOnce(new Promise((r) => (release = r)));
    await type("Corner Bar Nashville TN");

    expect(screen.queryByText("Steadfast South")).toBeNull();
    expect(screen.queryByTestId("place-or-address-group-addresses")).toBeNull();
    expect(screen.getByText(cc("pfSearching"))).toBeInTheDocument();
    // Only the tail is selectable meanwhile.
    expect(optionTexts()).toEqual([cc("pfAddPlace")]);

    await act(async () => {
      release([geoHit("Corner Bar", "1 Main St")]);
      await Promise.resolve();
    });
    expect(await screen.findByText("Corner Bar")).toBeInTheDocument();
    expect(screen.queryByText("Steadfast South")).toBeNull();
  });

  it("place rows kept from the last key (placeholder data) are not shown", async () => {
    const oldHits = [placeHit(PLACE_A, "Plaza Mariachi", "3955 Nolensville Pike")];
    m.autocomplete.mockImplementation(
      (input: { query: string }, opts: { enabled: boolean }) =>
        input.query === "Plaza"
          ? {
              data: opts.enabled ? { suggestions: oldHits } : undefined,
              isFetching: false,
              isError: false,
              isPlaceholderData: false,
            }
          : {
              // keepPreviousData: the old key's rows, still loading the new.
              data: { suggestions: oldHits },
              isFetching: true,
              isError: false,
              isPlaceholderData: true,
            },
    );
    renderField();
    await type("Plaza");
    expect(screen.getByText("Plaza Mariachi")).toBeInTheDocument();

    await type("Corner Bar");
    expect(screen.queryByText("Plaza Mariachi")).toBeNull();
    expect(screen.queryByTestId(`place-or-address-place-${PLACE_A}`)).toBeNull();
  });

  it("an arrowed-to row does not slide onto a different one when results arrive", async () => {
    let release!: (v: unknown) => void;
    m.forwardGeocode.mockReturnValueOnce(new Promise((r) => (release = r)));
    renderField();
    const input = await type("Corner Bar");
    // Loading: only the tail exists; arrow onto it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "place-or-address-option-0");

    await act(async () => {
      release([geoHit("Corner Bar", "1 Main St")]);
      await Promise.resolve();
    });
    await screen.findByText("Corner Bar");
    // Index 0 is now an address row; the highlight is dropped, not moved.
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("place-or-address-selected")).toBeNull();
  });
});

