/**
 * In-view preview toggle (D4 reversed, 2026-07-28): the Edit|Preview
 * segmented control swaps the builder's main column to EventPreview fed with
 * the CURRENT in-memory form state — the key property being that UNSAVED
 * edits preview live (the new-tab link only ever showed saved state).
 *
 * EventBuilder's heavy children and data layer are stubbed; the toggle, the
 * form state plumbing, and the display:none edit-column preservation are
 * exercised for real.
 */
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
        danger: noop,
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

vi.mock("../EventPreview", async () => {
  const React = await import("react");
  return {
    EventPreview: ({ title }: { title: string }) =>
      React.createElement(
        "div",
        { "data-testid": "mock-event-preview" },
        title,
      ),
  };
});
vi.mock("../SeatingLayoutEditor", () => ({ SeatingLayoutEditor: () => null }));
vi.mock("../ApplicationFormBuilder", () => ({
  ApplicationFormBuilder: () => null,
}));
vi.mock("../TicketTypeEditor", () => ({ TicketTypeEditor: () => null }));
vi.mock("../LineupEditor", () => ({ LineupEditor: () => null }));
vi.mock("../SplitsEditor", () => ({ SplitsEditor: () => null }));
vi.mock("../RecurrenceBuilder", () => ({ RecurrenceBuilder: () => null }));
vi.mock("../SeriesEditScopeDialog", () => ({
  SeriesEditScopeDialog: () => null,
}));
vi.mock("../EventGateSettings", () => ({ EventGateSettings: () => null }));
vi.mock("../EventSlugSection", () => ({ EventSlugSection: () => null }));
vi.mock("../EventFinanceSettings", () => ({
  EventFinanceSettings: () => null,
}));
vi.mock("../HeroImageField", () => ({ HeroImageField: () => null }));
vi.mock("../LocationSection", () => ({ LocationSection: () => null }));
vi.mock("../LocationVisibilitySection", () => ({
  LocationVisibilitySection: () => null,
}));
vi.mock("../CategoryTagsSection", () => ({ CategoryTagsSection: () => null }));
vi.mock("../EventWaiverSection", () => ({ EventWaiverSection: () => null }));
vi.mock("../EventTaxSection", () => ({ EventTaxSection: () => null }));
// Owns its own tRPC query and its own suite; stubbed here so this file's
// enumerated `@th/ui` / `@/trpc` mocks don't have to grow a surface they aren't
// asserting on.
vi.mock("../EventProvenanceNote", () => ({ EventProvenanceNote: () => null }));
// Stubbed to a marker div: the rail's internals are unit-tested in
// event-readiness / readiness-input; here we assert WHETHER the builder
// renders it (DRAFT-only), in which variant, and which blockers the builder
// hands it (`data-blockers`).
vi.mock("../PublishReadinessRail", async () => {
  const React = await import("react");
  return {
    PublishReadinessRail: ({
      variant,
      readiness,
    }: {
      variant: string;
      readiness: { blockers: Array<{ id: string }> };
    }) =>
      React.createElement("div", {
        "data-testid": `stub-readiness-${variant}`,
        "data-blockers": readiness.blockers.map((item) => item.id).join(","),
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
vi.mock("../prose-editor", () => ({
  ProseEditor: () => null,
  createEmptyDoc: () => ({ type: "doc", content: [] }),
  hasContent: () => false,
}));
vi.mock("../_form-bits", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Field: Passthrough,
    FieldLabel: Passthrough,
    NativeDateTimeInput: (props: Record<string, unknown>) =>
      React.createElement("input", {
        "data-testid": props["data-testid"],
        readOnly: true,
        value: String(props.value ?? ""),
      }),
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
// The header's `⋯` menu, flattened to one plain button per item (no
// role="menu", so the Escape specs below stay honest) — enough to press
// "Open preview in a new tab" / "View event" and see where they go.
vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: ({
    items,
  }: {
    items: Array<{ key: string; testId?: string; onPress: () => void }>;
  }) => (
    <div>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          data-testid={item.testId}
          onClick={item.onPress}
        />
      ))}
    </div>
  ),
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
// vi.hoisted: the @/trpc mock factory below runs during EventBuilder's
// (hoisted) import — plain module-level consts would still be in TDZ then.

const { query, mutation, EVENT_FOR_EDIT, eventStatusRef, chargebackRef } =
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

  // Mutable so a test can flip the event's status before rendering (the
  // publish-readiness rail is DRAFT-only). Reset in `beforeEach`.
  const eventStatusRef = { current: "DRAFT" };

  // Chargeback-terms wiring: an org-owned event with a paid tier, and the
  // org record `orgs.getOrg` answers with. Reset in `beforeEach`.
  const chargebackRef = {
    orgOwned: false,
    paidTicketType: false,
    orgRecord: undefined as Record<string, unknown> | undefined,
  };

  return { query, mutation, EVENT_FOR_EDIT, eventStatusRef, chargebackRef };
});

vi.mock("@/trpc", () => {
  // Infinitely chainable + callable proxy for trpc.useUtils().
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  // Result objects are created ONCE and returned by identity on every render
  // — mirroring React Query's structural sharing. Fresh objects per render
  // would retrigger EventBuilder's identity-keyed effects (e.g. the
  // resolveAudio → setAudioUrlMap sync) into an infinite setState loop.
  //
  // The edit payload is cached PER STATUS so a test can flip `eventStatusRef`
  // before rendering (the readiness rail is DRAFT-only) without ever handing
  // React a fresh object on a re-render.
  const eventForEditByStatus = new Map<string, unknown>();
  const getEventForEditResult = () => {
    const status = eventStatusRef.current;
    const key = `${status}:${chargebackRef.orgOwned ? "org" : "human"}`;
    if (!eventForEditByStatus.has(key)) {
      eventForEditByStatus.set(
        key,
        query({
          data: {
            ...EVENT_FOR_EDIT,
            status,
            ...(chargebackRef.orgOwned
              ? { orgId: "org-1", humanId: null }
              : {}),
          },
          isSuccess: true,
        }),
      );
    }
    return eventForEditByStatus.get(key);
  };
  const ticketTypesResult = query({
    data: { ticketTypes: [] },
    isSuccess: true,
  });
  const paidTicketTypesResult = query({
    data: {
      ticketTypes: [
        {
          id: "tt-1",
          priceCents: 2000,
          scheduledPriceCents: null,
          pricingMode: "FIXED",
        },
      ],
    },
    isSuccess: true,
  });
  const orgByKey = new Map<string, unknown>();
  const getOrgResult = () => {
    const key = JSON.stringify(chargebackRef.orgRecord ?? null);
    if (!orgByKey.has(key)) {
      orgByKey.set(
        key,
        query({ data: chargebackRef.orgRecord, isSuccess: true }),
      );
    }
    return orgByKey.get(key);
  };
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
        getEventForEdit: { useQuery: () => getEventForEditResult() },
        listTicketTypesForEdit: {
          useQuery: () =>
            chargebackRef.paidTicketType
              ? paidTicketTypesResult
              : ticketTypesResult,
        },
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
      eventHumans: {
        list: { useQuery: () => lineupResult },
      },
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
        getOrg: { useQuery: () => getOrgResult() },
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

describe("EventBuilder in-view preview toggle (D4 reversed)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    eventStatusRef.current = "DRAFT";
    chargebackRef.orgOwned = false;
    chargebackRef.paidTicketType = false;
    chargebackRef.orgRecord = undefined;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");
  });

  it("swaps the main column to EventPreview showing UNSAVED in-memory edits, keeping the edit column mounted", async () => {
    renderBuilder();

    // Form hydrated from the edit payload.
    const titleInput = await screen.findByTestId("event-title");
    expect(titleInput).toHaveValue("Saved Title");

    // Make an UNSAVED edit.
    fireEvent.change(titleInput, { target: { value: "Unsaved Title" } });

    // Toggle to Preview.
    const pushSpy = vi.spyOn(window.history, "pushState");
    const previewSegment = screen.getByTestId("view-mode-preview");
    expect(previewSegment).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(previewSegment);

    // The preview renders the CURRENT form state — unsaved title included.
    const preview = await screen.findByTestId("mock-event-preview");
    expect(preview).toHaveTextContent("Unsaved Title");
    expect(screen.getByTestId("view-mode-preview")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Edit chrome is hidden (not unmounted): form state survives.
    expect(screen.getByTestId("event-edit-layout")).toHaveStyle({
      display: "none",
    });
    expect(screen.getByTestId("event-title")).toHaveValue("Unsaved Title");

    // Shallow URL sync: entering preview PUSHES a marked entry (so browser
    // Back returns to the editor) rather than replacing in place.
    expect(window.location.search).toContain("view=preview");
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0]?.[0]).toEqual({ thPreview: true });

    // Toggle back: edit column visible again, state intact, preview gone.
    fireEvent.click(screen.getByTestId("view-mode-edit"));
    expect(screen.getByTestId("event-edit-layout")).not.toHaveStyle({
      display: "none",
    });
    expect(screen.queryByTestId("event-preview-surface")).toBeNull();
    expect(screen.getByTestId("event-title")).toHaveValue("Unsaved Title");
    // Exit pops our pushed entry — the URL restore is async (popstate).
    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
  });

  it("exits preview back to the editor on browser Back (popstate to the edit URL)", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    // Enter preview via the toggle → pushes the preview entry.
    fireEvent.click(screen.getByTestId("view-mode-preview"));
    await screen.findByTestId("mock-event-preview");
    expect(window.location.search).toContain("view=preview");

    // The user hits the browser Back button.
    window.history.back();

    // Back lands on the edit entry: preview closes IN PLACE (the builder
    // stays mounted — no route exit), edit column visible again.
    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("event-edit-layout")).not.toHaveStyle({
        display: "none",
      }),
    );
    expect(screen.queryByTestId("event-preview-surface")).toBeNull();
    expect(screen.getByTestId("view-mode-preview")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("pops its own pushed entry (history.back) when exiting via the toggle", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    fireEvent.click(screen.getByTestId("view-mode-preview"));
    await screen.findByTestId("mock-event-preview");

    const backSpy = vi.spyOn(window.history, "back");
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByTestId("view-mode-edit"));

    // Toggle-exit pops the entry we pushed — never replaceState (which
    // would strand the stale preview entry behind the editor).
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
    // The pop is swallowed by the re-entrancy guard: still in edit mode.
    expect(screen.getByTestId("event-edit-layout")).not.toHaveStyle({
      display: "none",
    });
  });

  it("falls back to replaceState on toggle-exit when the URL no longer says preview (Back+toggle race)", async () => {
    renderBuilder();
    await screen.findByTestId("event-title");

    // Enter preview via the toggle → pushes the preview entry.
    fireEvent.click(screen.getByTestId("view-mode-preview"));
    await screen.findByTestId("mock-event-preview");

    // Simulate a queued browser-Back traversal having already landed on the
    // edit URL (location updated) BEFORE its popstate reaches our listener:
    // rewrite the URL out from under the toggle without firing popstate.
    // (jsdom applies real history.back() fully async — URL + popstate
    // together — so the landed-but-unprocessed window can't occur naturally
    // here; this pins the guard's behaviour for that window.)
    window.history.replaceState({}, "", "/admin/acme-co/events/evt-1/edit");

    const backSpy = vi.spyOn(window.history, "back");
    fireEvent.click(screen.getByTestId("view-mode-edit"));

    // A second history.back() would land one entry too far — outside the
    // builder. The guard must rewrite in place instead.
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("view=preview");
    expect(screen.getByTestId("event-edit-layout")).not.toHaveStyle({
      display: "none",
    });
  });

  it("exits a DEEP-LINKED preview via replaceState — no history.back into a foreign entry", async () => {
    // Deep link: the preview URL is the FIRST entry — nothing of ours behind it.
    window.history.replaceState(
      {},
      "",
      "/admin/acme-co/events/evt-1/edit?view=preview",
    );
    renderBuilder({ initialViewMode: "preview" });
    await screen.findByTestId("mock-event-preview");

    const backSpy = vi.spyOn(window.history, "back");
    fireEvent.click(screen.getByTestId("view-mode-edit"));

    // No pushed entry to pop → rewrite in place instead of navigating away.
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("view=preview");
    expect(screen.getByTestId("event-edit-layout")).not.toHaveStyle({
      display: "none",
    });
  });

  it("opens directly in preview via initialViewMode (the ?view=preview deep link)", async () => {
    renderBuilder({ initialViewMode: "preview" });

    const preview = await screen.findByTestId("mock-event-preview");
    await waitFor(() => expect(preview).toHaveTextContent("Saved Title"));
    expect(screen.getByTestId("event-edit-layout")).toHaveStyle({
      display: "none",
    });
    expect(screen.getByTestId("view-mode-preview")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Escape leaves the builder even with a hidden role=menu in the DOM", async () => {
    // `ShareDropdown` / `CalendarDropdown` render `role="menu"` permanently
    // (CSS-hidden) inside the in-place preview. A DOM guard on that role
    // shielded Escape on every preview — the `⋯` menu protects itself by
    // stopping propagation at `document` instead (RowActionMenu.test.tsx).
    const onCancel = vi.fn();
    renderBuilder({ onCancel });
    await screen.findByTestId("event-title");

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      menu.remove();
    }
  });

  it("Escape is still owned by an open dialog", async () => {
    const onCancel = vi.fn();
    renderBuilder({ onCancel });
    await screen.findByTestId("event-title");

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("never shows the toggle to read-only viewers (preview IS their surface)", async () => {
    renderBuilder({ canEditEvent: false });

    await screen.findByTestId("mock-event-preview");
    expect(screen.queryByTestId("event-view-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("event-edit-layout")).toBeNull();
  });

  // ── The `⋯` menu's ways to look at the event ────────────────────────────
  describe("opening the event in a new tab", () => {
    it("opens a DRAFT in the builder's own preview, never the anonymous public page", async () => {
      // `/events/<slug>` reads anonymously and refuses a draft (N3), and the
      // UUID fallback 500'd before that. The editor's own preview route reads
      // with their session.
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      renderBuilder();

      fireEvent.click(await screen.findByTestId("event-preview-link"));

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        "/admin/acme-co/events/evt-1/edit?view=preview",
        "_blank",
        "noopener,noreferrer",
      );
    });

    it("opens a PUBLISHED event's public page from View event", async () => {
      eventStatusRef.current = "PUBLISHED";
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      renderBuilder();

      fireEvent.click(await screen.findByTestId("event-view-live"));

      expect(open).toHaveBeenCalledWith(
        "/events/saved-title",
        "_blank",
        "noopener,noreferrer",
      );
      // The draft item is gone once live — the two are never both offered.
      expect(screen.queryByTestId("event-preview-link")).toBeNull();
    });
  });

  // ── Publish-readiness rail is a PRE-publish checklist (FR-104) ──────────
  describe("publish-readiness rail", () => {
    it("renders on a DRAFT event", async () => {
      renderBuilder();

      expect(await screen.findByTestId("stub-readiness-rail")).toBeVisible();
    });

    it("is hidden once the event is PUBLISHED", async () => {
      eventStatusRef.current = "PUBLISHED";
      renderBuilder();

      // The builder itself rendered (so this isn't a false negative from an
      // unmounted tree), but the "Ready to publish?" checklist is gone: it
      // framed a live event as unpublished, and when the stored acceptance is
      // unreadable its chargeback-terms item is a blocker no one can clear.
      await screen.findByTestId("event-title");
      expect(screen.queryByTestId("stub-readiness-rail")).toBeNull();
      expect(screen.queryByTestId("stub-readiness-summary")).toBeNull();
    });

    // The reported bug: terms accepted on the payouts page still showed as a
    // blocker here, because the rail read only an in-builder acceptance.
    describe("chargeback terms on an org event with a paid tier", () => {
      const renderOrgEvent = () =>
        renderBuilder({ ownerType: "org", ownerId: "org-1" });

      beforeEach(() => {
        chargebackRef.orgOwned = true;
        chargebackRef.paidTicketType = true;
      });

      it("a stored acceptance of the current version clears the blocker", async () => {
        chargebackRef.orgRecord = {
          id: "org-1",
          // The version the suite's chargeback-terms mock calls current.
          chargebackTermsVersion: "v1",
          chargebackTermsAcceptedAt: "2026-10-12T15:00:00.000Z",
        };
        renderOrgEvent();

        const rail = await screen.findByTestId("stub-readiness-rail");
        expect(rail.dataset.blockers?.split(",")).not.toContain(
          "chargebackTerms",
        );
      });

      it("a never-accepted record leaves the blocker", async () => {
        chargebackRef.orgRecord = {
          id: "org-1",
          chargebackTermsVersion: null,
          chargebackTermsAcceptedAt: null,
        };
        renderOrgEvent();

        const rail = await screen.findByTestId("stub-readiness-rail");
        expect(rail.dataset.blockers?.split(",")).toContain("chargebackTerms");
      });
    });
  });
});
