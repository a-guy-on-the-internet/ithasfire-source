/**
 * EventBuilder — the Public link field and the `⋯` menu's Copy link, together.
 *
 * What this pins, at the builder level:
 *  1. the field mounts for an event a stranger can read and NOT for a draft
 *     or a never-published cancellation (drafts carry a slug and short ID from
 *     creation, so a slug-gate would let them through);
 *  2. the `⋯` Copy link is offered on exactly the same rule;
 *  3. both copy actions write the SAME absolute URL — the short link when
 *     there is one, the canonical page otherwise — through the guarded
 *     clipboard helper, with the same toasts;
 *  4. View event — the field's link and the `⋯` item — reaches the canonical
 *     page in a new tab, noopener;
 *  5. Settings → Sharing is handed the status and publish time it
 *     needs to apply the same rule to its own short link.
 *
 * MOCKS: the PlacementHydration scaffold. `BuilderHeaderBar` is a probe that
 * turns its `onCopyEventLink` / `onViewEvent` props into buttons, so the
 * builder's gate and handlers run for real; the field itself is REAL.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

const toastSpy = vi.hoisted(() => ({
  success: vi.fn(),
  danger: vi.fn(),
}));

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
      tag,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      tag?: string;
      [key: string]: unknown;
    }) =>
      React.createElement(
        tag === "a" ? "a" : "button",
        {
          ...(tag === "a"
            ? { href: rest.href, target: rest.target, rel: rest.rel }
            : { type: "button", onClick: onPress }),
          "data-testid": rest["data-testid"],
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    TextInput: () => null,
    Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
    StyledSelect: () => null,
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
    useNotify: () => ({
      toast: {
        info: noop,
        success: toastSpy.success,
        warning: noop,
        danger: toastSpy.danger,
        neutral: noop,
      },
    }),
  };
});

vi.mock("next/dynamic", () => ({ default: () => () => null }));

// ── Data fixtures ─────────────────────────────────────────────────────────

const { query, mutation, EVENT_FOR_EDIT, eventRef, settingsProps } =
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
      title: "Lower East Side Charity Fundraiser",
      status: "PUBLISHED",
      stewardship: "OWNED",
      startsAt: "2026-11-01T20:00:00.000Z",
      endsAt: "2026-11-01T23:00:00.000Z",
      timezone: "America/Chicago",
      currency: "USD",
      slug: "demo/us/general/lower-east-side-charity-fundraiser--ab12cd",
      shortId: "wqsdk6pxzi",
      publishedAt: new Date("2026-09-01T12:00:00.000Z"),
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
      orgId: "org-1",
      humanId: null,
    };
    /** Per-test overrides of the edit payload, applied before render. */
    const eventRef = { current: {} as Record<string, unknown> };
    /** What the builder hands Settings → Sharing on its latest render. */
    const settingsProps = { current: {} as Record<string, unknown> };
    return { query, mutation, EVENT_FOR_EDIT, eventRef, settingsProps };
  });

// ── Probes ────────────────────────────────────────────────────────────────

vi.mock("../BuilderHeaderBar", async () => {
  const React = await import("react");
  return {
    BuilderHeaderBar: ({
      onCopyEventLink,
      onViewEvent,
    }: {
      onCopyEventLink?: () => void;
      onViewEvent?: () => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "header-probe" },
        onCopyEventLink
          ? React.createElement("button", {
              type: "button",
              "data-testid": "menu-copy-link",
              onClick: onCopyEventLink,
            })
          : null,
        onViewEvent
          ? React.createElement("button", {
              type: "button",
              "data-testid": "menu-view-event",
              onClick: onViewEvent,
            })
          : null,
      ),
  };
});

