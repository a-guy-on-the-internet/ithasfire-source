/**
 * EventBuilder — hydrating a THIRD-PARTY venue's stored placement.
 *
 * The builder seeds the cascade from two reads that land independently:
 * `getEventForEdit` (calendar + space) and `getEventProvenance` (the booking
 * request's INTENT). Under `httpBatchLink` the two mount-time queries share
 * one HTTP batch, so the common case is BOTH landing in the same commit —
 * which is exactly the ordering a "seed the intent later" effect misses if it
 * only fires when the intent changes. This suite pins, at the builder level:
 *
 *   1. both reads on first render → the cascade opens on the STORED intent
 *      (the "Rent a space" radio is checked before any touch), never on a
 *      PERFORM guess;
 *   2. a touch made before provenance lands is NOT overwritten when it does;
 *   3. re-picking the SAME venue keeps the stored placement (mirrors the
 *      timezone no-op) instead of resetting to defaults;
 *   4. while provenance is still pending, the cascade is a skeleton, not live
 *      controls seeded with a guess.
 *
 * MOCKS: the RenderIsolation scaffold, with `BuilderEssentialsSection` replaced
 * by a probe that renders the REAL `VenueBookingCascade` from the placement
 * props the builder hands it, plus two buttons that stand in for the
 * organizer's touch and a same-venue re-pick. `EventProvenanceNote` is stubbed
 * (own suite) — the builder's OWN provenance read is what is under test.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP =
    /^(data-|aria-)|^(id|role|style|title|tabIndex|type|htmlFor|onKeyDown)$/;
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
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [k: string]: unknown;
  }) =>
    React.createElement(
      "span",
      { id: rest.id, "data-testid": rest["data-testid"] },
      children,
    );
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const ModalRoot = ({
    open,
    children,
  }: {
    open: boolean;
    children?: ReactNode;
  }) => (open ? React.createElement("div", null, children) : null);
  const Modal = Object.assign(ModalRoot, {
    Panel: Passthrough,
    Header: () => null,
    Body: Passthrough,
    Footer: Passthrough,
  });
  const noop = vi.fn();
  return {
    Text,
    Badge: Text,
    Spinner: () => null,
    FormErrorBanner: () => null,
    Checkbox: () => null,
    Modal,
    Button: ({
      children,
      onPress,
    }: {
      children?: ReactNode;
      onPress?: () => void;
    }) => React.createElement("button", { onClick: onPress }, children),
    TextInput: () => null,
    Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
    StyledSelect: ({
      value,
      options,
      onChange,
      testId,
      selectId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
      testId?: string;
      selectId?: string;
    }) =>
      React.createElement(
        "select",
        {
          id: selectId,
          "data-testid": testId,
          value,
          onChange: (e: { currentTarget: { value: string } }) =>
            onChange(e.currentTarget.value),
        },
        options.map((o) =>
          React.createElement("option", { key: o.value, value: o.value }, o.label),
        ),
      ),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
    useNotify: () => ({
      toast: {
        info: noop,
        success: noop,
        warning: noop,
        danger: noop,
        neutral: noop,
      },
    }),
  };
});

vi.mock("next/dynamic", () => ({ default: () => () => null }));

// ── Data fixtures (hoisted: the probe and the trpc mock both read them) ───

const { query, mutation, EVENT_FOR_EDIT, IDS, CALENDARS, provenanceRef } =
  vi.hoisted(() => {
    const query = (overrides: Record<string, unknown> = {}) => ({
      data: undefined as unknown,
      isSuccess: false,
      isError: false,
      isLoading: false,
      isPending: false,
      isFetching: false,
      refetch: () => undefined,
      ...overrides,
    });
    const mutation = () => ({
      mutate: () => undefined,
      mutateAsync: () => Promise.resolve({}),
      isPending: false,
    });
    const IDS = {
      PLACE: "00000000-0000-4000-8000-000000000001",
      MAIN: "00000000-0000-4000-8000-0000000000c1",
      SIDE: "00000000-0000-4000-8000-0000000000c2",
      ROOM_A: "00000000-0000-4000-8000-0000000000a1",
      ROOM_B: "00000000-0000-4000-8000-0000000000a2",
      ROOM_S: "00000000-0000-4000-8000-0000000000a3",
      REQUEST: "00000000-0000-4000-8000-0000000000b1",
    };
    const CALENDARS = [
      {
        id: IDS.MAIN,
        name: "Main stage",
        isDefault: true,
        acceptsPerform: true,
        acceptsRent: true,
        acceptsUse: false,
        rentalRateCents: null,
        rentalRateCurrency: null,
        rentalRateVisible: false,
        spaces: [
          { id: IDS.ROOM_A, name: "Room A" },
          { id: IDS.ROOM_B, name: "Room B" },
        ],
      },
      {
        id: IDS.SIDE,
        name: "Side room",
        isDefault: false,
        acceptsPerform: true,
        acceptsRent: true,
        acceptsUse: true,
        rentalRateCents: null,
        rentalRateCurrency: null,
        rentalRateVisible: false,
        spaces: [{ id: IDS.ROOM_S, name: "Side" }],
      },
    ];
    /** A saved event at a third-party venue: RENT / Main stage / Room A. */
    const EVENT_FOR_EDIT = {
      eventId: "evt-1",
      title: "Saved Title",
      status: "DRAFT",
      startsAt: "2026-08-01T20:00:00.000Z",
      endsAt: "2026-08-01T23:00:00.000Z",
      timezone: "America/Chicago",
      currency: "USD",
      slug: "saved-title",
      shortId: null,
      seriesId: null,
      seriesRrule: null,
      seriesUntil: null,
      ticketsSold: 0,
      placeId: IDS.PLACE,
      place: {
        id: IDS.PLACE,
        name: "The Blue Room",
        formattedAddress: "1 Blue St",
        city: "Nashville",
        region: "TN",
        lat: 36.1,
        lng: -86.7,
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
      calendarId: IDS.MAIN,
      spaceId: IDS.ROOM_A,
      placeLayoutId: null,
      content: null,
      heroImageUrl: null,
      addressText: null,
      lat: null,
      lng: null,
      locality: null,
      region: null,
      countryCode: null,
      postalCode: null,
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
      addressRevealPreset: null,
      addressRevealAt: null,
      waiverTemplateId: null,
      instructionalAdmission: false,
      payoutSchedule: null,
      orgId: null,
      humanId: "h-1",
    };
    /** Swapped per test: provenance present on first render, or still pending. */
    const provenanceRef = { current: query({ isPending: true }) };
    return { query, mutation, EVENT_FOR_EDIT, IDS, CALENDARS, provenanceRef };
  });

