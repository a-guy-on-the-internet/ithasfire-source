/**
 * COMMUNITY mode in the real `EventBuilder`.
 *
 * Community listings are authored here now — same Essentials, same Details
 * (with body image upload), same live preview, same Publish control — instead
 * of in a standalone form that had no preview, no editor to return to, and
 * could not put an image in the body at all.
 *
 * What this file pins is the SHAPE of that mode and, just as importantly, that
 * the ticketed path is untouched by it. Three classes of assertion:
 *
 *  1. Community mode hides every owned-event surface. Not cosmetic: each of
 *     their writes refuses an ownerless row server-side (`NOT_RESOURCE_OWNER`
 *     from the ticket-type, lineup, category and tag use-cases), so rendering
 *     one would be a control that 403s on use.
 *  2. Ticketed mode still shows all of them — the same assertions, inverted,
 *     against the same harness.
 *  3. A PUBLISHED community listing is read-only, because
 *     `community.updateListing` is DRAFT-only and would 409.
 *
 * EventBuilder's heavy children and data layer are stubbed; the mode
 * derivation, the section gating and the preview props are exercised for real.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type|href)$/;
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
    id,
  }: {
    children?: ReactNode;
    id?: string;
  }) => React.createElement("span", { id }, children);
  const Passthrough = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "div",
      { "data-testid": rest["data-testid"] },
      children,
    );
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
    // `tag="a"` + `href` is a real Button capability (see
    // ResaleListingsSection / OrderConfirmation), so the stub honours it —
    // otherwise an assertion on the link target would be testing the mock.
    Button: ({
      children,
      onPress,
      tag,
      href,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      tag?: string;
      href?: string;
      [key: string]: unknown;
    }) =>
      React.createElement(
        tag === "a" ? "a" : "button",
        {
          onClick: onPress,
          ...(tag === "a" ? { href } : {}),
          "data-testid": rest["data-testid"],
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value?: string;
      onChangeText?: (v: string) => void;
      testId?: string;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        value: value ?? "",
        onChange: (e: { target: { value: string } }) =>
          onChangeText?.(e.target.value),
      }),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
    useNotify: () => ({
      toast: {
        info: noop,
        success: noop,
        warning: noop,
        danger: toastSpies.danger,
        neutral: noop,
      },
    }),
  };
});

// next/dynamic: resolve the (mocked) module async and render it once loaded.
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<Record<string, unknown>>) => {
      function DynamicStub(props: Record<string, unknown>) {
        const [Comp, setComp] = React.useState<React.ComponentType | null>(
          null,
        );
        React.useEffect(() => {
          let alive = true;
          void Promise.resolve(loader()).then((mod) => {
            const resolved = (mod as { default?: React.ComponentType }).default;
            if (alive && resolved) setComp(() => resolved);
          });
          return () => {
            alive = false;
          };
        }, []);
        return Comp ? React.createElement(Comp, props) : null;
      }
      return DynamicStub;
    },
  };
});

// ── Heavy child surfaces → cheap stubs ────────────────────────────────────
// The preview stub reports `communityLayout` back as a data attribute: the
// whole point of passing it is that the preview renders the COMMUNITY page
// shape, and a preview showing the ticketed shape would be a lie about the
// page being authored.
vi.mock("../EventPreview", async () => {
  const React = await import("react");
  return {
    EventPreview: (props: { communityLayout?: boolean }) => {
      stubProps.preview = props as typeof stubProps.preview;
      return React.createElement("div", {
        "data-testid": "mock-event-preview",
        "data-community-layout": String(Boolean(props.communityLayout)),
      });
    },
  };
});
vi.mock("../SeatingLayoutEditor", () => ({ SeatingLayoutEditor: () => null }));
// The template owner each stub was last handed — kept OUT of the DOM so the
// parity snapshots below are unaffected.
/** `toast.danger`, captured: the place-link refusal tests read its message. */
const toastSpies = vi.hoisted(() => ({ danger: vi.fn() }));

/**
 * The last props the LocationSection and EventPreview stubs were handed, kept
 * OUT of the DOM so the parity snapshots are unaffected. The place-link tests
 * drive the builder through the LocationSection callbacks, exactly as the real
 * section would call them.
 */
const stubProps = vi.hoisted(() => ({
  locationSection: undefined as
    | {
        onLocationModeChange: (mode: "address" | "place") => void;
        onPlaceSelect: (place: unknown) => void;
        onLocationChange: (location: Record<string, unknown>) => void;
      }
    | undefined,
  preview: undefined as { venueName?: string; location?: string } | undefined,
}));

