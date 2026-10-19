/**
 * The builder's unsaved-changes guard, in the real `EventBuilder`.
 *
 * Load is clean; an edit is dirty and says so beside Save; a save that
 * succeeds is clean again, except for what was typed while it was in flight;
 * the rail's `?section=` links scroll without a prompt; Escape and the
 * community Publish respect unsaved edits.
 *
 * Harness copied from `EventBuilderCommunityMode.test.tsx` (its community
 * save is the shortest path to a controllable save), with a prose-editor stub
 * that normalises its doc the way TipTap does.
 */
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

// Per-test knobs the mocks read. Reset in `beforeEach`.
const harness = vi.hoisted(() => ({
  isMobile: false,
  /**
   * The editor stub emits a server URL sync through onChange BEFORE onReady,
   * the order the real editor takes when the URL maps are already warm.
   */
  syncBeforeReady: false,
  /** Owned saves (`events.createEventForHuman`). */
  createHuman: vi.fn<[unknown], Promise<unknown>>(),
}));

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
          "aria-describedby": rest["aria-describedby"],
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
// The prose editor stub behaves like TipTap where it matters here: it reports
// its doc on mount NORMALISED (a filled-in attr the stored doc lacks), and
// every onChange emits that normalised shape.
vi.mock("../prose-editor", async () => {
  const React = await import("react");
  const normalise = (doc: unknown) => ({
    ...((doc as Record<string, unknown>) ?? { type: "doc" }),
    // A default WITH a value: null defaults are already ignored by the
    // body snapshot, so only this exercises the onReady seed.
    attrs: { indent: 0 },
  });
  /** A fresh presigned `src` on every image that has an upload behind it. */
  const resignImages = (doc: unknown): unknown => {
    if (Array.isArray(doc)) return doc.map(resignImages);
    if (!doc || typeof doc !== "object") return doc;
    const node = doc as Record<string, unknown>;
    const attrs = node.attrs as Record<string, unknown> | undefined;
    return {
      ...node,
      ...(node.type === "imageBlock" && attrs?.imageId
        ? { attrs: { ...attrs, src: `${String(attrs.src)}&resigned=1` } }
        : {}),
      ...(Array.isArray(node.content)
        ? { content: node.content.map(resignImages) }
        : {}),
    };
  };
  return {
    ProseEditor: ({
      initialContent,
      onChange,
      onReady,
    }: {
      initialContent?: unknown;
      onChange?: (doc: unknown) => void;
      onReady?: (doc: unknown) => void;
    }) => {
      // Seeded once, like TipTap: later `initialContent` props are ignored.
      const [seed] = React.useState(() => initialContent);
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => {
        if (!harness.syncBeforeReady) {
          onReady?.(normalise(seed));
          setReady(true);
          return;
        }
        // The real order with warm URL maps: the editor's URL-sync effect
        // dispatches (onChange) first, and TipTap's onCreate (onReady) runs
        // in a setTimeout(0) afterwards, reading the already-synced doc.
        const synced = normalise(resignImages(seed));
        onChange?.(synced);
        const id = setTimeout(() => {
          onReady?.(synced);
          setReady(true);
        }, 0);
        return () => clearTimeout(id);
        // Once per mount, like TipTap's onCreate.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement(
        "div",
        {
          "data-testid": "stub-prose-editor",
          "data-ready": String(ready),
        },
        React.createElement("button", {
          "data-testid": "stub-prose-type",
          onClick: () =>
            onChange?.({
              ...normalise(seed),
              content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
            }),
        }),
        React.createElement("button", {
          "data-testid": "stub-prose-undo",
          onClick: () => onChange?.(normalise(seed)),
        }),
      );
    },
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

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => harness.isMobile,
}));
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
vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: () => null,
}));