const provenanceWith = (intent: "PERFORM" | "RENT" | "USE") =>
  query({
    isSuccess: true,
    data: {
      agreement: null,
      bookingRequest: {
        id: IDS.REQUEST,
        status: "PENDING",
        direction: "TO_VENUE",
        senderDisplayName: "Me",
        lastMessageAt: null,
        intent,
        placeId: IDS.PLACE,
        placeName: "The Blue Room",
        parked: false,
      },
      venueConfirmation: {
        state: "unconfirmed",
        ownerSide: "requester",
        placeName: "The Blue Room",
      },
    },
  });

// ── The probe: the real cascade fed by the builder's placement props ─────

vi.mock("../BuilderEssentialsSection", async () => {
  const React = await import("react");
  const { VenueBookingCascade } = await import("../VenueBookingCascade");
  type Placement = {
    placeId: string;
    bookingIntent: "PERFORM" | "RENT" | "USE";
    calendarId: string;
  };
  const Probe = React.memo(function EssentialsProbe(props: {
    title: string;
    onTitleChange: (value: string) => void;
    selectedPlace: { placeId: string } | null;
    placement: Placement | null;
    placementSource: "picked" | "hydrated";
    placementIntentPending?: boolean;
    onPlacementChange: (next: Placement | null) => void;
    onPlaceSelect: (place: unknown) => void;
  }) {
    const {
      title,
      onTitleChange,
      selectedPlace,
      placement,
      placementSource,
      placementIntentPending,
      onPlacementChange,
      onPlaceSelect,
    } = props;
    return React.createElement(
      "div",
      {
        "data-testid": "placement-probe",
        "data-intent": placement?.bookingIntent ?? "",
        "data-calendar": placement?.calendarId ?? "",
        // Whether the seeded placement carries a room AT ALL — it must not:
        // the cascade has no room control, so a hydrated `spaceId` would be
        // submitted invisibly (owner ruling). "" means the key is absent.
        "data-space":
          (placement as { spaceId?: string | null } | null)?.spaceId ?? "",
        "data-source": placementSource,
        "data-intent-pending": placementIntentPending ? "1" : "0",
      },
      React.createElement("input", {
        "data-testid": "event-title",
        value: title,
        onChange: (e: { target: { value: string } }) =>
          onTitleChange(e.target.value),
      }),
      React.createElement(VenueBookingCascade, {
        status: placementIntentPending ? "loading" : "ready",
        calendars: CALENDARS,
        placement,
        onIntentChange: (intent) =>
          placement && onPlacementChange({ ...placement, bookingIntent: intent }),
        onCalendarChange: () => undefined,
      }),
      // The organizer's touch, independent of the cascade's own controls (the
      // skeleton has none while the intent is pending).
      React.createElement("button", {
        "data-testid": "touch-use",
        onClick: () =>
          placement && onPlacementChange({ ...placement, bookingIntent: "USE" }),
      }),
      // A same-venue re-pick: a FRESH item for the place already selected.
      React.createElement("button", {
        "data-testid": "repick-same",
        onClick: () =>
          onPlaceSelect({
            placeId: selectedPlace?.placeId ?? "",
            name: "The Blue Room",
            formattedAddress: "1 Blue St",
            city: "Nashville",
            region: "TN",
            lat: 36.1,
            lng: -86.7,
            timezone: "America/Chicago",
            status: "ACTIVE",
            verificationStatus: "VERIFIED",
          }),
      }),
    );
  });
  return { BuilderEssentialsSection: Probe };
});

