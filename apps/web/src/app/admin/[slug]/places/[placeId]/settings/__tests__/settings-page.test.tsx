import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import AdminPlaceSettingsPage from "../page";
import { useRegisterPageSettingsSave } from "@/components/entity-pages/page-settings-save";

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

// The venue settings page (FR-401). This suite MOVED here from
// `edit/__tests__/edit-page.test.tsx` together with the state and save it
// covers: every data-loss case below (coordinates re-sent, legacy formatted
// address preserved, `||` in the address check, the save latch) runs against
// the merged page UNCHANGED. What changed is only what the old details form
// had and this page does not (the 296px aside, the verification modal) and
// what this page adds (inline verification, one Save across the place AND the
// Public page forms, the never-reseed-over-a-draft guard).
//
// Plain-DOM stand-ins, same technique as ../__tests__/place-detail-layout.
// The child sections with their own suites (Verification, Public page,
// Reviews, the index, the chips) are stubbed to props-recorders here; the
// ones whose markup these cases read (Identity, Location, Ownership) are real.

/** The three fields the page destructures off `getPlaceForEdit.useQuery()`. */
type PlaceQueryResult = {
  data?: { place: unknown };
  isLoading: boolean;
  error?: { data?: { code?: string }; message?: string } | null;
  /** Moves on every successful fetch, even when structural sharing keeps `data`. */
  dataUpdatedAt?: number;
};

const mockedGetPlaceForEditQuery = vi.fn<unknown[], PlaceQueryResult>(() => ({
  data: undefined,
  isLoading: true,
  error: null,
}));

// Hoisted so a single fn instance survives every re-render of the page (a
// `useMutation: () => ({ mutateAsync: vi.fn() })` factory mints a NEW spy on
// every render, so call counts are unobservable).
const mocks = vi.hoisted(() => ({
  upsertMutateAsync: vi.fn((_input: Record<string, unknown>) =>
    Promise.resolve({ placeId: "p" }),
  ),
  forwardGeocode: vi.fn((_query: string) =>
    Promise.resolve([] as { lat: number; lng: number }[]),
  ),
  autocompleteAddress: vi.fn(() => Promise.resolve([])),
  // The post-success half of the latch is only observable if this is
  // controllable: the latch must stay held until the refetch lands.
  invalidatePlace: vi.fn(() => Promise.resolve()),
  invalidateArrivalAreas: vi.fn(() => Promise.resolve()),
  // What the stubbed Public page section registers with the page's
  // PageSettingsSaveProvider — i.e. the Profile/Theme forms' save contract.
  pageForm: {
    isDirty: false,
    isPending: false,
    blocked: false,
    save: vi.fn(() => Promise.resolve()),
  },
  toastDanger: vi.fn(),
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Real anchors, so "linked vs unlinked owner" is assertable via
// `closest("a")` instead of a stand-in that renders both the same way.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) => (
    <a
      href={href}
      className={rest.className as string | undefined}
      data-testid={rest["data-testid"] as string | undefined}
    >
      {children}
    </a>
  ),
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
    useTheme: () => ({
      danger: { val: "#B93312" },
      warning: { val: "#F59E0B" },
    }),
  };
});

vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return {
    ...actual,
    useTranslations: () => (key: string) => key,
    useNotify: () => ({
      toast: {
        success: vi.fn(),
        warning: vi.fn(),
        danger: mocks.toastDanger,
        info: vi.fn(),
      },
    }),
    // Forwards `data-testid`/`id` the way the real Tamagui Paragraph does. A
    // stand-in that swallows DOM attributes makes any assertion that depends
    // on them unwritable — and quietly hides the case where the real component
    // drops them too.
    Text: ({
      children,
      ...rest
    }: { children?: React.ReactNode } & Record<string, unknown>) => (
      <span
        data-testid={rest["data-testid"] as string | undefined}
        id={rest.id as string | undefined}
      >
        {children}
      </span>
    ),
    // `data-tone` is FORWARDED, not swallowed. The tone is the whole
    // semantic content of a badge — a stand-in that drops it lets
    // `badgeToneForVerification` / `getStatusBadgeTone` map SUSPENDED to
    // "success" with every status assertion still green.
    Badge: ({
      children,
      tone,
    }: {
      children?: React.ReactNode;
      tone?: string;
    }) => <span data-tone={tone}>{children}</span>,
    Spinner: () => <div data-testid="spinner" />,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    } & Record<string, unknown>) => (
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        data-testid={rest["data-testid"] as string | undefined}
      >
        {children}
      </button>
    ),
    TextInput: ({
      value,
      onChangeText,
      placeholder,
    }: {
      value?: string;
      onChangeText?: (v: string) => void;
      placeholder?: string;
    }) => (
      <input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlaceForEdit: { invalidate: mocks.invalidatePlace },
        listHumanPlaces: { invalidate: vi.fn() },
      },
      arrivalAreas: {
        listForEditor: { invalidate: mocks.invalidateArrivalAreas },
      },
    }),
    places: {
      getPlaceForEdit: {
        useQuery: (...args: unknown[]) => mockedGetPlaceForEditQuery(...args),
      },
      upsertPlace: {
        useMutation: () => ({
          mutateAsync: mocks.upsertMutateAsync,
          isPending: false,
        }),
      },
    },
    // The header's page-visibility chip reads the place's public page.
    entityPages: {
      getMyPage: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: mocks.forwardGeocode,
  autocompleteAddress: mocks.autocompleteAddress,
}));