const templateOwnerProps = vi.hoisted(() => ({
  ticketEditor: undefined as unknown,
  applicationBuilder: undefined as unknown,
  canCustomiseTemplates: undefined as boolean | undefined,
}));
vi.mock("../ApplicationFormBuilder", async () => {
  const React = await import("react");
  return {
    ApplicationFormBuilder: (props: { templateOwner?: unknown }) => {
      templateOwnerProps.applicationBuilder = props.templateOwner;
      return React.createElement("div", {
        "data-testid": "stub-application-builder",
      });
    },
  };
});
vi.mock("../TicketTypeEditor", async () => {
  const React = await import("react");
  return {
    TicketTypeEditor: (props: {
      templateOwner?: unknown;
      canCustomiseTemplates?: boolean;
    }) => {
      templateOwnerProps.ticketEditor = props.templateOwner;
      templateOwnerProps.canCustomiseTemplates = props.canCustomiseTemplates;
      return React.createElement("div", {
        "data-testid": "stub-ticket-editor",
      });
    },
  };
});
vi.mock("../LineupEditor", async () => {
  const React = await import("react");
  return {
    LineupEditor: ({ communityMode }: { communityMode?: boolean }) =>
      React.createElement("div", {
        "data-testid": "stub-lineup-editor",
        "data-community-mode": String(Boolean(communityMode)),
      }),
  };
});
vi.mock("../SplitsEditor", async () => {
  const React = await import("react");
  return {
    SplitsEditor: () =>
      React.createElement("div", { "data-testid": "stub-splits-editor" }),
  };
});
// The last `canRegenerateSlug` the builder handed the settings stub — the
// "admin-level actions" block reads it. Kept OUT of the DOM so the parity
// snapshots below are unaffected.
const settingsSectionsProps = vi.hoisted(() => ({
  canRegenerateSlug: undefined as boolean | undefined,
  waiversEnabled: undefined as boolean | undefined,
}));
vi.mock("../BuilderSettingsSections", async () => {
  const React = await import("react");
  return {
    BuilderSettingsSections: (props: {
      canRegenerateSlug?: boolean;
      waiversEnabled?: boolean;
    }) => {
      settingsSectionsProps.canRegenerateSlug = props.canRegenerateSlug;
      settingsSectionsProps.waiversEnabled = props.waiversEnabled;
      return React.createElement("div", {
        "data-testid": "stub-settings-sections",
      });
    },
  };
});
vi.mock("../RecurrenceBuilder", () => ({ RecurrenceBuilder: () => null }));
vi.mock("../SeriesEditScopeDialog", () => ({
  SeriesEditScopeDialog: () => null,
}));
vi.mock("../HeroImageField", () => ({ HeroImageField: () => null }));
vi.mock("../LocationSection", async () => {
  const React = await import("react");
  return {
    LocationSection: (props: { communityMode?: boolean }) => {
      stubProps.locationSection = props as typeof stubProps.locationSection;
      return React.createElement("div", {
        "data-testid": "stub-location-section",
        "data-community-mode": String(Boolean(props.communityMode)),
      });
    },
  };
});
vi.mock("../CategoryTagsSection", async () => {
  const React = await import("react");
  return {
    CategoryTagsSection: () =>
      React.createElement("div", { "data-testid": "stub-category-tags" }),
  };
});
vi.mock("../EventProvenanceNote", async () => {
  const React = await import("react");
  return {
    EventProvenanceNote: () =>
      React.createElement("div", { "data-testid": "stub-provenance-note" }),
  };
});
vi.mock("../PublishReadinessRail", async () => {
  const React = await import("react");
  return {
    PublishReadinessRail: ({ variant }: { variant: string }) =>
      React.createElement("div", {
        "data-testid": `stub-readiness-${variant}`,
      }),
  };
});
vi.mock("../SettingsGroup", async () => {
  const React = await import("react");
  return {
    SettingsGroup: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
  };
});
// The prose editor reports whether the audio button was offered. Community
// mode withheld it for as long as `resolveEventAudio` could not read back a
// DRAFT ownerless event's uploads — a button that swallows files. The read
// path now has the moderator branch, so both modes offer it.
vi.mock("../prose-editor", async () => {
  const React = await import("react");
  return {
    ProseEditor: ({ showAudioButton }: { showAudioButton?: boolean }) =>
      React.createElement("div", {
        "data-testid": "stub-prose-editor",
        "data-audio-button": String(Boolean(showAudioButton)),
      }),
    createEmptyDoc: () => ({ type: "doc", content: [] }),
    hasContent: () => false,
  };
});
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
vi.mock("../../../_components/EventStatusBadge", () => ({
  EventStatusBadge: () => null,
}));

// ── App-level hooks / chrome ──────────────────────────────────────────────

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
// Mutable so the waiver-picker block can switch `waivers` on; every other
// test sees the empty object it always did.
const featureGates = vi.hoisted(() => ({
  gates: {} as Record<string, boolean>,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: featureGates.gates }),
}));
vi.mock("@/components/errors/QuotaExceededDialog", () => ({
  QuotaExceededDialog: () => null,
}));
// Renders ONLY the community take-down items (Take down listing), so
// every other test — and the rendered-output parity baselines — still sees no
// menu at all.
vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: ({
    items,
  }: {
    items: { key: string; label: string; testId?: string; onPress: () => void }[];
  }) => {
    const takedown = items.filter(
      (item) => item.key === "take-down-listing",
    );
    return takedown.length === 0 ? null : (
      <div data-testid="row-action-menu">
        {takedown.map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid={item.testId ?? item.key}
            onClick={item.onPress}
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  },
}));

// `StableActionLabel` renders Tamagui's `ButtonText`, which the `tamagui` mock
// above does not carry. The builder specs care about which label is showing,
// not about the width-reserving cell.
vi.mock("../StableActionLabel", () => ({
  StableActionLabel: ({
    idle,
    busy,
    pending,
  }: {
    idle: string;
    busy: string;
    pending: boolean;
  }) => (pending ? busy : idle),
}));
vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => (error: unknown) =>
    secondFactorSpy(error),
}));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@th/core/lib/payments/chargeback-terms", () => ({
  CURRENT_CHARGEBACK_TERMS_TEXT: "terms",
  CURRENT_CHARGEBACK_TERMS_VERSION: "v1",
}));
vi.mock("@th/core/use-cases/events/host-attestation-text", () => ({
  HOST_ATTESTATION_FIELDS: ["safety"],
  HOST_ATTESTATION_TEXT: { safety: "Keep it safe" },
  HOST_ATTESTATION_VERSION: "v1",
}));

// ── Data layer ────────────────────────────────────────────────────────────