vi.mock("../BuilderDetailsSection", () => ({
  BuilderDetailsSection: () => null,
}));
vi.mock("../BuilderSettingsSections", () => ({
  BuilderSettingsSections: () => null,
}));

// ── Heavy child surfaces → cheap stubs ────────────────────────────────────

vi.mock("../EventPreview", () => ({ EventPreview: () => null }));
vi.mock("../SeatingLayoutEditor", () => ({ SeatingLayoutEditor: () => null }));
vi.mock("../ApplicationFormBuilder", () => ({
  ApplicationFormBuilder: () => null,
}));
vi.mock("../TicketTypeEditor", () => ({ TicketTypeEditor: () => null }));
vi.mock("../LineupEditor", () => ({ LineupEditor: () => null }));
vi.mock("../SplitsEditor", () => ({ SplitsEditor: () => null }));
vi.mock("../SeriesEditScopeDialog", () => ({
  SeriesEditScopeDialog: () => null,
}));
vi.mock("../PublishReadinessRail", () => ({
  PublishReadinessRail: () => null,
}));
vi.mock("../BuilderHeaderBar", () => ({ BuilderHeaderBar: () => null }));
vi.mock("../EventProvenanceNote", () => ({ EventProvenanceNote: () => null }));
vi.mock("../BuilderPublishDialogs", () => ({
  HostAttestationDialog: () => null,
  ChargebackTermsDialog: () => null,
}));
vi.mock("../BuilderReconcileDialog", () => ({
  BuilderReconcileDialog: () => null,
}));
vi.mock("../prose-editor", () => ({
  ProseEditor: () => null,
  createEmptyDoc: () => ({ type: "doc", content: [] }),
  hasContent: () => false,
}));
vi.mock("../useEventImageUpload", () => ({
  useEventImageUpload: () => ({ uploadImage: vi.fn(), isUploading: false }),
  MAX_EVENT_IMAGE_BYTES: 10 * 1024 * 1024,
}));
vi.mock("../useEventAudioUpload", () => ({
  useEventAudioUpload: () => ({
    uploadAudio: vi.fn(),
    isUploadingAudio: false,
  }),
}));
vi.mock("../../../_components/ShareEventDialog", () => ({
  ShareEventDialog: () => null,
}));