/**
 * The address combobox is stubbed to a single button that fires ONE canned
 * selection. Its own behaviour — debounce, stale-response race, ARIA, keyboard
 * traversal, provider-failure fallback — is covered by
 * `components/maps/__tests__/AddressAutocompleteInput.test.tsx`. What this
 * suite owns is the PAGE's half of the contract: that a selection lands in the
 * structured fields and the coordinates, and that it changes what gets saved.
 */
vi.mock("@/components/maps/AddressAutocompleteInput", () => ({
  AddressAutocompleteInput: ({
    onSelect,
    onRequestManualEntry,
  }: {
    onSelect: (a: Record<string, unknown>) => void;
    onRequestManualEntry?: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelect(SELECTED_ADDRESS)}>
        pick-suggestion
      </button>
      <button type="button" onClick={() => onRequestManualEntry?.()}>
        request-manual-entry
      </button>
    </div>
  ),
}));

/** What the stubbed combobox hands back — a Geoapify hit for a real venue. */
const SELECTED_ADDRESS = {
  line1: "6 Delancey St",
  city: "New York",
  region: "NY",
  postalCode: "10002",
  countryCode: "US",
  formatted: "6 Delancey St, New York, NY 10002, United States",
  lat: 40.7204,
  lng: -73.9938,
};

// ── Child sections with suites of their own, stubbed to props-recorders ──
// What THIS suite owns is what the page hands them.

/** Records a stub's props as JSON so a case can assert on them. */
const propsOf = (testId: string): Record<string, unknown> =>
  JSON.parse(screen.getByTestId(testId).getAttribute("data-props") ?? "{}");

