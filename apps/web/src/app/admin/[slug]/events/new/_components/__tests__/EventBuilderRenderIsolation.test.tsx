/**
 * Re-render isolation (perf refactor, 2026-07-29).
 *
 * EventBuilder holds ~50 useState fields, so every keystroke re-renders the
 * component itself — that is by design and can't change without moving state
 * out of the save/publish/readiness paths. What CAN change is how much tree it
 * re-renders: the authoring surface now lives in memoized sibling components
 * that take only stable props.
 *
 * These tests assert the two properties that make that hold:
 *   1. typing in Title re-renders ONLY the Essentials section — Details and
 *      Settings bail out (i.e. EventBuilder hands them stable props);
 *   2. toggling a settings accordion re-renders neither (the group owns its own
 *      open state) while the imperative `open()` handle still forces it open
 *      for deep links.
 *
 * Method: the three extracted sections are replaced by `React.memo`'d probes
 * that count their own renders. Since the probes are memoized exactly like the
 * real components, a probe render means EventBuilder passed a prop with a NEW
 * identity — which is precisely the regression to catch. A separate assertion
 * checks the real modules still export memoized components.
 */
import { type ReactNode, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
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
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
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
  const stableT = (key: string) => key;
  const stableNotify = {
    toast: {
      info: noop,
      success: noop,
      warning: noop,
      danger: noop,
      neutral: noop,
    },
  };
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
    // Stable identities, like the real hooks (`useCallback` / `useMemo`): the
    // builder's copy handler closes over both, and the Settings probe must
    // see the same prop each render for the isolation count to mean anything.
    useTranslations: () => stableT,
    useLocale: () => "en",
    useNotify: () => stableNotify,
  };
});

vi.mock("next/dynamic", () => ({ default: () => () => null }));

// ── The probes: memoized stand-ins that count their own renders ───────────

const counts = vi.hoisted(() => ({ essentials: 0, details: 0, settings: 0 }));

vi.mock("../BuilderEssentialsSection", async () => {
  const React = await import("react");
  const Probe = React.memo(function EssentialsProbe({
    title,
    onTitleChange,
  }: {
    title: string;
    onTitleChange: (value: string) => void;
  }) {
    counts.essentials += 1;
    return React.createElement("input", {
      "data-testid": "event-title",
      value: title,
      onChange: (e: { target: { value: string } }) =>
        onTitleChange(e.target.value),
    });
  });
  return { BuilderEssentialsSection: Probe };
});

vi.mock("../BuilderDetailsSection", async () => {
  const React = await import("react");
  const Probe = React.memo(function DetailsProbe() {
    counts.details += 1;
    return null;
  });
  return { BuilderDetailsSection: Probe };
});