// `StableActionLabel` renders Tamagui's `ButtonText`, which the `tamagui` mock
// above does not carry. The builder specs care about which label is showing,
// not about the width-reserving cell.
vi.mock("../StableActionLabel", () => ({
  StableActionLabel: ({
    idle,
    busy,
    pending,
    icon,
  }: {
    idle: string;
    busy: string;
    pending: boolean;
    icon?: ReactNode;
  }) => (
    <>
      {icon}
      {pending ? busy : idle}
    </>
  ),
}));
vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => () => false,
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
  publishListingSpy,
} = vi.hoisted(() => {
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
    /** The stored body (`getEventForEdit.content`). */
    content: null as Record<string, unknown> | null,
  };

  const publishListingSpy = vi.fn<[{ eventId: string }], Promise<unknown>>();

  return {
    query,
    mutation,
    EVENT_FOR_EDIT,
    eventRef,
    updateListingSpy,
    publishListingSpy,
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
    const key = `${eventRef.stewardship}:${eventRef.status}:${eventRef.startsAt}:${eventRef.placeId}:${JSON.stringify(eventRef.content)}`;
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
            content: eventRef.content,
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
  const mutationResult = mutation();
  const useMutation = () => mutationResult;
  return {
    trpc: {
      useUtils: () => chain,
      events: {
        getEventForEdit: { useQuery: () => getEventForEditResult() },
        listTicketTypesForEdit: { useQuery: () => ticketTypesResult },
        getGateState: { useQuery: () => gateStateResult },
        getEventProvenance: { useQuery: () => emptyResult },
        resolveImages: { useQuery: () => emptyResult },
        resolveAudio: { useQuery: () => audioResult },
        createEventForHuman: {
          useMutation: () => ({
            mutate: () => undefined,
            mutateAsync: harness.createHuman,
            isPending: false,
          }),
        },
        createEventForOrg: { useMutation },
        requestImageUpload: { useMutation },
        finalizeImageUpload: { useMutation },
        publishEvent: { useMutation },
        unpublishEvent: { useMutation },
        cancelEvent: { useMutation },
      },
      community: {
        updateListing: {
          useMutation: () => ({
            mutate: () => undefined,
            mutateAsync: updateListingSpy,
            isPending: false,
          }),
        },
        publishListing: {
          useMutation: () => ({
            mutate: () => undefined,
            mutateAsync: publishListingSpy,
            isPending: false,
          }),
        },
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
      platform: { checkStaffAccess: { useQuery: () => emptyResult } },
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

import { guardedNavigate } from "@/hooks/navigation-guard";

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


const FUTURE_START = "2099-08-01T20:00:00.000Z";

const status = () => screen.getByTestId("event-unsaved-status");
const isDirty = () => status().textContent === "admin.ebUnsavedChanges";
const typeTitle = (value: string) =>
  fireEvent.change(screen.getByTestId("event-title"), {
    target: { value },
  });

/** Clicks a same-origin link; reports whether something held it. */
const clickLink = (href: string) => {
  const a = document.createElement("a");
  a.href = href;
  document.body.appendChild(a);
  let held = false;
  const probe = (ev: Event) => {
    held = ev.defaultPrevented;
    // jsdom would otherwise try to navigate.
    ev.preventDefault();
  };
  document.addEventListener("click", probe, true);
  act(() => {
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  document.removeEventListener("click", probe, true);
  a.remove();
  return held;
};

/** Waits until the load baseline exists (the starter row appears with it). */
const loaded = async () => {
  await screen.findByTestId("event-title");
  await screen.findByTestId("stub-prose-editor");
  await screen.findByTestId("description-starters");
};

describe("EventBuilder: unsaved changes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    updateListingSpy.mockReset();
    updateListingSpy.mockResolvedValue({});
    publishListingSpy.mockReset();
    publishListingSpy.mockResolvedValue({
      changed: true,
      event: { id: "evt-1", slug: "saved-title" },
    });
    eventRef.stewardship = "COMMUNITY";
    eventRef.status = "DRAFT";
    eventRef.startsAt = FUTURE_START;
    eventRef.placeId = null;
    eventRef.place = null;
    eventRef.content = null;
    harness.isMobile = false;
    harness.syncBeforeReady = false;
    harness.createHuman.mockReset();
    harness.createHuman.mockResolvedValue({ eventId: "evt-1" });
    stubProps.locationSection = undefined;
    stubProps.preview = undefined;
    toastSpies.danger.mockReset();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
  });

  it("is clean on load, with the status region already mounted", async () => {
    renderBuilder();
    await loaded();
    expect(status()).toHaveAttribute("role", "status");
    expect(isDirty()).toBe(false);
  });

  it("an edit is dirty, and undoing it is clean", async () => {
    renderBuilder();
    await loaded();
    typeTitle("Saved Title!");
    expect(isDirty()).toBe(true);
    typeTitle("Saved Title");
    expect(isDirty()).toBe(false);
  });

  it("measures the description in the editor's normalised shape", async () => {
    renderBuilder();
    await loaded();
    fireEvent.click(screen.getByTestId("stub-prose-type"));
    expect(isDirty()).toBe(true);
    // Back to the mounted doc: the editor emits its normalised form, which
    // must not read as an edit of the raw stored doc.
    fireEvent.click(screen.getByTestId("stub-prose-undo"));
    expect(isDirty()).toBe(false);
  });

  it("a successful save is clean", async () => {
    renderBuilder();
    await loaded();
    typeTitle("Renamed");
    expect(isDirty()).toBe(true);
    fireEvent.click(screen.getByTestId("event-save-btn"));
    await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isDirty()).toBe(false));
  });

  it("an edit typed while the save is in flight stays unsaved", async () => {
    let resolveSave: (v: unknown) => void = () => undefined;
    updateListingSpy.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    renderBuilder();
    await loaded();
    typeTitle("Renamed");
    fireEvent.click(screen.getByTestId("event-save-btn"));
    await waitFor(() => expect(updateListingSpy).toHaveBeenCalledTimes(1));
    typeTitle("Renamed again");
    await act(() => {
      resolveSave({});
      return Promise.resolve();
    });
    expect(isDirty()).toBe(true);
    // And it is exactly the late edit that is unsaved.
    typeTitle("Renamed");
    expect(isDirty()).toBe(false);
  });

  it("a rail ?section= link scrolls without a prompt; another page is held", async () => {
    renderBuilder();
    await loaded();
    typeTitle("Renamed");
    expect(clickLink("/admin/acme-co/events/evt-1/edit?section=details")).toBe(
      false,
    );
    expect(screen.queryByTestId("event-unsaved-dialog")).toBeNull();
    expect(clickLink("/admin/acme-co/events")).toBe(true);
    expect(screen.getByTestId("event-unsaved-dialog")).toBeInTheDocument();
  });

  it("Escape with unsaved edits asks first, and leaves on discard", async () => {
    const onCancel = vi.fn();
    renderBuilder({ onCancel });
    await loaded();
    typeTitle("Renamed");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("event-unsaved-leave"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape on a clean form leaves at once", async () => {
    const onCancel = vi.fn();
    renderBuilder({ onCancel });
    await loaded();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("event-unsaved-dialog")).toBeNull();
  });

  it("community Publish refuses while there are unsaved edits", async () => {
    renderBuilder();
    await loaded();
    typeTitle("Renamed");
    fireEvent.click(screen.getByTestId("event-publish-btn"));
    await act(() => Promise.resolve());
    expect(publishListingSpy).not.toHaveBeenCalled();
    typeTitle("Saved Title");
    fireEvent.click(screen.getByTestId("event-publish-btn"));
    await waitFor(() => expect(publishListingSpy).toHaveBeenCalledTimes(1));
  });

  it("a shell navigation (bottom bar, drawer) while dirty asks first", async () => {
    renderBuilder();
    await loaded();
    typeTitle("Renamed");
    const go = vi.fn();
    act(() => guardedNavigate(go));
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByTestId("event-unsaved-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("event-unsaved-stay"));
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByTestId("event-title")).toHaveValue("Renamed");
    act(() => guardedNavigate(go));
    fireEvent.click(screen.getByTestId("event-unsaved-leave"));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("a shell navigation on a clean form goes straight through", async () => {
    renderBuilder();
    await loaded();
    const go = vi.fn();
    act(() => guardedNavigate(go));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("event-unsaved-dialog")).toBeNull();
  });

  it("stops guarding shell navigation once the builder unmounts", async () => {
    const { unmount } = renderBuilder();
    await loaded();
    typeTitle("Renamed");
    unmount();
    const go = vi.fn();
    guardedNavigate(go);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("a stored body with an uploaded image loads clean when the editor re-signs URLs before onReady", async () => {
    harness.syncBeforeReady = true;
    eventRef.content = {
      blocks: [
        {
          type: "richText",
          doc: {
            type: "doc",
            content: [
              {
                type: "imageBlock",
                attrs: { imageId: "img-1", src: "https://minio/img-1?sig=old" },
              },
            ],
          },
        },
      ],
    };
    renderBuilder();
    await loaded();
    await waitFor(() =>
      expect(screen.getByTestId("stub-prose-editor")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    expect(isDirty()).toBe(false);
    // And it still notices a real edit.
    typeTitle("Renamed");
    expect(isDirty()).toBe(true);
  });

  describe("an owned event", () => {
    beforeEach(() => {
      eventRef.stewardship = "OWNED";
    });

    it("a successful save is clean", async () => {
      renderBuilder();
      await screen.findByTestId("event-title");
      await screen.findByTestId("description-starters");
      typeTitle("Renamed");
      expect(isDirty()).toBe(true);
      fireEvent.click(screen.getByTestId("event-save-btn"));
      await waitFor(() => expect(harness.createHuman).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(isDirty()).toBe(false));
    });

    it("an edit typed while the save is in flight stays unsaved", async () => {
      let resolveSave: (v: unknown) => void = () => undefined;
      harness.createHuman.mockImplementation(
        () => new Promise((resolve) => (resolveSave = resolve)),
      );
      renderBuilder();
      await screen.findByTestId("event-title");
      await screen.findByTestId("description-starters");
      typeTitle("Renamed");
      fireEvent.click(screen.getByTestId("event-save-btn"));
      await waitFor(() => expect(harness.createHuman).toHaveBeenCalledTimes(1));
      typeTitle("Renamed again");
      await act(() => {
        resolveSave({ eventId: "evt-1" });
        return Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByTestId("event-save-btn")).toHaveTextContent(
          "pageActions.save",
        ),
      );
      expect(isDirty()).toBe(true);
      typeTitle("Renamed");
      expect(isDirty()).toBe(false);
    });
  });

  describe("on a phone", () => {
    beforeEach(() => {
      harness.isMobile = true;
    });

    it("shows a dot on Save and describes Save with the status, keeping the name", async () => {
      renderBuilder();
      await loaded();
      const save = screen.getByTestId("event-save-btn");
      expect(screen.queryByTestId("event-unsaved-dot")).toBeNull();
      expect(save).not.toHaveAttribute("aria-describedby");

      typeTitle("Renamed");
      expect(screen.getByTestId("event-unsaved-dot")).toBeInTheDocument();
      expect(save).toHaveTextContent(/^pageActions\.save$/);
      const describedBy = save.getAttribute("aria-describedby");
      expect(describedBy).toBe(status().id);
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        "admin.ebUnsavedChanges",
      );
      // The caption itself is visually hidden on a phone.
      expect(status()).toHaveStyle({ position: "absolute", width: "1px" });
    });
  });
});