vi.mock("../_components/VerificationSection", () => ({
  VerificationSection: (props: Record<string, unknown>) => (
    <div data-testid="verification-section" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock("../_components/ReviewsSection", () => ({
  ReviewsSection: (props: Record<string, unknown>) => (
    <div data-testid="reviews-section" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock("../_components/SettingsStatusChips", () => ({
  SettingsStatusChips: (props: Record<string, unknown>) => (
    <div data-testid="status-chips" data-props={JSON.stringify(props)} />
  ),
}));

// Getting there (arrival-areas FR-016): the editor is its own component with
// its own tests; here it is a props recorder behind the `arrivalAreas` gate.
const arrivalAreasGate = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/maps/ArrivalAreasEditor", () => ({
  useArrivalAreasEditorEnabled: () => arrivalAreasGate.on,
  ArrivalAreasEditor: (props: Record<string, unknown>) => (
    <div data-testid="arrival-areas-editor" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock("../_components/SettingsSectionIndex", () => ({
  SettingsSectionIndex: (props: Record<string, unknown>) => (
    <nav data-testid="section-index" data-props={JSON.stringify(props)} />
  ),
}));

/**
 * The Public page section's two forms, reduced to their save contract: it
 * registers `mocks.pageForm` with the page's provider exactly as
 * PageFieldsEditor / PageThemeEditor do.
 */
vi.mock("../_components/PublicPageSection", () => ({
  PublicPageSection: (props: Record<string, unknown>) => {
    useRegisterPageSettingsSave({ id: "profile", ...mocks.pageForm });
    return (
      <div data-testid="public-page-section" data-props={JSON.stringify(props)}>
        {/* The real section's heading carries this id (the index target). */}
        <h3 id={props.headingId as string}>public-page</h3>
      </div>
    );
  },
}));

/** Already-fulfilled thenable so `use(params)` returns synchronously. */
function fulfilledParams(value: { slug: string; placeId: string }) {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
}

/**
 * `act` around a synchronous trigger, then a flushed microtask queue — the
 * page's handlers are async, so the assertions must run after their promise
 * chains settle.
 */
const actAndFlush = async (fn: () => void) => {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
};

const renderPage = () =>
  render(
    <AdminPlaceSettingsPage
      params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
    />,
  );

/**
 * The page's ONE Save, in its header presentation. The pinned bar renders the
 * same button with the same handler and state (CSS shows exactly one of the
 * two at any width — jsdom applies no CSS, so both are in this DOM).
 */
const saveButton = (): HTMLButtonElement =>
  screen.getByTestId("place-settings-save") as HTMLButtonElement;
const clickSave = () => fireEvent.click(saveButton());

const PLACE_FIXTURE = {
  formattedAddress: "123 Main St, Nashville, TN, 37203, US",
  placeId: PLACE_ID,
  name: "The Basement",
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "Nashville",
  region: "TN",
  postalCode: "37203",
  countryCode: "US",
  capacity: 150,
  phone: "+16155551234",
  website: "https://basement.example",
  status: "ACTIVE",
  listedInDirectory: true,
  verificationStatus: "UNVERIFIED",
  lat: 36.1408,
  lng: -86.7782,
  // ADDRESS PRIVACY (place-address-withholding). Owner-gated and therefore
  // unredacted on this read — the owner is the one editing it.
  locationMode: "EXACT" as string | undefined,
  locationRadiusMeters: null as number | null | undefined,
  locationLabel: null as string | null | undefined,
  access: { orgIds: ["org-1"], humanIds: [] },
  // `access` resolved to display rows by getPlaceForEdit. ORGANIZATION
  // entries first, then HUMAN; `pageSlug` is null when the owner has no
  // PUBLIC entity page, and the whole array degrades to [] when the
  // (best-effort) lookup fails.
  owners: [
    {
      kind: "ORGANIZATION",
      id: "org-1",
      name: "Basement Collective",
      pageSlug: "basement-collective",
    },
  ] as Array<{
    kind: "ORGANIZATION" | "HUMAN";
    id: string;
    name: string;
    pageSlug: string | null;
  }>,
};

describe("AdminPlaceSettingsPage (FR-401; moved from /edit)", () => {
  beforeEach(() => {
    mockedGetPlaceForEditQuery.mockReset();
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    mocks.upsertMutateAsync.mockClear();
    mocks.upsertMutateAsync.mockResolvedValue({ placeId: PLACE_ID });
    mocks.forwardGeocode.mockClear();
    mocks.forwardGeocode.mockResolvedValue([]);
    mocks.invalidatePlace.mockClear();
    mocks.invalidatePlace.mockResolvedValue(undefined);
    mocks.pageForm.isDirty = false;
    mocks.pageForm.isPending = false;
    mocks.pageForm.blocked = false;
    mocks.pageForm.save.mockClear();
    mocks.pageForm.save.mockResolvedValue(undefined);
    mocks.toastDanger.mockClear();
  });

  const renderLoaded = (place: typeof PLACE_FIXTURE = PLACE_FIXTURE) => {
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: { place },
      isLoading: false,
      error: null,
    });
    return renderPage();
  };

  it("renders the loading state while the place loads", () => {
    renderPage();
    expect(screen.getByText("admin.placeEditLoading")).toBeInTheDocument();
  });

  it("renders the settings page: heading, all six sections EXPANDED, seeded fields", () => {
    renderLoaded();

    expect(screen.getByText("admin.placeSettingsHeading")).toBeInTheDocument();
    expect(screen.getByDisplayValue("The Basement")).toBeInTheDocument();
    // Option A "open stack": every section is rendered — nothing sits behind
    // a disclosure.
    for (const key of [
      "admin.placeEditSectionIdentity",
      "admin.placeEditSectionLocation",
      "admin.placeSettingsSectionVerification",
      "admin.placeSettingsSectionReviews",
      "admin.placeSettingsSectionOwnership",
    ]) {
      expect(screen.getByText(key), key).toBeInTheDocument();
    }
    expect(screen.getByTestId("public-page-section")).toBeInTheDocument();
    // Capacity & contact FOLDED INTO Identity (the board): the fields are all
    // here, the separate panel heading is not.
    expect(screen.getByText("admin.placeEditPhoneLabel")).toBeInTheDocument();
    expect(screen.getByText("admin.placeEditWebsiteLabel")).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeEditCapacityLabel"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.placeEditSectionCapacityContact"),
    ).toBeNull();
  });

  it("gives the section index the six sections, in board order, by heading id", () => {
    renderLoaded();
    const { items } = propsOf("section-index") as {
      items: Array<{ targetId: string; label: string }>;
    };
    expect(items.map((i) => i.targetId)).toEqual([
      "identity",
      "location",
      "verification",
      "public-page",
      "reviews",
      "ownership",
    ]);
    // Every target exists on the page (a jump to a missing id goes nowhere).
    for (const { targetId } of items) {
      expect(document.getElementById(targetId), targetId).not.toBeNull();
    }
  });

  it("with the arrivalAreas gate on, mounts Getting there under Location", () => {
    arrivalAreasGate.on = true;
    try {
      renderLoaded();
      const { items } = propsOf("section-index") as {
        items: Array<{ targetId: string; label: string }>;
      };
      expect(items.map((i) => i.targetId).slice(0, 3)).toEqual([
        "identity",
        "location",
        "getting-there",
      ]);
      expect(document.getElementById("getting-there")).not.toBeNull();
      expect(propsOf("arrival-areas-editor")).toEqual({
        parent: { placeId: PLACE_ID },
        formHeadingLevel: 4,
      });
    } finally {
      arrivalAreasGate.on = false;
    }
  });

  it("with the gate on, a save refreshes Getting there (its pin and 3 km flags come from the list)", async () => {
    arrivalAreasGate.on = true;
    mocks.invalidateArrivalAreas.mockClear();
    try {
      renderLoaded();
      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      await actAndFlush(clickSave);
      expect(mocks.invalidateArrivalAreas).toHaveBeenCalledWith({ placeId: PLACE_ID });
    } finally {
      arrivalAreasGate.on = false;
    }
  });

  it("with the gate off, has no Getting there section", () => {
    renderLoaded();
    expect(screen.queryByTestId("arrival-areas-editor")).toBeNull();
    expect(document.getElementById("getting-there")).toBeNull();
  });

  it("renders the ONE Save in its two presentations, sharing one state", () => {
    renderLoaded();

    // Header (two-column widths) + pinned bar (one column); globals.css
    // displays exactly one, so the page never exposes two at once. Both are
    // the same control: same label, same disabled state, same handler.
    const header = screen.getByTestId("place-settings-save");
    const bar = screen.getByTestId("place-settings-save-bar");
    expect(header.closest(".th-place-settings-header-save")).not.toBeNull();
    expect(bar.closest(".th-place-settings-savebar")).not.toBeNull();
    expect(header).toBeDisabled();
    expect(bar).toBeDisabled();
    expect(screen.queryByText("pageActions.save")).toBeNull();
  });

  it("renders the verification WORKFLOW inline, handed the live form and its dirt", () => {
    renderLoaded();

    // The full VerificationSection, embedded — not a summary pointing at a
    // second route. Its submit stays its own: it gets `isDirty` so it can
    // refuse (and say "save first") until the draft is saved.
    expect(propsOf("verification-section")).toMatchObject({
      embedded: true,
      isDirty: false,
      placeId: PLACE_ID,
      formState: {
        name: "The Basement",
        addressLine1: "123 Main St",
        city: "Nashville",
        countryCode: "US",
      },
    });

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "The Basement Annex" },
      });
    });

    expect(propsOf("verification-section")).toMatchObject({
      isDirty: true,
      formState: { name: "The Basement Annex" },
    });
  });

  it("mounts the review controls — performer switch included — with the fail-closed authority", () => {
    renderLoaded({
      ...PLACE_FIXTURE,
      attendeeReviewsPublic: true,
      communityReviewsEnabled: false,
      viewerCanManageSwitches: true,
    } as unknown as typeof PLACE_FIXTURE);
    expect(propsOf("reviews-section")).toMatchObject({
      placeId: PLACE_ID,
      attendeeReviewsPublic: true,
      communityReviewsEnabled: false,
      canManage: true,
      embedded: true,
    });
  });

  it("locks the review switches when the payload does not carry the authority flag", () => {
    renderLoaded();
    expect(propsOf("reviews-section")).toMatchObject({ canManage: false });
  });

  // ── Save affordance ─────────────────────────────────────────────────────

  it("enables Save only while the form is dirty", () => {
    renderLoaded();

    expect(saveButton()).toBeDisabled();

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "The Basement Annex" },
      });
    });

    expect(saveButton()).not.toBeDisabled();
  });

  it("saves the edited values when Save is pressed", async () => {
    renderLoaded();

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "The Basement Annex" },
      });
    });

    await actAndFlush(clickSave);

    expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      placeId: PLACE_ID,
      name: "The Basement Annex",
    });
  });

  // ── Address privacy (place-address-withholding) ─────────────────────────
  //
  // The venue's own settings form already owns every address field this
  // setting governs, which is why the control lives here rather than on
  // `/page` (the public profile), `/calendars` or `/bookings`.

  it("seeds the privacy control from the stored triple", async () => {
    renderLoaded({
      ...PLACE_FIXTURE,
      locationMode: "OBSCURED",
      locationRadiusMeters: 1200,
      locationLabel: "East Nashville",
    });

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    // exact / area / hidden, in that order.
    expect(radios[1]!.checked).toBe(true);
    expect(screen.getByDisplayValue("East Nashville")).toBeInTheDocument();
  });

  it("seeds WITHHELD when the stored mode is unreadable (fail closed)", async () => {
    // A row from a repo/fake that predates the column. The editor must not
    // show an owner "Exact address" for a venue whose state it cannot
    // determine — their next save would then make that true.
    renderLoaded({
      ...PLACE_FIXTURE,
      locationMode: undefined,
      locationRadiusMeters: undefined,
    });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[2]!.checked).toBe(true);
  });

  it("sends the whole privacy triple on save, always", async () => {
    // Never conditionally: OMITTED means "preserve" on these fields and an
    // explicit null radius means "fully hidden", so a partial payload makes
    // the two indistinguishable at the call site.
    renderLoaded({
      ...PLACE_FIXTURE,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      locationLabel: null,
    });

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "The Basement Annex" },
      });
    });
    await actAndFlush(clickSave);

    expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      locationLabel: null,
    });
  });

  it("arms Save when only the privacy choice changed", async () => {
    renderLoaded({
      ...PLACE_FIXTURE,
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
    });
    expect(saveButton()).toBeDisabled();

    act(() => {
      fireEvent.click(screen.getAllByRole("radio")[2]!);
    });

    expect(saveButton()).not.toBeDisabled();

    await actAndFlush(clickSave);
    expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });
  });

  it("does NOT save from a pristine form", async () => {
    renderLoaded();

    await actAndFlush(clickSave);

    expect(mocks.upsertMutateAsync).not.toHaveBeenCalled();
  });

  // ── Double-submit latch ─────────────────────────────────────────────────

  it("runs ONE save when both controls fire while forwardGeocode is in flight", async () => {
    // `upsertMutation.isPending` only flips after the geocode round-trip
    // resolves, so during it both the inline button and the dock CTA are still
    // armed. Without the in-flight ref latch this produced two geocodes and two
    // upserts with two different clientKeys — idempotency deduped neither.
    let releaseGeocode: (() => void) | undefined;
    mocks.forwardGeocode.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseGeocode = () => resolve([]);
        }),
    );

    renderLoaded();

    act(() => {
      fireEvent.change(screen.getByDisplayValue("123 Main St"), {
        target: { value: "500 Broadway" },
      });
    });

    // First press: the header Save.
    act(() => {
      clickSave();
    });
    expect(mocks.forwardGeocode).toHaveBeenCalledTimes(1);

    // Second press mid-flight: the pinned bar's presentation of the same Save
    // (the old dock CTA's role — a second control wired to the same handler).
    act(() => {
      fireEvent.click(screen.getByTestId("place-settings-save-bar"));
    });

    await actAndFlush(() => releaseGeocode?.());

    expect(mocks.forwardGeocode).toHaveBeenCalledTimes(1);
    expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a save settles (the latch is not one-shot)", async () => {
    renderLoaded();

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "Annex One" },
      });
    });
    await actAndFlush(clickSave);

    act(() => {
      fireEvent.change(screen.getByDisplayValue("Annex One"), {
        target: { value: "Annex Two" },
      });
    });
    await actAndFlush(clickSave);

    expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(2);
  });

  it("holds the latch through the post-save refetch window", async () => {
    // The second double-fire window, one step after the geocode one:
    // `mutateAsync` has resolved (so `isPending` is false again) but `isDirty`
    // still compares the form to STALE query data, so both Save controls are
    // armed until the invalidated query round-trips and reseeds the form.
    // Releasing the latch before that re-opens the duplicate-upsert hole.
    let releaseRefetch: (() => void) | undefined;
    mocks.invalidatePlace.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRefetch = () => resolve();
        }),
    );

    renderLoaded();

    act(() => {
      fireEvent.change(screen.getByDisplayValue("The Basement"), {
        target: { value: "The Basement Annex" },
      });
    });

    await actAndFlush(clickSave);
    expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.invalidatePlace).toHaveBeenCalledTimes(1);

    // Refetch still outstanding — a second press must find the latch held.
    await actAndFlush(clickSave);
    act(() => {
      fireEvent.click(screen.getByTestId("place-settings-save-bar"));
    });
    expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);

    await actAndFlush(() => releaseRefetch?.());
  });

  // ── Address autocomplete (FR-016/FR-017) ────────────────────────────────

  describe("address autocomplete", () => {
    /** A place with no address at all — the case "TBD" used to be forged for. */
    const ADDRESSLESS = {
      ...PLACE_FIXTURE,
      formattedAddress: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      lat: null,
      lng: null,
    } as unknown as typeof PLACE_FIXTURE;

    it("fills every structured field AND the coordinates at SELECTION time", () => {
      renderLoaded();

      // Pre-selection: the seeded values, and the seeded coordinates.
      expect(screen.getByDisplayValue("123 Main St")).toBeInTheDocument();
      expect(screen.getByTestId("place-edit-coordinates")).toHaveTextContent(
        "36.140800, -86.778200",
      );

      act(() => {
        fireEvent.click(screen.getByText("pick-suggestion"));
      });

      // No save, no round-trip — the form already shows the resolved address.
      expect(mocks.upsertMutateAsync).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue("6 Delancey St")).toBeInTheDocument();
      expect(screen.getByDisplayValue("New York")).toBeInTheDocument();
      expect(screen.getByDisplayValue("NY")).toBeInTheDocument();
      expect(screen.getByDisplayValue("10002")).toBeInTheDocument();
      expect(screen.getByTestId("place-edit-coordinates")).toHaveTextContent(
        "40.720400, -73.993800",
      );
      // And it arms Save.
      expect(saveButton()).not.toBeDisabled();
    });

    it("saves the selection's coordinates WITHOUT a second geocode round-trip", async () => {
      renderLoaded();

      act(() => {
        fireEvent.click(screen.getByText("pick-suggestion"));
      });
      await actAndFlush(clickSave);

      // FR-017: the provider already answered for this exact address.
      expect(mocks.forwardGeocode).not.toHaveBeenCalled();
      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: {
          line1: "6 Delancey St",
          city: "New York",
          region: "NY",
          postalCode: "10002",
          countryCode: "US",
          lat: 40.7204,
          lng: -73.9938,
          formatted: "6 Delancey St, New York, NY, 10002, US",
        },
      });
    });

    it("re-arms the save-time geocode once a selected address is hand-edited", async () => {
      mocks.forwardGeocode.mockResolvedValue([{ lat: 1, lng: 2 }]);
      renderLoaded();

      act(() => {
        fireEvent.click(screen.getByText("pick-suggestion"));
      });
      // Typing into a field invalidates "these coords are for this address".
      act(() => {
        fireEvent.change(screen.getByDisplayValue("6 Delancey St"), {
          target: { value: "8 Delancey St" },
        });
      });

      await actAndFlush(clickSave);

      expect(mocks.forwardGeocode).toHaveBeenCalledTimes(1);
      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: { lat: 1, lng: 2 },
      });
    });

    // ── Manual-entry fallback ─────────────────────────────────────────────

    it("keeps the structured fields visible for a place that already has an address", () => {
      renderLoaded();
      expect(screen.getByDisplayValue("123 Main St")).toBeInTheDocument();
      expect(screen.getByTestId("place-address-fields-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("shows the fields when the street is the EMPTY STRING but a city exists", () => {
      // The `??` trap. `addrLine1: ""` is the convention this codebase already
      // writes for addressless places (seeded "Logan Square DIY"), and
      // `"" ?? place.city` short-circuits to `""`, so an `??` chain reads the
      // place as addressless and collapses a section full of real data. Found
      // by loading the actual page, not by any assertion that existed before.
      renderLoaded({
        ...PLACE_FIXTURE,
        addressLine1: "",
        addressLine2: null,
      } as unknown as typeof PLACE_FIXTURE);

      expect(screen.getByTestId("place-address-fields-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByDisplayValue("Nashville")).toBeInTheDocument();
    });

    it("reveals the fields on demand for an addressless place", () => {
      renderLoaded(ADDRESSLESS);

      const toggle = screen.getByTestId("place-address-fields-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("admin.placeEditCityLabel")).toBeNull();

      act(() => {
        fireEvent.click(toggle);
      });

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("admin.placeEditCityLabel")).toBeInTheDocument();
    });

    it("reveals the fields when the provider tells the user to type it by hand", () => {
      renderLoaded(ADDRESSLESS);

      act(() => {
        fireEvent.click(screen.getByText("request-manual-entry"));
      });

      expect(screen.getByTestId("place-address-fields-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    // ── The "TBD" sentinel (Part A) ───────────────────────────────────────

    it("saves an addressless place WITHOUT forging a street address", async () => {
      renderLoaded(ADDRESSLESS);

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "Riverside Field" },
        });
      });
      await actAndFlush(clickSave);

      const address = (
        mocks.upsertMutateAsync.mock.calls[0]![0] as {
          address: Record<string, unknown>;
        }
      ).address;

      // The whole point: `line1` is simply absent, not "TBD".
      expect(address.line1).toBeUndefined();
      expect(JSON.stringify(address)).not.toContain("TBD");
      // `formatted` still says something — it is required and feeds addressHash.
      expect(address.formatted).toBe("US");
    });

    // ── Coordinate preservation ───────────────────────────────────────────

    it("re-sends the stored coordinates on a save that never touches the address", async () => {
      // The adapter writes `lat: input.geo?.lat ?? null` on update, so omitting
      // geo here NULLS a venue's map pin. Editing a phone number must not cost
      // a venue its coordinates.
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("+16155551234"), {
          target: { value: "+16155559999" },
        });
      });
      await actAndFlush(clickSave);

      expect(mocks.forwardGeocode).not.toHaveBeenCalled();
      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: { lat: 36.1408, lng: -86.7782 },
      });
    });

    it("preserves the legacy formatted address on a save that never touches it", async () => {
      // `Place.address` is a free-text column older than the structured ones,
      // and seeded rows carry a street there that `addrLine1` never got
      // ("713 Congress Ave" with `addrLine1: null`). Rebuilding `formatted`
      // from the parts on every save deleted that street the first time anyone
      // edited an unrelated field — and churned `addressHash`, re-firing the
      // tax-rate and timezone lookups for nothing.
      renderLoaded({
        ...PLACE_FIXTURE,
        addressLine1: null,
        formattedAddress: "713 Congress Ave",
      } as unknown as typeof PLACE_FIXTURE);

      act(() => {
        fireEvent.change(screen.getByDisplayValue("https://basement.example"), {
          target: { value: "https://basement.example/new" },
        });
      });
      await actAndFlush(clickSave);

      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: { formatted: "713 Congress Ave" },
      });
    });

    it("rebuilds the formatted address as soon as an address field changes", async () => {
      renderLoaded({
        ...PLACE_FIXTURE,
        addressLine1: null,
        formattedAddress: "713 Congress Ave",
      } as unknown as typeof PLACE_FIXTURE);

      act(() => {
        fireEvent.click(screen.getByText("pick-suggestion"));
      });
      await actAndFlush(clickSave);

      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: { formatted: "6 Delancey St, New York, NY, 10002, US" },
      });
    });

    it("retains the existing coordinates when a changed address will not geocode", async () => {
      mocks.forwardGeocode.mockResolvedValue([]);
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("123 Main St"), {
          target: { value: "Behind the old mill" },
        });
      });
      await actAndFlush(clickSave);

      // The warning toast promises "coordinates won't be updated" — so they
      // must be retained, not silently erased.
      expect(mocks.upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
        address: { lat: 36.1408, lng: -86.7782 },
      });
    });

    // ── Country-code guard ────────────────────────────────────────────────

    it("blocks the save on a half-typed country code instead of throwing a raw schema error", async () => {
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("US"), {
          target: { value: "U" },
        });
      });
      await actAndFlush(clickSave);

      expect(mocks.upsertMutateAsync).not.toHaveBeenCalled();
      expect(
        screen.getByText("admin.placeEditCountryCodeInvalidMessage"),
      ).toBeInTheDocument();

      // The latch must not be left armed by the rejection — fixing the code
      // and pressing again has to work.
      act(() => {
        fireEvent.change(screen.getByDisplayValue("U"), {
          target: { value: "CA" },
        });
      });
      await actAndFlush(clickSave);
      expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
    });
  });

  // ── Ownership & status (the old aside's regions, now a section) ────────

  describe("ownership", () => {
    it("asks the server for the owner projection", () => {
      // `includeOwners` is opt-in; without it the field comes back undefined
      // and this panel is permanently degraded — a silent failure.
      renderLoaded();
      expect(mockedGetPlaceForEditQuery).toHaveBeenCalled();
      expect(mockedGetPlaceForEditQuery.mock.calls[0]![0]).toMatchObject({
        placeId: PLACE_ID,
        includeOwners: true,
      });
    });

    it("names every owner and links the ones with a public page", () => {
      renderLoaded({
        ...PLACE_FIXTURE,
        access: { orgIds: ["org-1"], humanIds: ["human-1"] },
        owners: [
          {
            kind: "ORGANIZATION",
            id: "org-1",
            name: "Basement Collective",
            pageSlug: "basement-collective",
          },
          {
            kind: "HUMAN",
            id: "human-1",
            name: "Dana Reyes",
            pageSlug: "dana-reyes",
          },
        ],
      } as unknown as typeof PLACE_FIXTURE);

      expect(
        screen.getByText("admin.placeEditOwnersHeading"),
      ).toBeInTheDocument();

      expect(
        screen.getByText("Basement Collective").closest("a"),
      ).toHaveAttribute("href", "/orgs/basement-collective");
      expect(screen.getByText("Dana Reyes").closest("a")).toHaveAttribute(
        "href",
        "/humans/dana-reyes",
      );

      expect(
        screen.getByText("admin.placeEditOwnerKindOrganization"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("admin.placeEditOwnerKindPerson"),
      ).toBeInTheDocument();
    });

    it("renders an owner with NO public page as plain text, not a dead link", () => {
      renderLoaded({
        ...PLACE_FIXTURE,
        owners: [
          {
            kind: "ORGANIZATION",
            id: "org-1",
            name: "Quiet Room LLC",
            pageSlug: null,
          },
        ],
      } as unknown as typeof PLACE_FIXTURE);

      const name = screen.getByText("Quiet Room LLC");
      expect(name).toBeInTheDocument();
      expect(name.closest("a")).toBeNull();
    });

    it("gives an EMPTY array a neutral muted line — not a crash, not a load-failure claim", () => {
      // `owners: []` means the lookup ran and resolved nothing. The ownership
      // gate guarantees an owner id exists, so it is always an anomaly — but
      // it is ALSO what a venue whose owner row has no usable name produces,
      // so the copy must not tell the owner their own data "failed to load".
      renderLoaded({
        ...PLACE_FIXTURE,
        owners: [],
      } as unknown as typeof PLACE_FIXTURE);

      expect(screen.getByTestId("place-edit-owners-empty")).toHaveTextContent(
        "admin.placeEditOwnersNone",
      );
      // The old wording is gone and must not come back.
      expect(screen.queryByText(/OwnersUnavailable/)).toBeNull();
    });

    it("renders NO ownership region at all when the field is absent", () => {
      // `undefined` = the caller never sent `includeOwners`. That says
      // nothing about this venue's owners, so it is a caller bug rather than
      // a user-facing state: omit the region instead of inventing copy for
      // it. The form must be untouched either way.
      const { owners: _dropped, ...withoutOwners } = PLACE_FIXTURE;
      renderLoaded(withoutOwners as unknown as typeof PLACE_FIXTURE);

      expect(screen.queryByTestId("place-edit-owners-empty")).toBeNull();
      expect(screen.queryByText("admin.placeEditOwnersHeading")).toBeNull();
      expect(screen.queryByText("admin.placeEditOwnersNone")).toBeNull();
      expect(screen.getByDisplayValue("The Basement")).toBeInTheDocument();
      // The rest of the section still renders.
      expect(
        screen.getByText("admin.placeEditStatusHeading"),
      ).toBeInTheDocument();
    });
  });

  // ── Status & listing (read-only, no mutations on this surface) ─────────

  describe("status & listing", () => {
    it("groups the venue status and the directory state, with the note", () => {
      renderLoaded();

      expect(
        screen.getByText("admin.placeEditStatusHeading"),
      ).toBeInTheDocument();
      // Tone comes from the SHARED `getStatusBadgeTone`, so the badge cannot
      // drift away from how the Places table colours the same venue.
      expect(screen.getByText("admin.placeEditStatusActive")).toHaveAttribute(
        "data-tone",
        "success",
      );
      expect(
        screen.getByText("admin.placeEditListedBadge"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("admin.placeEditDirectoryNote"),
      ).toBeInTheDocument();
    });

    it("reads the not-listed and non-ACTIVE states too", () => {
      renderLoaded({
        ...PLACE_FIXTURE,
        status: "ARCHIVED",
        listedInDirectory: false,
      } as unknown as typeof PLACE_FIXTURE);

      expect(screen.getByText("admin.placeEditStatusArchived")).toHaveAttribute(
        "data-tone",
        "danger",
      );
      expect(
        screen.getByText("admin.placeEditNotListedBadge"),
      ).toBeInTheDocument();
    });

    it("carries the place id", () => {
      renderLoaded();
      expect(screen.getByTestId("place-edit-place-id")).toBeInTheDocument();
    });
  });

  // ── ONE Save across the place AND the Public page forms ─────────────────

  describe("one Save for the whole page", () => {
    it("arms Save for a Public page edit alone, and commits ONLY that form", async () => {
      mocks.pageForm.isDirty = true;
      renderLoaded();

      expect(saveButton()).not.toBeDisabled();
      await actAndFlush(clickSave);

      expect(mocks.pageForm.save).toHaveBeenCalledTimes(1);
      // A clean place form is skipped, not re-sent.
      expect(mocks.upsertMutateAsync).not.toHaveBeenCalled();
    });

    it("commits the place FIRST, then the page forms, on one press", async () => {
      mocks.pageForm.isDirty = true;
      const order: string[] = [];
      mocks.upsertMutateAsync.mockImplementationOnce(() => {
        order.push("place");
        return Promise.resolve({ placeId: PLACE_ID });
      });
      mocks.pageForm.save.mockImplementationOnce(() => {
        order.push("page");
        return Promise.resolve();
      });
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      await actAndFlush(clickSave);
      await actAndFlush(() => {});

      expect(order).toEqual(["place", "page"]);
    });

    it("still commits the page forms when the place save fails", async () => {
      mocks.pageForm.isDirty = true;
      mocks.upsertMutateAsync.mockRejectedValueOnce(new Error("boom"));
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      await actAndFlush(clickSave);
      await actAndFlush(() => {});

      expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
      expect(mocks.pageForm.save).toHaveBeenCalledTimes(1);
      expect(mocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "place-save-failed" }),
      );
    });

    it("writes NOTHING while a page form is blocked (a taken slug), and says so", async () => {
      mocks.pageForm.isDirty = true;
      mocks.pageForm.blocked = true;
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      await actAndFlush(clickSave);

      expect(mocks.upsertMutateAsync).not.toHaveBeenCalled();
      expect(mocks.pageForm.save).not.toHaveBeenCalled();
      expect(mocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "place-settings-blocked",
          title: "admin.placeSettingsBlockedSaveTitle",
        }),
      );
    });

    it("runs ONE of each when Save is pressed twice while the place save is in flight", async () => {
      mocks.pageForm.isDirty = true;
      let release!: () => void;
      mocks.upsertMutateAsync.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ placeId: PLACE_ID });
          }),
      );
      renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      // Both presentations of the one Save, pressed in the same window.
      await actAndFlush(() => {
        fireEvent.click(screen.getByTestId("place-settings-save"));
        fireEvent.click(screen.getByTestId("place-settings-save-bar"));
      });
      await actAndFlush(() => release());
      await actAndFlush(() => {});

      expect(mocks.upsertMutateAsync).toHaveBeenCalledTimes(1);
      expect(mocks.pageForm.save).toHaveBeenCalledTimes(1);
    });
  });

  // ── NEVER RESEED OVER A DRAFT ───────────────────────────────────────────
  // The review switches, the verification withdraw and the request form all
  // invalidate `getPlaceForEdit`. On `/edit` none of them shared a page with
  // the form; here they do, and a refetch must not eat an unsaved edit.

  describe("refetches that are not this page's own save", () => {
    it("keep an unsaved Identity draft when another control refreshes the place", () => {
      const view = renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });

      // e.g. the attendee-ratings switch flipped: a NEW place object lands.
      mockedGetPlaceForEditQuery.mockReturnValue({
        data: {
          place: { ...PLACE_FIXTURE, attendeeReviewsPublic: true },
        },
        isLoading: false,
        error: null,
      });
      view.rerender(
        <AdminPlaceSettingsPage
          params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
        />,
      );

      expect(screen.getByDisplayValue("The Basement Annex")).toBeInTheDocument();
      expect(screen.queryByDisplayValue("The Basement")).toBeNull();
    });

    it("still reseed a CLEAN form from the fresh row", () => {
      const view = renderLoaded();

      mockedGetPlaceForEditQuery.mockReturnValue({
        data: { place: { ...PLACE_FIXTURE, phone: "+16155550000" } },
        isLoading: false,
        error: null,
      });
      view.rerender(
        <AdminPlaceSettingsPage
          params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
        />,
      );

      expect(screen.getByDisplayValue("+16155550000")).toBeInTheDocument();
    });

    it("DO reseed after this page's own save — the refetch the latch waits for", async () => {
      const view = renderLoaded();

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      // The server normalises the saved name; the refetch carries it back.
      mocks.invalidatePlace.mockImplementationOnce(() => {
        mockedGetPlaceForEditQuery.mockReturnValue({
          data: { place: { ...PLACE_FIXTURE, name: "THE BASEMENT ANNEX" } },
          isLoading: false,
          error: null,
        });
        return Promise.resolve();
      });
      await actAndFlush(clickSave);
      view.rerender(
        <AdminPlaceSettingsPage
          params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
        />,
      );

      expect(screen.getByDisplayValue("THE BASEMENT ANNEX")).toBeInTheDocument();
    });
    it("consume the post-save flag even when the refetch returns IDENTICAL data", async () => {
      // React Query's structural sharing returns the SAME `place` object when
      // a refetch finds nothing changed — here, a save whose only edit (a
      // trailing space) the server trimmed away. Only `dataUpdatedAt` moves.
      // Keyed on `place` alone, the seeding effect never ran, the post-save
      // flag stayed armed, and the NEXT unrelated refetch wiped a newer draft.
      mockedGetPlaceForEditQuery.mockReturnValue({
        data: { place: PLACE_FIXTURE },
        isLoading: false,
        error: null,
        dataUpdatedAt: 1,
      });
      const view = renderPage();
      const rerender = () =>
        view.rerender(
          <AdminPlaceSettingsPage
            params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
          />,
        );

      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement " },
        });
      });
      mocks.invalidatePlace.mockImplementationOnce(() => {
        mockedGetPlaceForEditQuery.mockReturnValue({
          data: { place: PLACE_FIXTURE }, // same reference: nothing changed
          isLoading: false,
          error: null,
          dataUpdatedAt: 2,
        });
        return Promise.resolve();
      });
      await actAndFlush(clickSave);
      rerender();
      // The save's own refetch reseeded the form (the flag was consumed).
      expect(screen.getByDisplayValue("The Basement")).toBeInTheDocument();

      // A NEWER draft, then an unrelated refetch (a review switch flipped).
      act(() => {
        fireEvent.change(screen.getByDisplayValue("The Basement"), {
          target: { value: "The Basement Annex" },
        });
      });
      mockedGetPlaceForEditQuery.mockReturnValue({
        data: { place: { ...PLACE_FIXTURE, attendeeReviewsPublic: true } },
        isLoading: false,
        error: null,
        dataUpdatedAt: 3,
      });
      rerender();

      expect(
        screen.getByDisplayValue("The Basement Annex"),
      ).toBeInTheDocument();
    });
  });

  describe("deep links", () => {
    it("survive a malformed fragment instead of crashing the page", () => {
      window.history.replaceState(null, "", "#%");
      try {
        expect(() => renderLoaded()).not.toThrow();
        expect(screen.getByDisplayValue("The Basement")).toBeInTheDocument();
      } finally {
        window.history.replaceState(null, "", "#");
      }
    });
  });

  it("keeps its own FORBIDDEN card as the residual fallback", () => {
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { data: { code: "FORBIDDEN" }, message: "boom" },
    });

    renderPage();

    expect(screen.getByText("admin.placeEditAccessDenied")).toBeInTheDocument();
  });
});
