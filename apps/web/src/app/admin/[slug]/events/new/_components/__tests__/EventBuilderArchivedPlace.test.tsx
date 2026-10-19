/**
 * EventBuilder — a draft whose selected place is ARCHIVED.
 *
 * (Probes print a null name as "null", so null and "" stay distinct.)
 *
 * The venue-privacy read (`places.getPlacePublic`) answers NOT_FOUND /
 * PLACE_ARCHIVED for it. That answer is final and handled, so the builder:
 *
 *   1. does not retry it, and claims it for `meta.silentWhen`, so the global
 *      query logger neither logs, reports nor toasts it;
 *   2. shows the archived state itself instead: the location section and the
 *      address-visibility section both get the place's name;
 *   3. keeps the exact-address option LOCKED (the ceiling stays `checking`).
 *
 * Any other failure of the same read is neither silenced nor named archived.
 *
 * MOCKS: the PlacementHydration scaffold, with the Essentials and Settings
 * sections replaced by probes that print the props under test, and the
 * `getPlacePublic` hook replaced by one that records its options and answers
 * from `privacyRef`.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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

const { query, mutation, EVENT_FOR_EDIT, provenanceRef, privacyRef } =
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
    /** The venue-privacy read: its last options, and what it answers. */
    const privacyRef = {
      current: query() as Record<string, unknown>,
      options: undefined as
        | {
            retry?: (failureCount: number, error: unknown) => boolean;
            meta?: { silentWhen?: (error: unknown) => boolean };
          }
        | undefined,
    };
    return {
      query,
      mutation,
      EVENT_FOR_EDIT,
      IDS,
      CALENDARS,
      provenanceRef,
      privacyRef,
    };
  });

// ── Probes: the props the builder hands the two location surfaces ─────────

vi.mock("../BuilderEssentialsSection", async () => {
  const React = await import("react");
  return {
    BuilderEssentialsSection: (props: { placeArchivedName?: string | null }) =>
      React.createElement("div", {
        "data-testid": "essentials-probe",
        "data-archived-name": props.placeArchivedName === null ? "null" : String(props.placeArchivedName),
      }),
  };
});

vi.mock("../BuilderDetailsSection", () => ({
  BuilderDetailsSection: () => null,
}));
vi.mock("../BuilderSettingsSections", async () => {
  const React = await import("react");
  const { ceilingLocksExact } = await import(
    "@/lib/places/venue-location-ceiling"
  );
  return {
    BuilderSettingsSections: (props: {
      venueCeiling: import("@/lib/places/venue-location-ceiling").VenueLocationCeiling;
      placeArchivedName?: string | null;
    }) =>
      React.createElement("div", {
        "data-testid": "settings-probe",
        "data-ceiling": props.venueCeiling.state,
        "data-exact-locked": String(ceilingLocksExact(props.venueCeiling)),
        "data-archived-name": props.placeArchivedName === null ? "null" : String(props.placeArchivedName),
      }),
  };
});

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
      // The read under test: records its options, answers from `privacyRef`.
      places: {
        getPlacePublic: {
          useQuery: (_input: unknown, opts: unknown) => {
            privacyRef.options = opts as typeof privacyRef.options;
            return privacyRef.current;
          },
        },
      },
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

const ARCHIVED = {
  message: "PLACE_ARCHIVED",
  data: { code: "NOT_FOUND", appCode: "PLACE_ARCHIVED" },
};
const SERVER_FAULT = {
  message: "boom",
  data: { code: "INTERNAL_SERVER_ERROR" },
};

beforeEach(() => {
  provenanceRef.current = query({ isPending: true });
  privacyRef.current = query();
  privacyRef.options = undefined;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
});

describe("EventBuilder — a draft at an ARCHIVED place", () => {
  it("the archived read is silent and not retried, the place is named in both location surfaces, and exact stays locked", async () => {
    privacyRef.current = query({ isError: true, error: ARCHIVED });
    renderBuilder();
    await screen.findByTestId("essentials-probe");

    // 1. Silent and final: the global logger skips it (no console, Sentry or
    //    toast), and react-query does not ask again.
    const opts = privacyRef.options;
    expect(opts?.meta?.silentWhen?.(ARCHIVED)).toBe(true);
    expect(opts?.retry?.(0, ARCHIVED)).toBe(false);

    // 2. Shown instead, by name, with no click.
    expect(screen.getByTestId("essentials-probe")).toHaveAttribute(
      "data-archived-name",
      "The Blue Room",
    );
    const settings = screen.getByTestId("settings-probe");
    expect(settings).toHaveAttribute("data-archived-name", "The Blue Room");

    // 3. Fail closed: the venue's setting is unknown, so exact stays off.
    expect(settings).toHaveAttribute("data-ceiling", "checking");
    expect(settings).toHaveAttribute("data-exact-locked", "true");
  });

  it("any OTHER failure is still reported, retried once, and not called archived", async () => {
    privacyRef.current = query({ isError: true, error: SERVER_FAULT });
    renderBuilder();
    await screen.findByTestId("essentials-probe");

    const opts = privacyRef.options;
    expect(opts?.meta?.silentWhen?.(SERVER_FAULT)).toBe(false);
    expect(opts?.retry?.(0, SERVER_FAULT)).toBe(true);
    expect(opts?.retry?.(1, SERVER_FAULT)).toBe(false);

    expect(screen.getByTestId("essentials-probe")).toHaveAttribute(
      "data-archived-name",
      "null",
    );
    const settings = screen.getByTestId("settings-probe");
    expect(settings).toHaveAttribute("data-archived-name", "null");
    expect(settings).toHaveAttribute("data-exact-locked", "true");
  });

  it("an archived place with no name gives null, never \"\" (no ' is archived' with a blank)", async () => {
    const original = EVENT_FOR_EDIT.place.name;
    EVENT_FOR_EDIT.place.name = "   ";
    try {
      privacyRef.current = query({ isError: true, error: ARCHIVED });
      renderBuilder();
      await screen.findByTestId("essentials-probe");
      expect(screen.getByTestId("essentials-probe")).toHaveAttribute(
        "data-archived-name",
        "null",
      );
      const settings = screen.getByTestId("settings-probe");
      expect(settings).toHaveAttribute("data-archived-name", "null");
      // Still fail closed.
      expect(settings).toHaveAttribute("data-exact-locked", "true");
    } finally {
      EVENT_FOR_EDIT.place.name = original;
    }
  });
});