// ── App-level hooks / chrome ──────────────────────────────────────────────

// EventBuilder routes to the public page after publishing a COMMUNITY
// listing, so it holds a router. Nothing in this file exercises that path —
// the mock exists because `useRouter` throws "app router to be mounted"
// outside a Next app tree, which would fail every test here on mount.
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/acme-co/events/evt-1/edit",
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: {} }),
}));
vi.mock("@/components/errors/QuotaExceededDialog", () => ({
  QuotaExceededDialog: () => null,
}));
vi.mock("@th/core/use-cases/events/host-attestation-text", () => ({
  HOST_ATTESTATION_FIELDS: ["safety"],
  HOST_ATTESTATION_TEXT: { safety: "Keep it safe" },
  HOST_ATTESTATION_VERSION: "v1",
}));

// ── Data layer ────────────────────────────────────────────────────────────

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  const eventForEditResult = query({ data: EVENT_FOR_EDIT, isSuccess: true });
  const ticketTypesResult = query({
    data: { ticketTypes: [] },
    isSuccess: true,
  });
  const gateStateResult = query({
    data: {
      visibility: "PUBLIC",
      gateType: null,
      passwordSet: false,
      waitlistStatus: null,
      waitlistDescription: null,
      waitlistCap: null,
    },
    isSuccess: true,
  });
  const emptyResult = query();
  const audioResult = query({ data: { items: [] }, isSuccess: true });
  const lineupResult = query({ data: [], isSuccess: true });
  const mutationResult = mutation();
  const useMutation = () => mutationResult;
  return {
    trpc: {
      useUtils: () => chain,
      events: {
        getEventForEdit: { useQuery: () => eventForEditResult },
        listTicketTypesForEdit: { useQuery: () => ticketTypesResult },
        getGateState: { useQuery: () => gateStateResult },
        // Read through the ref on EVERY render so a test can let provenance
        // "land" later and re-render the builder.
        getEventProvenance: { useQuery: () => provenanceRef.current },
        resolveImages: { useQuery: () => emptyResult },
        resolveAudio: { useQuery: () => audioResult },
        createEventForHuman: { useMutation },
        createEventForOrg: { useMutation },
        requestImageUpload: { useMutation },
        finalizeImageUpload: { useMutation },
        publishEvent: { useMutation },
        unpublishEvent: { useMutation },
        cancelEvent: { useMutation },
      },
      eventHumans: { list: { useQuery: () => lineupResult } },
      stripeConnect: { getStatus: { useQuery: () => emptyResult } },
      promos: { list: { useQuery: () => emptyResult } },
      platform: { checkStaffAccess: { useQuery: () => emptyResult } },
      series: {
        updateEventSeries: { useMutation },
        reconcileSeriesSchedule: { useMutation },
        convertEventToSeries: { useMutation },
        generateEventsFromSeries: { useMutation },
        syncSeriesDrafts: { useMutation },
      },
      // COMMUNITY mode's save/publish pair. Unused on the owned path these
      // tests cover, but the builder mounts both mutations unconditionally.
      community: {
        updateListing: { useMutation },
        publishListing: { useMutation },
      },
      // ADDRESS PRIVACY (place-address-withholding): the builder reads the
      // selected venue's PUBLIC location projection to decide whether the
      // exact-address option is available. An unresolved query is the
      // fail-closed `checking` state, which is what this stub produces.
      places: { getPlacePublic: { useQuery: () => emptyResult } },
      categories: { list: { useQuery: () => emptyResult } },
      orgs: {
        acceptChargebackTerms: { useMutation },
        getOrg: { useQuery: () => emptyResult },
      },
      humans: {
        acceptMyChargebackTerms: { useMutation },
        getMyProfile: { useQuery: () => emptyResult },
      },
    },
  };
});