vi.mock("../BuilderSettingsSections", () => ({
  BuilderSettingsSections: (props: Record<string, unknown>) => {
    settingsProps.current = props;
    return null;
  },
}));
vi.mock("../BuilderEssentialsSection", () => ({
  BuilderEssentialsSection: () => null,
}));
vi.mock("../BuilderDetailsSection", () => ({
  BuilderDetailsSection: () => null,
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

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/demo/events/evt-1/edit",
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
  // One result object per override set, returned by identity on every render
  // (React Query's structural sharing) — fresh objects per render would loop
  // the builder's identity-keyed effects.
  const byKey = new Map<string, unknown>();
  const eventForEdit = () => {
    const key = JSON.stringify(eventRef.current);
    if (!byKey.has(key)) {
      byKey.set(
        key,
        query({
          data: { ...EVENT_FOR_EDIT, ...eventRef.current },
          isSuccess: true,
        }),
      );
    }
    return byKey.get(key);
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
  const mutationResult = mutation();
  const useMutation = () => mutationResult;
  return {
    trpc: {
      useUtils: () => chain,
      events: {
        getEventForEdit: { useQuery: eventForEdit },
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
      community: {
        updateListing: { useMutation },
        publishListing: { useMutation },
      },
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

const SHORT_URL = () => `${window.location.origin}/e/wqsdk6pxzi`;
const LONG_PATH = `/events/${EVENT_FOR_EDIT.slug}`;

const renderBuilder = () =>
  render(
    <EventBuilder
      surface="edit"
      ownerType="org"
      ownerId="org-1"
      slug="demo"
      eventId="evt-1"
      canEditEvent
      canManageEvent
    />,
  );

const writeText = vi.fn<[string], Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(
  window.navigator,
  "clipboard",
);
const setClipboard = (value: unknown) =>
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value,
  });

beforeEach(() => {
  eventRef.current = {};
  settingsProps.current = {};
  toastSpy.success.mockReset();
  toastSpy.danger.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  setClipboard({ writeText });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState({}, "", "/admin/demo/events/evt-1/edit");
});

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  } else {
    setClipboard(undefined);
  }
});

describe("EventBuilder — Public link field + ⋯ Copy link", () => {
  it("a published event shows the field with its short URL", async () => {
    renderBuilder();
    expect(
      await screen.findByTestId("event-public-link-url"),
    ).toHaveTextContent(`${window.location.host}/e/wqsdk6pxzi`);
  });

  it("the ⋯ Copy link copies the SHORT URL, with the success toast", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("menu-copy-link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHORT_URL()));
    await waitFor(() =>
      expect(toastSpy.success).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "event-link-copied",
          title: "eventDetail.shareLinkCopied",
        }),
      ),
    );
  });

  it("the field's Copy writes the SAME URL through the same handler", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("event-public-link-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHORT_URL()));
    await waitFor(() =>
      expect(toastSpy.success).toHaveBeenCalledWith(
        expect.objectContaining({ id: "event-link-copied" }),
      ),
    );
  });

  it("Copy takes the GUARDED path: no clipboard API (non-secure context) → failure toast, no throw", async () => {
    setClipboard(undefined);
    renderBuilder();
    fireEvent.click(await screen.findByTestId("event-public-link-copy"));
    await waitFor(() =>
      expect(toastSpy.danger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "event-link-copy-failed",
          title: "places.shareCopyFailedToast",
        }),
      ),
    );
    expect(toastSpy.success).not.toHaveBeenCalled();
  });

  it("a legacy event without a short ID copies (and shows) the long canonical URL", async () => {
    eventRef.current = { shortId: null };
    renderBuilder();
    expect(
      await screen.findByTestId("event-public-link-url"),
    ).toHaveTextContent(`${window.location.host}${LONG_PATH}`);
    fireEvent.click(screen.getByTestId("menu-copy-link"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}${LONG_PATH}`,
      ),
    );
  });

  it("a DRAFT — slug and short ID notwithstanding — gets neither the field nor the ⋯ Copy link", async () => {
    eventRef.current = { status: "DRAFT", publishedAt: null };
    renderBuilder();
    await screen.findByTestId("header-probe");
    expect(screen.queryByTestId("event-public-link")).toBeNull();
    expect(screen.queryByTestId("menu-copy-link")).toBeNull();
  });

  it("a CANCELLED event that never went live gets neither", async () => {
    eventRef.current = { status: "CANCELLED", publishedAt: null };
    renderBuilder();
    await screen.findByTestId("header-probe");
    expect(screen.queryByTestId("event-public-link")).toBeNull();
    expect(screen.queryByTestId("menu-copy-link")).toBeNull();
  });

  it("the field's View event is a new-tab link to the canonical page", async () => {
    renderBuilder();
    const view = await screen.findByTestId("event-public-link-view");
    expect(view.tagName).toBe("A");
    expect(view).toHaveAttribute("href", LONG_PATH);
    expect(view).toHaveAttribute("target", "_blank");
    expect(view).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("the ⋯ View event opens the canonical page in a new tab, noopener", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderBuilder();
    fireEvent.click(await screen.findByTestId("menu-view-event"));
    expect(open).toHaveBeenCalledWith(
      LONG_PATH,
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("hands Settings → Sharing the status + publish time its short link is gated on", async () => {
    eventRef.current = { status: "DRAFT", publishedAt: null };
    renderBuilder();
    await screen.findByTestId("header-probe");
    await waitFor(() =>
      expect(settingsProps.current).toMatchObject({
        eventStatus: "DRAFT",
        eventPublishedAt: null,
        eventShortId: "wqsdk6pxzi",
      }),
    );
  });
});