vi.mock("../BuilderSettingsSections", async () => {
  const React = await import("react");
  const Probe = React.memo(function SettingsProbe() {
    counts.settings += 1;
    return null;
  });
  return { BuilderSettingsSections: Probe };
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
// Owns its own tRPC query and its own suite; stubbed here so this file's
// enumerated `@th/ui` / `@/trpc` mocks don't have to grow a surface they aren't
// asserting on.
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

const { query, mutation, EVENT_FOR_EDIT } = vi.hoisted(() => {
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
    placeId: null,
    place: null,
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

  return { query, mutation, EVENT_FOR_EDIT };
});

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  // Result objects are created ONCE and returned by identity on every render,
  // mirroring React Query's structural sharing of `data`.
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
        getEventProvenance: { useQuery: () => emptyResult },
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
import { SettingsGroup, type SettingsGroupHandle } from "../SettingsGroup";

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

describe("EventBuilder re-render isolation", () => {
  beforeEach(() => {
    counts.essentials = 0;
    counts.details = 0;
    counts.settings = 0;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
  });

  it("re-renders ONLY the Essentials section while the title is typed", async () => {
    renderBuilder();

    const titleInput = await screen.findByTestId("event-title");
    expect(titleInput).toHaveValue("Saved Title");

    const essentialsAtRest = counts.essentials;
    const detailsAtRest = counts.details;
    const settingsAtRest = counts.settings;
    // Guard against a vacuous pass: every section must actually have mounted.
    expect(detailsAtRest).toBeGreaterThan(0);
    expect(settingsAtRest).toBeGreaterThan(0);

    fireEvent.change(titleInput, { target: { value: "Saved Title A" } });
    fireEvent.change(titleInput, { target: { value: "Saved Title AB" } });
    fireEvent.change(titleInput, { target: { value: "Saved Title ABC" } });

    expect(screen.getByTestId("event-title")).toHaveValue("Saved Title ABC");

    // The section that owns the field re-renders (it has to — it shows it)…
    expect(counts.essentials).toBeGreaterThan(essentialsAtRest);
    // …and every other section bails out: no prop identity churned.
    expect(counts.details).toBe(detailsAtRest);
    expect(counts.settings).toBe(settingsAtRest);
  });

  it("re-renders no section when a settings accordion is toggled", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    const essentialsAtRest = counts.essentials;
    const detailsAtRest = counts.details;
    const settingsAtRest = counts.settings;
    expect(essentialsAtRest).toBeGreaterThan(0);
    expect(detailsAtRest).toBeGreaterThan(0);
    expect(settingsAtRest).toBeGreaterThan(0);

    // The no-lineup Revenue-splits disclosure is a real (uncontrolled)
    // SettingsGroup rendered by the builder itself.
    const splitsHeader = screen.getByTestId("advanced-section-splits");
    expect(splitsHeader).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(splitsHeader);
    expect(
      screen.getByTestId("advanced-section-splits"),
    ).toHaveAttribute("aria-expanded", "true");

    expect(counts.essentials).toBe(essentialsAtRest);
    expect(counts.details).toBe(detailsAtRest);
    expect(counts.settings).toBe(settingsAtRest);
  });

  it("still exports memoized section components", async () => {
    const memoType = Symbol.for("react.memo");
    const essentials = await vi.importActual<
      typeof import("../BuilderEssentialsSection")
    >("../BuilderEssentialsSection");
    const details = await vi.importActual<
      typeof import("../BuilderDetailsSection")
    >("../BuilderDetailsSection");
    const settings = await vi.importActual<
      typeof import("../BuilderSettingsSections")
    >("../BuilderSettingsSections");

    for (const component of [
      essentials.BuilderEssentialsSection,
      details.BuilderDetailsSection,
      settings.BuilderSettingsSections,
    ]) {
      expect((component as unknown as { $$typeof: symbol }).$$typeof).toBe(
        memoType,
      );
    }
    // `vi.importActual` pulls in each section's REAL module graph (Tamagui,
    // the prose editor, the map stack) with no mocks — that transform alone
    // can exceed vitest's 5s default on a loaded machine, so this one test
    // gets an explicit budget. It is a structural assertion, not a perf one.
  }, 30_000);
});

describe("SettingsGroup disclosure ownership", () => {
  function Harness({
    onRender,
    groupRef,
  }: {
    onRender: () => void;
    groupRef: { current: SettingsGroupHandle | null };
  }) {
    onRender();
    return (
      <SettingsGroup ref={groupRef} label="Access" testId="group-header">
        <div data-testid="group-body">body</div>
      </SettingsGroup>
    );
  }

  it("owns its open state — a header click never re-renders the parent", () => {
    const onRender = vi.fn();

    function Parent() {
      const groupRef = useRef<SettingsGroupHandle | null>(null);
      return <Harness onRender={onRender} groupRef={groupRef} />;
    }

    render(<Parent />);
    const parentRenders = onRender.mock.calls.length;

    expect(screen.queryByTestId("group-body")).toBeNull();
    fireEvent.click(screen.getByTestId("group-header"));
    expect(screen.getByTestId("group-body")).toBeInTheDocument();

    expect(onRender.mock.calls.length).toBe(parentRenders);
  });

  it("exposes an imperative open() for deep links, and honours defaultOpen", () => {
    function Deep() {
      const groupRef = useRef<SettingsGroupHandle | null>(null);
      const [, force] = useState(0);
      return (
        <>
          <button
            data-testid="jump"
            onClick={() => {
              groupRef.current?.open();
              force((n) => n + 1);
            }}
          >
            jump
          </button>
          <SettingsGroup ref={groupRef} label="Access" testId="group-header">
            <div data-testid="group-body">body</div>
          </SettingsGroup>
        </>
      );
    }

    render(<Deep />);
    expect(screen.queryByTestId("group-body")).toBeNull();

    fireEvent.click(screen.getByTestId("jump"));
    expect(screen.getByTestId("group-body")).toBeInTheDocument();
    expect(screen.getByTestId("group-header")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Idempotent: opening an already-open group keeps it open.
    fireEvent.click(screen.getByTestId("jump"));
    expect(screen.getByTestId("group-body")).toBeInTheDocument();
  });

  it("starts expanded when defaultOpen is set (the ?section=scheduling link)", () => {
    render(
      <SettingsGroup label="Scheduling" testId="group-header" defaultOpen>
        <div data-testid="group-body">body</div>
      </SettingsGroup>,
    );
    expect(screen.getByTestId("group-body")).toBeInTheDocument();
  });
});