import { EventBuilder } from "../EventBuilder";

const renderBuilder = () =>
  render(
    <EventBuilder
      surface="edit"
      ownerType="human"
      ownerId="h-1"
      slug="acme-co"
      eventId="evt-1"
      canEditEvent
    />,
  );

const probe = () => screen.getByTestId("placement-probe");

/** Forces a builder re-render through real state (the title field). */
const rerenderBuilder = () =>
  fireEvent.change(screen.getByTestId("event-title"), {
    target: { value: `Saved Title ${Date.now()}` },
  });

beforeEach(() => {
  provenanceRef.current = query({ isPending: true });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
});

describe("EventBuilder — hydrating a third-party venue's stored placement", () => {
  it("both reads on first render → the cascade opens on the STORED intent: 'Rent a space' is checked before any touch", async () => {
    provenanceRef.current = provenanceWith("RENT");
    renderBuilder();
    await screen.findByTestId("event-title");

    expect(probe()).toHaveAttribute("data-source", "hydrated");
    expect(probe()).toHaveAttribute("data-calendar", IDS.MAIN);
    // The event HAS a stored room (`getEventForEdit` returns ROOM_A above),
    // and the builder deliberately does not carry it: a value the organizer
    // cannot see must never ride along on the next save.
    expect(probe()).toHaveAttribute("data-space", "");
    // Not a PERFORM guess — the request's own intent.
    expect(probe()).toHaveAttribute("data-intent", "RENT");
    expect(probe()).toHaveAttribute("data-intent-pending", "0");
    expect(
      screen.getByRole("radio", { name: "admin.ebIntentRent" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "admin.ebIntentPlay" }),
    ).toHaveAttribute("aria-checked", "false");
    // No room control at all — the venue names the room when it accepts.
    expect(screen.queryByTestId("venue-booking-space")).toBeNull();
    // The calendar's rooms are PRINTED instead, read-only.
    expect(screen.getByTestId("venue-booking-rooms")).toHaveTextContent(
      "admin.ebRooms",
    );
  });

  it("while provenance is still pending the cascade is a skeleton, not live controls seeded with a guess", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    expect(probe()).toHaveAttribute("data-intent-pending", "1");
    expect(screen.getByTestId("venue-booking-loading")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();

    provenanceRef.current = provenanceWith("RENT");
    rerenderBuilder();

    expect(probe()).toHaveAttribute("data-intent-pending", "0");
    expect(probe()).toHaveAttribute("data-intent", "RENT");
    expect(
      screen.getByRole("radio", { name: "admin.ebIntentRent" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("a touch made before provenance lands is NOT overwritten when it does", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    fireEvent.click(screen.getByTestId("touch-use"));
    expect(probe()).toHaveAttribute("data-intent", "USE");

    provenanceRef.current = provenanceWith("RENT");
    rerenderBuilder();

    expect(probe()).toHaveAttribute("data-intent", "USE");
    expect(probe()).toHaveAttribute("data-intent-pending", "0");
  });

  it("re-picking the SAME venue keeps the stored placement (mirrors the timezone no-op)", async () => {
    provenanceRef.current = provenanceWith("RENT");
    renderBuilder();
    await screen.findByTestId("event-title");
    expect(probe()).toHaveAttribute("data-intent", "RENT");

    fireEvent.click(screen.getByTestId("repick-same"));

    expect(probe()).toHaveAttribute("data-source", "hydrated");
    expect(probe()).toHaveAttribute("data-intent", "RENT");
    expect(probe()).toHaveAttribute("data-calendar", IDS.MAIN);
    expect(probe()).toHaveAttribute("data-space", "");
  });
});