const {
  query,
  mutation,
  EVENT_FOR_EDIT,
  eventRef,
  updateListingSpy,
  staffRef,
  secondFactorSpy,
  invalidateSpy,
  cancelEventSpy,
} =
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

  // `community.updateListing` specifically — the live-save assertions need to
  // read the PAYLOAD, not just that something fired.
  const updateListingSpy =
    vi.fn<[{ eventId: string; fields: Record<string, unknown> }], Promise<unknown>>();

  const EVENT_FOR_EDIT = {
    eventId: "evt-1",
    title: "Saved Title",
    status: "DRAFT",
    stewardship: "OWNED",
    startsAt: "2026-08-01T20:00:00.000Z",
    endsAt: "2026-08-01T23:00:00.000Z",
    timezone: "America/Chicago",
    currency: "USD",
    slug: "saved-title",
    shortId: null,
    seriesId: null,
    seriesRrule: null,
    seriesUntil: null,
    // The event's owner is viewing it (payout routing is theirs to see).
    viewerCanManagePayouts: true,
    ticketsSold: 0,
    placeId: null,
    place: null,
    placeLayoutId: null,
    content: null,
    heroImageUrl: null,
    // A REAL pin. `validateCommunityFields` refuses to save an un-geocoded
    // community listing (the FR-007 whitelist rejects a lone `addressText`),
    // so without this every community save assertion below would abort before
    // reaching the mutation.
    addressText: "1 Main St, Nashville, TN 37203",
    lat: 36.16,
    lng: -86.78,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37203",
    categoryId: null,
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

  // Mutable so a test can pick the stewardship / status / stored start BEFORE
  // rendering. Reset in `beforeEach`.
  const eventRef = {
    stewardship: "OWNED",
    status: "DRAFT",
    startsAt: EVENT_FOR_EDIT.startsAt,
    /** The stored place link (`getEventForEdit.placeId` / `.place`). */
    placeId: null as string | null,
    place: null as Record<string, unknown> | null,
  };

  // The viewer's platform roles (`platform.checkStaffAccess`) and the two
  // take-down mutations, so a test can pick who is looking and read the call.
  const staffRef = {
    roles: [] as string[],
    enrolled: true,
    /** The `enabled` option each render passed to `checkStaffAccess`. */
    enabledSeen: [] as boolean[],
  };
  const secondFactorSpy = vi.fn<[unknown], boolean>();
  const invalidateSpy = vi.fn<[unknown], Promise<void>>();
  const cancelEventSpy = vi.fn<[unknown], Promise<unknown>>();

  return {
    query,
    mutation,
    EVENT_FOR_EDIT,
    eventRef,
    updateListingSpy,
    staffRef,
    secondFactorSpy,
    invalidateSpy,
    cancelEventSpy,
  };
});

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  // Result objects are created ONCE per (stewardship, status) pair and
  // returned by identity on every render — mirroring React Query's structural
  // sharing. Fresh objects per render would retrigger EventBuilder's
  // identity-keyed effects into an infinite setState loop.
  const eventForEditByKey = new Map<string, unknown>();
  const getEventForEditResult = () => {
    const key = `${eventRef.stewardship}:${eventRef.status}:${eventRef.startsAt}:${eventRef.placeId}`;
    if (!eventForEditByKey.has(key)) {
      eventForEditByKey.set(
        key,
        query({
          data: {
            ...EVENT_FOR_EDIT,
            stewardship: eventRef.stewardship,
            status: eventRef.status,
            startsAt: eventRef.startsAt,
            placeId: eventRef.placeId,
            place: eventRef.place,
          },
          isSuccess: true,
        }),
      );
    }
    return eventForEditByKey.get(key);
  };
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
  const categoriesResult = query({
    data: { categories: [{ id: "cat-1", slug: "music", name: "Music" }] },
    isSuccess: true,
  });
  const utilsStub: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "events") {
        return {
          getEventForEdit: { invalidate: invalidateSpy },
          getGateState: { invalidate: () => Promise.resolve() },
        };
      }
      return chain;
    },
    apply: () => undefined,
  });
  const mutationResult = mutation();
  const useMutation = () => mutationResult;
  const cancelEventResult = {
    ...mutationResult,
    mutateAsync: cancelEventSpy,
  };
  // Stable identity per role set, like React Query's structural sharing.
  const staffByKey = new Map<string, unknown>();
  const staffResult = () => {
    const key = `${staffRef.roles.join(",")}:${staffRef.enrolled}`;
    if (!staffByKey.has(key)) {
      staffByKey.set(
        key,
        query({
          data: {
            allowed: staffRef.roles.length > 0,
            roles: staffRef.roles,
            actorHumanId: "h-1",
            secondFactorEnrolled: staffRef.enrolled,
          },
          isSuccess: true,
        }),
      );
    }
    return staffByKey.get(key);
  };
  return {
    trpc: {
      useUtils: () => utilsStub,
      events: {
        getEventForEdit: { useQuery: () => getEventForEditResult() },
        listTicketTypesForEdit: { useQuery: () => ticketTypesResult },
        getGateState: { useQuery: () => gateStateResult },
        getEventProvenance: { useQuery: () => emptyResult },
        resolveImages: { useQuery: () => emptyResult },
        resolveAudio: { useQuery: () => audioResult },
        createEventForHuman: { useMutation },
        createEventForOrg: { useMutation },
        requestImageUpload: { useMutation },
        finalizeImageUpload: { useMutation },
        publishEvent: { useMutation },
        unpublishEvent: { useMutation },
        cancelEvent: { useMutation: () => cancelEventResult },
      },
      community: {
        updateListing: {
          useMutation: () => ({
            mutate: () => undefined,
            mutateAsync: updateListingSpy,
            isPending: false,
          }),
        },
        publishListing: { useMutation },
      },
      // ADDRESS PRIVACY (place-address-withholding): the builder reads the
      // selected venue's PUBLIC location projection to decide whether the
      // exact-address option is available. An unresolved query is the
      // fail-closed `checking` state, which is what this stub produces.
      places: { getPlacePublic: { useQuery: () => emptyResult } },
      categories: { list: { useQuery: () => categoriesResult } },
      eventHumans: { list: { useQuery: () => lineupResult } },
      stripeConnect: { getStatus: { useQuery: () => emptyResult } },
      promos: { list: { useQuery: () => emptyResult } },
      platform: {
        checkStaffAccess: {
          useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
            staffRef.enabledSeen.push(opts?.enabled === true);
            return staffResult();
          },
        },
      },
      series: {
        updateEventSeries: { useMutation },
        reconcileSeriesSchedule: { useMutation },
        convertEventToSeries: { useMutation },
        generateEventsFromSeries: { useMutation },
        syncSeriesDrafts: { useMutation },
      },
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

const renderBuilder = (
  props: Partial<Parameters<typeof EventBuilder>[0]> = {},
) =>
  render(
    <EventBuilder
      surface="edit"
      ownerType="human"
      ownerId="h-1"
      slug="acme-co"
      eventId="evt-1"
      canEditEvent
      {...props}
    />,
  );

/**
 * Everything community mode must NOT render, and why each one 4xxs.
 *
 * `stub-lineup-editor` LEFT this list on 2026-09-15: `eventHumans.*` was opened
 * to community moderators, so the lineup is the one owned-event surface an
 * ownerless listing can use. It has its own assertions below.
 */
const OWNED_ONLY_SURFACES = [
  "stub-ticket-editor", // listEventTicketTypesForEdit: NOT_RESOURCE_OWNER
  "stub-splits-editor", // splits presume a payee
  "stub-settings-sections", // access gate / tax / waiver / payout / sharing
  "stub-category-tags", // setEventCategory + setEventTags: NOT_RESOURCE_OWNER
  "stub-provenance-note", // getEventProvenance refuses a COMMUNITY listing
  "stub-application-builder", // applications are an owned-event gate type
  "stub-readiness-rail", // every item it checks belongs to an owned event
] as const;

describe("EventBuilder — COMMUNITY mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    updateListingSpy.mockReset();
    updateListingSpy.mockResolvedValue({});
    eventRef.stewardship = "OWNED";
    eventRef.status = "DRAFT";
    eventRef.startsAt = EVENT_FOR_EDIT.startsAt;
    eventRef.placeId = null;
    eventRef.place = null;
    staffRef.roles = [];
    staffRef.enrolled = true;
    staffRef.enabledSeen = [];
    secondFactorSpy.mockReset();
    secondFactorSpy.mockReturnValue(false);
    invalidateSpy.mockReset();
    invalidateSpy.mockResolvedValue(undefined);
    cancelEventSpy.mockReset();
    cancelEventSpy.mockResolvedValue({});
    stubProps.locationSection = undefined;
    stubProps.preview = undefined;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
  });

  describe("a DRAFT community listing", () => {
    beforeEach(() => {
      eventRef.stewardship = "COMMUNITY";
    });

    it("hides every owned-event surface", async () => {
      renderBuilder();
      // The builder DID mount (so the absences below aren't a false negative
      // from an unrendered tree).
      await screen.findByTestId("event-title");

      for (const testId of OWNED_ONLY_SURFACES) {
        expect(screen.queryByTestId(testId)).toBeNull();
      }
    });

    it("renders the LINEUP section, in its community variant", async () => {
      // `eventHumans.list` / `attach` / `detach` / `reorder` admit a community
      // moderator, so a listing can name who is playing. The variant flag is
      // what turns OFF the two payout-shaped affordances inside the editor
      // (referral links, "invite to set up payouts"), both of which are still
      // owner-gated and both of which were firing NOT_RESOURCE_OWNER.
      renderBuilder();
      const lineup = await screen.findByTestId("stub-lineup-editor");
      expect(lineup).toHaveAttribute("data-community-mode", "true");
    });

    it("keeps Essentials, Details and the live Preview", async () => {
      renderBuilder();

      expect(await screen.findByTestId("event-title")).toHaveValue(
        "Saved Title",
      );
      expect(screen.getByTestId("event-starts-at")).toBeInTheDocument();
      expect(screen.getByTestId("stub-prose-editor")).toBeInTheDocument();
      expect(screen.getByTestId("event-edit-layout")).toBeInTheDocument();
      // Save / Publish are both offered on a draft listing.
      expect(screen.getByTestId("event-save-btn")).toBeInTheDocument();
      expect(screen.getByTestId("event-publish-btn")).toBeInTheDocument();
    });

    it("offers the whitelist-backed category picker in place of category+tags", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");

      // `categoryId` IS in the FR-007 whitelist, so it rides the builder's own
      // save. Tags are not offered at all — they have no community write path.
      expect(screen.getByTestId("community-category-select")).toBeVisible();
      expect(screen.queryByTestId("stub-category-tags")).toBeNull();
    });

    it("puts the venue field in community mode (all venues, no booking cascade)", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");

      expect(screen.getByTestId("stub-location-section")).toHaveAttribute(
        "data-community-mode",
        "true",
      );
    });

    it("offers the body audio button (resolveEventAudio reads it back now)", async () => {
      // This assertion was `false` until `resolveEventAudio` grew the
      // COMMUNITY arm. Uploading already worked — `requestAudioUpload` and
      // `finalizeAudioUpload` both have a COMMUNITY branch — but the read
      // path resolved an ownerless row through `authz.canEditEvent`, which is
      // false for every one of them, so a track dropped on a DRAFT listing
      // never rendered a player here or in the preview.
      renderBuilder();

      expect(await screen.findByTestId("stub-prose-editor")).toHaveAttribute(
        "data-audio-button",
        "true",
      );
    });

    it("previews the COMMUNITY page layout, not the ticketed one", async () => {
      renderBuilder({ initialViewMode: "preview" });

      expect(await screen.findByTestId("mock-event-preview")).toHaveAttribute(
        "data-community-layout",
        "true",
      );
    });
  });

  describe("the place link (venue picker on a community listing)", () => {
    const LINKED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const WITHHELD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const GEO_KEYS = [
      "addressText",
      "lat",
      "lng",
      "countryCode",
      "region",
      "locality",
      "postalCode",
    ];
    // What the PlacePicker hands up for a venue that withholds its address:
    // the public read is redacted, so no formatted address and no pin.
    const WITHHELD_PICK = {
      placeId: WITHHELD_ID,
      name: "The Back Room",
      formattedAddress: null,
      city: "Nashville",
      region: "TN",
      lat: null,
      lng: null,
      timezone: null,
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
    };
    const sentFields = () =>
      (updateListingSpy.mock.calls[0]![0] as { fields: Record<string, unknown> })
        .fields;
    const section = () => {
      expect(stubProps.locationSection).toBeDefined();
      return stubProps.locationSection!;
    };
    /** Exactly what LocationSection's place handler does on a pick. */
    const pickWithheldVenue = () => {
      act(() => section().onLocationModeChange("place"));
      act(() => {
        section().onPlaceSelect(WITHHELD_PICK);
        section().onLocationChange({
          thPlaceId: WITHHELD_PICK.placeId,
          thPlaceName: WITHHELD_PICK.name,
          addressText: undefined,
          lat: undefined,
          lng: undefined,
          locality: WITHHELD_PICK.city,
          region: WITHHELD_PICK.region,
        });
      });
    };
    const hydrateLinked = () => {
      eventRef.placeId = LINKED_ID;
      eventRef.place = {
        id: LINKED_ID,
        name: "The Attic",
        formattedAddress: "1 Main St, Nashville, TN 37203",
        city: "Nashville",
        region: "TN",
        lat: 36.16,
        lng: -86.78,
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      };
    };

    beforeEach(() => {
      eventRef.stewardship = "COMMUNITY";
      toastSpies.danger.mockReset();
    });

    it("a picked venue with no address or pin skips the pin check and sends { placeId } alone", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");
      pickWithheldVenue();

      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
      const fields = sentFields();
      expect(fields.placeId).toBe(WITHHELD_ID);
      expect(Object.keys(fields).filter((k) => GEO_KEYS.includes(k))).toEqual([]);
      // The client never claimed "pick the address": the server decides.
      expect(toastSpies.danger).not.toHaveBeenCalled();
    });

    it("the server's PLACE_WITHHOLDS_ADDRESS refusal reaches the moderator", async () => {
      updateListingSpy.mockRejectedValueOnce({
        message: "this place withholds its address",
        data: {
          appCode: "INVALID_INPUT",
          meta: { placeId: WITHHELD_ID, reason: "PLACE_WITHHOLDS_ADDRESS" },
        },
      });
      renderBuilder();
      await screen.findByTestId("event-title");
      pickWithheldVenue();

      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(toastSpies.danger).toHaveBeenCalledTimes(1));
      const { message } = toastSpies.danger.mock.calls[0]![0] as {
        message: string;
      };
      // Identity `t`: the key, humanized by `normalizeError`.
      expect(message).toMatch(/communityBuilder\.errPlaceWithholdsAddress/i);
      expect(message).not.toMatch(/errLocationPin/i);
    });

    it("a hydrated linked listing switched to Address saves placeId: null", async () => {
      hydrateLinked();
      renderBuilder();
      await screen.findByTestId("event-title");

      act(() => section().onLocationModeChange("address"));
      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
      expect(sentFields().placeId).toBeNull();
    });

    it("a hydrated linked listing kept in Venue mode sends neither placeId nor address", async () => {
      // A DRAFT includes the venue group on every save, and the server refuses
      // address fields on a linked listing without `placeId: null`.
      hydrateLinked();
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
      const fields = sentFields();
      expect("placeId" in fields).toBe(false);
      expect(Object.keys(fields).filter((k) => GEO_KEYS.includes(k))).toEqual([]);
    });

    it("a typed address with no pin is still refused client-side (errLocationPin), nothing sent", async () => {
      // The pin check is skipped ONLY for a linked venue. A typed address
      // without coordinates must keep failing before the mutation.
      renderBuilder();
      await screen.findByTestId("event-title");

      act(() => section().onLocationModeChange("address"));
      act(() => section().onLocationChange({ addressText: "somewhere" }));
      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(toastSpies.danger).toHaveBeenCalledTimes(1));
      expect(updateListingSpy).not.toHaveBeenCalled();
      const { message } = toastSpies.danger.mock.calls[0]![0] as {
        message: string;
      };
      // Identity `t`: the key, humanized by `normalizeError`.
      expect(message).toMatch(/communityBuilder\.errLocationPin/i);
    });

    it("the preview names the linked venue, and stops naming it once switched to Address", async () => {
      hydrateLinked();
      const first = renderBuilder();
      await screen.findByTestId("event-title");
      fireEvent.click(screen.getByTestId("view-mode-preview"));
      await screen.findByTestId("mock-event-preview");
      expect(stubProps.preview?.venueName).toBe("The Attic");
      first.unmount();

      stubProps.preview = undefined;
      renderBuilder();
      await screen.findByTestId("event-title");
      act(() => section().onLocationModeChange("address"));
      fireEvent.click(screen.getByTestId("view-mode-preview"));
      await screen.findByTestId("mock-event-preview");
      // Re-type explicitly: the `= undefined` above narrows the property to
      // `undefined` for tsc, though the re-render has since set it.
      const preview = stubProps.preview as
        | { venueName?: string; location?: string }
        | undefined;
      expect(preview?.venueName).toBeUndefined();
      expect(preview?.location).toBe("1 Main St, Nashville, TN 37203");
    });
  });

  describe("a PUBLISHED community listing", () => {
    beforeEach(() => {
      eventRef.stewardship = "COMMUNITY";
      eventRef.status = "PUBLISHED";
    });

    it("renders the real form — updateListing takes a live listing now", async () => {
      renderBuilder();

      // This block used to assert the opposite. `community.updateListing` was
      // DRAFT-only, so a moderator fixing a typo on a live listing had to file
      // a public suggestion against it and approve their own proposal.
      expect(await screen.findByTestId("event-edit-layout")).toBeInTheDocument();
      expect(screen.getByTestId("event-title")).toHaveValue("Saved Title");
      expect(screen.getByTestId("event-save-btn")).toBeInTheDocument();
      expect(screen.queryByTestId("community-locked-notice")).toBeNull();
    });

    it("says, before anything is typed, that editing here is public", async () => {
      // The green PUBLISHED chip beside the title is a status readout, and it
      // looks the same on a ticketed event where none of this applies. The
      // band is the one thing on the surface that names the consequence.
      renderBuilder();

      expect(
        await screen.findByTestId("community-live-edit-notice"),
      ).toBeVisible();
    });

    it("does not offer Publish on a listing that is already live", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");

      expect(screen.queryByTestId("event-publish-btn")).toBeNull();
    });

    it("still previews the community layout", async () => {
      renderBuilder({ initialViewMode: "preview" });

      expect(await screen.findByTestId("mock-event-preview")).toHaveAttribute(
        "data-community-layout",
        "true",
      );
    });

    it("saves a non-material edit straight through, with no confirm", async () => {
      // Nothing moved, so nothing is mailed, so there is nothing to confirm.
      // A speed bump in front of every title fix is a speed bump nobody reads.
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("community-live-save-dialog")).toBeNull();
    });

    it.each([
      ["PLACE_WITHHOLDS_ADDRESS", "communityBuilder.errPlaceWithholdsAddress"],
      ["PLACE_LOCATION_INCOMPLETE", "communityBuilder.errPlaceLocationIncomplete"],
    ])(
      "a place link refused as INVALID_INPUT / %s says why, not 'invalid input'",
      async (reason, messageKey) => {
        // `useTranslations` is the identity here, so the toast carries the KEY
        // (humanized by `normalizeError`). Matching on it proves the reason
        // picked the right copy; the real catalog supplies the sentence.
        toastSpies.danger.mockReset();
        updateListingSpy.mockRejectedValueOnce({
          message: "this place cannot be linked",
          data: {
            appCode: "INVALID_INPUT",
            meta: { placeId: "p-1", reason },
          },
        });
        renderBuilder();
        await screen.findByTestId("event-title");

        fireEvent.click(screen.getByTestId("event-save-btn"));

        await waitFor(() => expect(toastSpies.danger).toHaveBeenCalledTimes(1));
        expect(toastSpies.danger).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "admin.ebSaveFailedTitle",
            // `normalizeError` humanizes the bare key (capital first letter).
            message: expect.stringMatching(
              new RegExp(messageKey.replace(".", "\\."), "i"),
            ),
          }),
        );
      },
    );

    it("any other INVALID_INPUT keeps the generic path", async () => {
      toastSpies.danger.mockReset();
      updateListingSpy.mockRejectedValueOnce({
        message: "bad",
        data: { appCode: "INVALID_INPUT", meta: { reason: "SOMETHING_ELSE" } },
      });
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));

      await waitFor(() => expect(toastSpies.danger).toHaveBeenCalledTimes(1));
      const { message } = toastSpies.danger.mock.calls[0]![0] as {
        message: string;
      };
      expect(message).not.toContain("errPlace");
    });

    it("omits the unchanged material groups from a non-material save", async () => {
      // The server reads materiality off the KEY SET it receives. Sending an
      // untouched `startsAt` + geo group on a typo fix is what emits
      // RESCHEDULED *and* VENUE_CHANGED to everyone who RSVP'd or saved it.
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));
      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));

      const fields = (
        updateListingSpy.mock.calls[0]![0] as { fields: Record<string, unknown> }
      ).fields;
      expect(Object.keys(fields).sort()).toEqual([
        "categoryId",
        "content",
        "timezone",
        "title",
      ]);
    });

    it("confirms a schedule move, names who hears, and only then saves", async () => {
      // The move is driven from the STORED value, not the DOM: the date
      // control is a `styled("input")`, which this file's tamagui mock
      // renders as a prop-stripped div, so `fireEvent.change` on it does
      // nothing. A stored start carrying seconds is a real instance of the
      // same thing — `datetime-local` cannot express :30, so the save
      // rewrites the instant, and the server WILL emit RESCHEDULED for it.
      // Warning is therefore correct, not over-eager.
      eventRef.startsAt = "2026-08-01T20:00:30.000Z";
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));

      // The confirm is up and the save has NOT fired yet.
      await screen.findByTestId("community-live-save-dialog");
      expect(screen.getByTestId("community-live-save-schedule")).toBeVisible();
      expect(screen.queryByTestId("community-live-save-venue")).toBeNull();
      expect(updateListingSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("community-live-save-confirm"));
      await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));

      const fields = (
        updateListingSpy.mock.calls[0]![0] as { fields: Record<string, unknown> }
      ).fields;
      expect(fields).toHaveProperty("startsAt");
      // The venue did not move, so it stays off the wire and emits no notice.
      expect(fields).not.toHaveProperty("lat");
    });

    it("backing out of the confirm saves nothing", async () => {
      eventRef.startsAt = "2026-08-01T20:00:45.000Z";
      renderBuilder();
      await screen.findByTestId("event-title");

      fireEvent.click(screen.getByTestId("event-save-btn"));
      await screen.findByTestId("community-live-save-dialog");
      fireEvent.click(screen.getByTestId("community-live-save-cancel"));

      await waitFor(() =>
        expect(screen.queryByTestId("community-live-save-dialog")).toBeNull(),
      );
      expect(updateListingSpy).not.toHaveBeenCalled();
    });
  });

  describe("a community listing in an END state", () => {
    beforeEach(() => {
      eventRef.stewardship = "COMMUNITY";
    });

    it.each([
      ["CANCELLED", "communityBuilder.lockedCancelledBody"],
      ["COMPLETED", "communityBuilder.lockedCompletedBody"],
      ["ARCHIVED", "communityBuilder.lockedArchivedBody"],
    ])(
      "renders %s read-only, and names the state",
      async (status, bodyKey) => {
        eventRef.status = status;
        renderBuilder();

        // `updateListing` refuses these with EVENT_NOT_EDITABLE /
        // EVENT_ARCHIVED, so the preview IS the surface.
        const notice = await screen.findByTestId("community-locked-notice");
        expect(notice).toBeVisible();
        expect(notice).toHaveTextContent(bodyKey);
        expect(screen.queryByTestId("event-edit-layout")).toBeNull();
        expect(screen.queryByTestId("event-save-btn")).toBeNull();
        expect(screen.queryByTestId("community-live-edit-notice")).toBeNull();
      },
    );
  });

  /**
   * ── Rendered-output parity ───────────────────────────────────────────────
   *
   * The 2026-09-16 change opened PUBLISHED community listings for editing. Two
   * paths had to come out of it byte-identical: a DRAFT community listing and
   * every ticketed event. Assertions about which test ids are present cannot
   * show that — they only see what they were told to look for, and the failure
   * mode here is a band, an attribute or a wrapper appearing where nothing was
   * meant to change.
   *
   * So these three diff the whole `container.innerHTML` against a copy taken
   * from the PRE-change component with this same harness. The baselines are
   * committed HTML files; a change to either path fails with a real diff.
   *
   * Regenerate deliberately (delete the file and re-run) only when the path is
   * MEANT to move — the whole point is that it stops being a silent edit.
   */
  /**
   * ── Taking a community listing down (owner ruling 2026-10-16) ────────────
   *
   * Platform ADMIN only (`cancelEvent` answers STAFF_ONLY to a
   * COMMUNITY_MODERATOR). One action, `cancelEvent`, while DRAFT or PUBLISHED;
   * nothing once the listing has ended. No Archive step, no hard delete.
   */
  describe("taking a community listing down", () => {
    beforeEach(() => {
      eventRef.stewardship = "COMMUNITY";
    });

    it.each(["DRAFT", "PUBLISHED"])(
      "offers a platform ADMIN Take down listing on a %s listing",
      async (status) => {
        eventRef.status = status;
        staffRef.roles = ["ADMIN"];
        renderBuilder();

        expect(await screen.findByTestId("event-takedown-listing-btn")).toBeVisible();
      },
    );

    it.each([
      ["a non-staff viewer", []],
      ["a community moderator", ["COMMUNITY_MODERATOR"]],
    ])("offers it to neither %s", async (_who, roles) => {
      staffRef.roles = roles;
      eventRef.status = "PUBLISHED";
      renderBuilder();
      await screen.findByTestId("event-save-btn");
      expect(screen.queryByTestId("event-takedown-listing-btn")).toBeNull();
    });

    it.each(["CANCELLED", "COMPLETED"])(
      "offers a platform ADMIN nothing on a %s listing",
      async (status) => {
        eventRef.status = status;
        staffRef.roles = ["ADMIN"];
        renderBuilder();
        await screen.findByTestId("community-locked-notice");
        expect(screen.queryByTestId("event-takedown-listing-btn")).toBeNull();
      },
    );

    it("offers a platform ADMIN nothing on an ARCHIVED listing", async () => {
      eventRef.status = "ARCHIVED";
      staffRef.roles = ["ADMIN"];
      renderBuilder();
      await screen.findByTestId("community-locked-notice");
      expect(screen.queryByTestId("event-takedown-listing-btn")).toBeNull();
    });

    it("asks first, names what happens, and only then takes the listing down", async () => {
      eventRef.status = "PUBLISHED";
      staffRef.roles = ["ADMIN"];
      renderBuilder();

      fireEvent.click(await screen.findByTestId("event-takedown-listing-btn"));
      expect(cancelEventSpy).not.toHaveBeenCalled();
      expect(
        screen.getByText("admin.ebTakeDownListingConfirmBody"),
      ).toBeVisible();

      fireEvent.click(screen.getByTestId("event-listing-takedown-confirm-btn"));
      await waitFor(() => expect(cancelEventSpy).toHaveBeenCalledTimes(1));
      expect(cancelEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "evt-1", clientKey: expect.any(String) }),
      );
    });

    it("offers nothing to staff without an enrolled second factor", async () => {
      eventRef.status = "PUBLISHED";
      staffRef.roles = ["ADMIN"];
      staffRef.enrolled = false;
      renderBuilder();
      await screen.findByTestId("event-save-btn");
      expect(screen.queryByTestId("event-takedown-listing-btn")).toBeNull();
    });

    it("does not ask who the viewer is on an OWNED event", async () => {
      eventRef.stewardship = "OWNED";
      eventRef.status = "PUBLISHED";
      renderBuilder();
      await screen.findByTestId("event-save-btn");
      expect(staffRef.enabledSeen.length).toBeGreaterThan(0);
      expect(staffRef.enabledSeen.every((enabled) => !enabled)).toBe(true);
    });

    it("asks on a community listing", async () => {
      eventRef.status = "PUBLISHED";
      renderBuilder();
      await screen.findByTestId("event-save-btn");
      expect(staffRef.enabledSeen).toContain(true);
    });

    it("hands a SECOND_FACTOR_REQUIRED refusal to the 2FA prompt, nothing else", async () => {
      eventRef.status = "PUBLISHED";
      staffRef.roles = ["ADMIN"];
      const refusal = Object.assign(new Error("SECOND_FACTOR_REQUIRED"), {
        data: { appCode: "SECOND_FACTOR_REQUIRED" },
      });
      cancelEventSpy.mockRejectedValue(refusal);
      secondFactorSpy.mockReturnValue(true);
      renderBuilder();

      fireEvent.click(await screen.findByTestId("event-takedown-listing-btn"));
      fireEvent.click(screen.getByTestId("event-listing-takedown-confirm-btn"));
      await waitFor(() => expect(secondFactorSpy).toHaveBeenCalledWith(refusal));
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it.each(["EVENT_ALREADY_CANCELLED", "EVENT_NOT_CANCELLABLE"])(
      "refetches the listing when cancel answers %s",
      async (code) => {
        eventRef.status = "PUBLISHED";
        staffRef.roles = ["ADMIN"];
        cancelEventSpy.mockRejectedValue(
          Object.assign(new Error(code), { data: { appCode: code } }),
        );
        renderBuilder();

        fireEvent.click(await screen.findByTestId("event-takedown-listing-btn"));
        fireEvent.click(screen.getByTestId("event-listing-takedown-confirm-btn"));
        await waitFor(() =>
          expect(invalidateSpy).toHaveBeenCalledWith({ eventId: "evt-1" }),
        );
      },
    );

    it("backing out of the confirm sends nothing", async () => {
      eventRef.status = "PUBLISHED";
      staffRef.roles = ["ADMIN"];
      renderBuilder();

      fireEvent.click(await screen.findByTestId("event-takedown-listing-btn"));
      fireEvent.click(screen.getByText("admin.ebGoBack"));
      expect(cancelEventSpy).not.toHaveBeenCalled();
    });
  });

  describe("rendered-output parity with the pre-change builder", () => {
    /**
     * `useId` counts renders per module instance, so the same tree emits
     * «r3» when it renders third and «r25» when it renders twenty-fifth.
     * That is a property of the test file's running order, not of the
     * component, and normalizing it is what keeps the diff about the markup.
     */
    const stableHtml = (html: string) => html.replace(/«r[0-9a-z]+»/g, "«id»");

    it("renders a DRAFT community listing exactly as before", async () => {
      eventRef.stewardship = "COMMUNITY";
      const { container } = renderBuilder();
      await screen.findByTestId("event-title");
      await screen.findByTestId("stub-prose-editor");

      await expect(stableHtml(container.innerHTML)).toMatchFileSnapshot(
        "./__snapshots__/builder-parity-community-draft.html",
      );
    });

    it("renders a DRAFT ticketed event exactly as before", async () => {
      const { container } = renderBuilder();
      await screen.findByTestId("event-title");
      await screen.findByTestId("stub-prose-editor");

      await expect(stableHtml(container.innerHTML)).toMatchFileSnapshot(
        "./__snapshots__/builder-parity-owned-draft.html",
      );
    });

    it("renders a PUBLISHED ticketed event exactly as before", async () => {
      eventRef.status = "PUBLISHED";
      const { container } = renderBuilder();
      await screen.findByTestId("event-title");
      await screen.findByTestId("stub-prose-editor");

      await expect(stableHtml(container.innerHTML)).toMatchFileSnapshot(
        "./__snapshots__/builder-parity-owned-published.html",
      );
    });
  });

  // ── The other half: the ticketed path must be untouched ─────────────────
  describe("a ticketed (OWNED) event — the mode must be inert", () => {
    it("still renders the lineup in its OWNED variant", async () => {
      renderBuilder();
      const lineup = await screen.findByTestId("stub-lineup-editor");
      expect(lineup).toHaveAttribute("data-community-mode", "false");
    });

    it("still renders every owned-event surface", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");

      for (const testId of OWNED_ONLY_SURFACES) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }
    });

    it("still keeps the category+tags section and the venue mode toggle", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");

      expect(screen.getByTestId("stub-category-tags")).toBeInTheDocument();
      expect(screen.queryByTestId("community-category-select")).toBeNull();
      expect(screen.getByTestId("stub-location-section")).toHaveAttribute(
        "data-community-mode",
        "false",
      );
    });

    it("still offers the body audio button", async () => {
      renderBuilder();

      expect(await screen.findByTestId("stub-prose-editor")).toHaveAttribute(
        "data-audio-button",
        "true",
      );
    });

    it("previews the TICKETED layout", async () => {
      renderBuilder({ initialViewMode: "preview" });

      expect(await screen.findByTestId("mock-event-preview")).toHaveAttribute(
        "data-community-layout",
        "false",
      );
    });

    it("is still editable when PUBLISHED (the read-only gate is community-only)", async () => {
      eventRef.status = "PUBLISHED";
      renderBuilder();

      expect(await screen.findByTestId("event-edit-layout")).toBeInTheDocument();
      expect(screen.getByTestId("event-save-btn")).toBeInTheDocument();
      expect(screen.queryByTestId("community-locked-notice")).toBeNull();
      // The live band is COMMUNITY-only: a published ticketed event has no
      // RSVP/save audience to notify through this path.
      expect(screen.queryByTestId("community-live-edit-notice")).toBeNull();
    });

    // Admin-level actions (unpublish / cancel / regenerate a published
    // slug) need `canManageEvent`, and a mount that does not pass it gets
    // none of them. The gate table itself is `builder-admin-action-gates`;
    // this pins the builder's wiring and its `false` default.
    describe("admin-level actions", () => {
      beforeEach(() => {
        settingsSectionsProps.canRegenerateSlug = undefined;
      });

      it("withholds Regenerate slug on a PUBLISHED event when canManageEvent is not passed", async () => {
        eventRef.status = "PUBLISHED";
        renderBuilder();

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.canRegenerateSlug).toBe(false);
      });

      it("offers Regenerate slug on a PUBLISHED event to a manager", async () => {
        eventRef.status = "PUBLISHED";
        renderBuilder({ canManageEvent: true });

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.canRegenerateSlug).toBe(true);
      });

      it("offers Regenerate slug on a DRAFT to any editor", async () => {
        renderBuilder();

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.canRegenerateSlug).toBe(true);
      });
    });

    // Ticket + application templates live in the EVENT owner's library. A
    // delegate's URL slug is their OWN workspace, so the builder must hand
    // both template surfaces its `ownerType`/`ownerId` (the event's owner),
    // never anything derived from `slug`.
    describe("template owner", () => {
      beforeEach(() => {
        templateOwnerProps.ticketEditor = undefined;
        templateOwnerProps.applicationBuilder = undefined;
        templateOwnerProps.canCustomiseTemplates = undefined;
      });

      // Customise (fork) asks the admin bar — exactly `canManageEvent`.
      it("withholds Customise when canManageEvent is not passed", async () => {
        renderBuilder();
        await screen.findByTestId("stub-ticket-editor");

        expect(templateOwnerProps.canCustomiseTemplates).toBe(false);
      });

      it("offers Customise to a viewer who can manage the event", async () => {
        renderBuilder({ canManageEvent: true });
        await screen.findByTestId("stub-ticket-editor");

        expect(templateOwnerProps.canCustomiseTemplates).toBe(true);
      });

      it.each([
        ["a principal human", "human", "h-principal", "HUMAN"],
        ["an org", "org", "org-1", "ORGANIZATION"],
      ] as const)(
        "a delegate on an event owned by %s scopes both template surfaces to it",
        async (_label, ownerType, ownerId, ownerScope) => {
          renderBuilder({ slug: "delegate-own-workspace", ownerType, ownerId });
          await screen.findByTestId("stub-ticket-editor");

          expect(templateOwnerProps.ticketEditor).toEqual({
            ownerScope,
            ownerId,
          });
          expect(templateOwnerProps.applicationBuilder).toEqual({
            ownerScope,
            ownerId,
          });
        },
      );
    });

    // `assignWaiverToEvent` refuses without an orgId, so a person-owned
    // event must not be offered the waiver picker even with the gate on —
    // every pick there failed and rolled back.
    describe("waiver picker", () => {
      beforeEach(() => {
        settingsSectionsProps.waiversEnabled = undefined;
        featureGates.gates = { waivers: true };
      });
      afterEach(() => {
        featureGates.gates = {};
      });

      it("is withheld on a person-owned event even with the waivers gate on", async () => {
        renderBuilder({ ownerType: "human", ownerId: "h-1" });

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.waiversEnabled).toBe(false);
      });

      it("is offered on an org-owned event with the waivers gate on", async () => {
        renderBuilder({ ownerType: "org", ownerId: "org-1" });

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.waiversEnabled).toBe(true);
      });

      it("is withheld on an org-owned event when the waivers gate is off", async () => {
        featureGates.gates = {};
        renderBuilder({ ownerType: "org", ownerId: "org-1" });

        await screen.findByTestId("stub-settings-sections");
        expect(settingsSectionsProps.waiversEnabled).toBe(false);
      });
    });
  });
});
