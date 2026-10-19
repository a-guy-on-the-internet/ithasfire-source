import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  BLOCKER_COPY,
  FILL_COPY,
  FINAL_NOTE_COPY,
  MOVE_COPY,
  RENAME_KIND_COPY,
  WARNING_COPY,
  type PlaceMergePreview,
} from "../place-merge-copy";
import type { PlatformPlaceRow } from "../types";

// ── Controllable tRPC doubles ────────────────────────────────────────────
/** Previews by `survivorId|mergedId`, so a swap renders its own answer. */
type PreviewState = {
  byKey: Map<string, PlaceMergePreview>;
  error: unknown;
  fetchingKeys: Set<string>;
};
const previewState: PreviewState = {
  byKey: new Map(),
  error: null,
  fetchingKeys: new Set(),
};
const keyOf = (input: unknown) => {
  const i = input as { survivorId: string; mergedId: string };
  return `${i.survivorId}|${i.mergedId}`;
};
function setPreview(p: PlaceMergePreview) {
  previewState.byKey.set(`${p.survivor.id}|${p.merged.id}`, p);
}
const previewCalls: { input: unknown; enabled: boolean }[] = [];
const previewRefetch = vi.fn();
const mergeMutateAsync = vi.fn(
  (_input: unknown): Promise<unknown> => Promise.resolve({}),
);
const mergePending = { current: false };
const toastSuccess = vi.fn();

vi.mock("@/trpc", () => ({
  trpc: {
    platform: {
      previewPlaceMerge: {
        useQuery: (input: unknown, opts: { enabled?: boolean }) => {
          previewCalls.push({ input, enabled: Boolean(opts.enabled) });
          const on = Boolean(opts.enabled);
          const key = keyOf(input);
          // Like react-query: a failed refetch keeps the last data.
          return {
            data: on ? previewState.byKey.get(key) : undefined,
            error: on ? previewState.error : null,
            isError: on && previewState.error != null,
            isFetching: on && previewState.fetchingKeys.has(key),
            refetch: previewRefetch,
          };
        },
      },
      mergePlaces: {
        useMutation: () => ({
          mutateAsync: mergeMutateAsync,
          isPending: mergePending.current,
        }),
      },
    },
  },
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    role,
    ...rest
  }: {
    children?: ReactNode;
    role?: string;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "div",
      { role, "data-testid": rest["data-testid"] as string | undefined },
      children,
    );
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => ({ ArrowLeftRight: () => <span /> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/platform/places" }));
vi.mock("@/lib/design-tokens", () => ({ ACCENT_TEXT: "var(--accentText)" }));
vi.mock("@/components/places/PlaceDialog", () => ({
  SecondFactorNotice: () => <div data-testid="place-second-factor-notice" />,
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown, t?: unknown) =>
    `${String((e as Error)?.message ?? e)}${typeof t === "function" ? " [t]" : " [no t]"}`,
}));
vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (e: unknown) =>
    (e as { data?: { appCode?: string } } | null)?.data?.appCode ?? null,
}));

/** The lookup is PlaceLookup's own concern; here it offers two fixed rows. */
const lookupProps: { excludePlaceIds?: readonly string[] } = {};
vi.mock("../PlaceLookup", () => ({
  PlaceLookup: ({
    onSelectPlace,
    excludePlaceIds,
  }: {
    onSelectPlace: (p: PlatformPlaceRow) => void;
    excludePlaceIds?: readonly string[];
  }) => {
    lookupProps.excludePlaceIds = excludePlaceIds;
    return (
      <button type="button" onClick={() => onSelectPlace(otherRow)}>
        pick-other
      </button>
    );
  },
}));

vi.mock("@th/ui", () => {
  const Modal = ({
    open,
    children,
  }: {
    open: boolean;
    children?: ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null);
  Modal.Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Header = ({
    title,
    onClose,
  }: {
    title: string;
    onClose?: () => void;
  }) => (
    <header>
      <h2>{title}</h2>
      {onClose ? (
        <button type="button" aria-label="Close" onClick={onClose} />
      ) : null}
    </header>
  );
  Modal.Body = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Footer = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Modal,
    Spinner: () => <span />,
    Text: ({
      children,
      role,
      ...rest
    }: {
      children?: ReactNode;
      role?: string;
      [key: string]: unknown;
    }) => (
      <span
        role={role}
        data-testid={rest["data-testid"] as string | undefined}
      >
        {children}
      </span>
    ),
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onPress?.()}
        data-testid={rest["data-testid"] as string | undefined}
      >
        {children}
      </button>
    ),
    useNotify: () => ({ toast: { success: toastSuccess, danger: vi.fn() } }),
    // Keys come back as themselves, with any values appended, so a test can
    // see both which line rendered and what it was given.
    useTranslations:
      () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key,
  };
});

import { PlaceMergeDialog } from "../PlaceMergeDialog";

// ── Fixtures ────────────────────────────────────────────────────────────
const CURRENT_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_ID = "00000000-0000-4000-8000-0000000000c2";

const currentRow: PlatformPlaceRow = {
  placeId: CURRENT_ID,
  name: "Cobra (dupe)",
  formattedAddress: "2511 Gallatin Ave",
  city: "Nashville",
  region: "TN",
  countryCode: "US",
  capacity: null,
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
  ownerCount: 0,
  listedInDirectory: true,
  publicPath: "/places/cobra-dupe",
};
const otherRow: PlatformPlaceRow = {
  ...currentRow,
  placeId: OTHER_ID,
  name: "The Cobra",
  publicPath: "/places/the-cobra",
};

function side(id: string, name: string): PlaceMergePreview["survivor"] {
  return {
    id,
    name,
    address: "2511 Gallatin Ave",
    addrLine1: null,
    addrLine2: null,
    city: "Nashville",
    region: "TN",
    postcode: null,
    country: "US",
    addressHash: null,
    capacity: null,
    lat: 36.2,
    lng: -86.7,
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    status: "ACTIVE",
    verification: "UNVERIFIED",
    timezone: "America/Chicago",
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    listedInDirectory: true,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: true,
    communityReviewsEnabled: true,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function zeroMoves(): PlaceMergePreview["moves"] {
  return Object.fromEntries(
    Object.keys(MOVE_COPY).map((k) => [k, 0]),
  ) as PlaceMergePreview["moves"];
}

function makePreview(
  over: Partial<PlaceMergePreview> = {},
  survivorId = OTHER_ID,
  mergedId = CURRENT_ID,
): PlaceMergePreview {
  const byId: Record<string, string> = {
    [OTHER_ID]: "The Cobra",
    [CURRENT_ID]: "Cobra (dupe)",
  };
  return {
    survivor: side(survivorId, byId[survivorId]!),
    merged: side(mergedId, byId[mergedId]!),
    survivorPage: { id: "p1", slug: "the-cobra" },
    mergedPage: { id: "p2", slug: "cobra-dupe" },
    pageAction: "MOVE_TO_SURVIVOR_PAGE",
    moves: {
      ...zeroMoves(),
      events: 12,
      venueConfirmedEvents: 5,
      eventsOnDefaultCalendar: 12,
      follows: 4,
      followsDropped: 2,
    },
    filledFields: ["phone", "website", "websiteSource"],
    blockers: [],
    warnings: [],
    renames: [],
    canMerge: true,
    ...over,
  };
}

function renderDialog(
  handlers: { onClose?: () => void; onMerged?: () => void } = {},
) {
  return render(
    <PlaceMergeDialog
      open
      place={currentRow}
      onClose={handlers.onClose ?? vi.fn()}
      onMerged={handlers.onMerged ?? vi.fn()}
    />,
  );
}

const confirmButton = () =>
  screen.getByRole("button", { name: "admin.ppMergeConfirmCta" });

async function pickOther() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "pick-other" }));
  });
}

async function pressConfirm() {
  await act(async () => {
    fireEvent.click(confirmButton());
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  previewState.byKey = new Map();
  previewState.error = null;
  previewState.fetchingKeys = new Set();
  previewCalls.length = 0;
  previewRefetch.mockClear();
  mergeMutateAsync.mockReset();
  mergeMutateAsync.mockImplementation(() => Promise.resolve({}));
  mergePending.current = false;
  toastSuccess.mockClear();
  lookupProps.excludePlaceIds = undefined;
});

// ── Copy maps ───────────────────────────────────────────────────────────
describe("place merge copy", () => {
  const admin = (m: unknown) =>
    (m as { admin: Record<string, unknown> }).admin;
  const allKeys = [
    ...Object.values(BLOCKER_COPY),
    ...Object.values(WARNING_COPY),
    // The second EVENT_ARRIVAL_AREAS_SWITCH_OFF line (`warningCopyKey`).
    "admin.ppMergeWarnEventArrivalAreasOffNoPin",
    ...Object.values(MOVE_COPY).flatMap((m) => (m.key ? [m.key] : [])),
    ...Object.values(FILL_COPY),
    ...Object.values(RENAME_KIND_COPY),
    ...Object.values(FINAL_NOTE_COPY),
  ];

  it("every key the maps name exists in both catalogs", () => {
    for (const full of allKeys) {
      const key = full.replace(/^admin\./, "");
      expect(admin(enMessages)[key], `en ${key}`).toEqual(expect.any(String));
      expect(admin(esMessages)[key], `es ${key}`).toEqual(expect.any(String));
    }
  });
});

// ── Dialog ──────────────────────────────────────────────────────────────
describe("PlaceMergeDialog", () => {
  it("starts on the picker, which leaves out the current place", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "pick-other" })).toBeInTheDocument();
    expect(lookupProps.excludePlaceIds).toEqual([CURRENT_ID]);
    expect(previewCalls.every((c) => !c.enabled)).toBe(true);
    // Nothing to confirm before a pick.
    expect(
      screen.queryByRole("button", { name: "admin.ppMergeConfirmCta" }),
    ).not.toBeInTheDocument();
  });

  it("asks for the preview with the pick as the survivor, and shows loading", async () => {
    renderDialog();
    await pickOther();
    expect(previewCalls.at(-1)).toEqual({
      input: { survivorId: OTHER_ID, mergedId: CURRENT_ID },
      enabled: true,
    });
    expect(screen.getByTestId("platform-place-merge-loading")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("renders both sides, non-zero moves, drops, fills and the final note", async () => {
    setPreview(makePreview({
      renames: [
        {
          id: "cal1",
          kind: "calendar",
          from: { name: "Main" },
          to: { name: "Main (2)" },
        },
      ],
    }));
    renderDialog();
    await pickOther();

    const survivor = screen.getByTestId("platform-place-merge-survivor");
    expect(survivor).toHaveTextContent("admin.ppMergeStays");
    expect(survivor).toHaveTextContent("The Cobra");
    expect(survivor).toHaveTextContent("/places/the-cobra");
    expect(survivor).toHaveTextContent("2511 Gallatin Ave, Nashville, TN");
    const merged = screen.getByTestId("platform-place-merge-merged");
    expect(merged).toHaveTextContent("admin.ppMergeRemoved");
    expect(merged).toHaveTextContent("Cobra (dupe)");
    expect(merged).toHaveTextContent("/places/cobra-dupe");

    const moves = screen.getByTestId("platform-place-merge-moves");
    expect(moves).toHaveTextContent("admin.ppMergeMoveEvents");
    expect(moves).toHaveTextContent("12");
    expect(moves).toHaveTextContent("admin.ppMergeMoveFollows");
    // Zero counts are left out; plumbing subsets never show.
    expect(moves).not.toHaveTextContent("admin.ppMergeMoveWaivers");
    expect(moves).not.toHaveTextContent("EventsOnCalendar");
    // The confirmed subset reads as part of Events, right after it.
    expect(moves.textContent).toMatch(
      /admin\.ppMergeMoveEvents12admin\.ppMergeMoveConfirmedEvents5/,
    );
    // A dropped row names the place that already has it.
    expect(
      screen.getByTestId("platform-place-merge-dropped"),
    ).toHaveTextContent('admin.ppMergeDropFollows {"name":"The Cobra"}');
    // website + websiteSource read as one "Website".
    const filled = screen.getByTestId("platform-place-merge-filled");
    expect(filled.textContent).toContain(
      "admin.ppMergeFillPhone, admin.ppMergeFillWebsite",
    );
    expect(filled.textContent).not.toMatch(/Website.*Website/);
    expect(
      screen.getByTestId("platform-place-merge-renames"),
    ).toHaveTextContent('"from":"Main","to":"Main (2)"');
    expect(
      screen.getByTestId("platform-place-merge-final"),
    ).toHaveTextContent("admin.ppMergeFinalRedirect");
    expect(
      screen.queryByTestId("platform-place-merge-blockers"),
    ).not.toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("says the owner transfer by name, with the requests and agreements taken over", async () => {
    setPreview(makePreview({
      warnings: [
        {
          code: "OWNERSHIP_TRANSFERS",
          count: 1,
          owners: [{ ownerType: "HUMAN", ownerId: "h1" }],
          survivorOpenBookingRequests: 3,
          survivorLiveAgreements: 1,
        },
        { code: "GRANTS_ENDED", count: 2 },
      ],
    }));
    renderDialog();
    await pickOther();
    const warnings = screen.getByTestId("platform-place-merge-warnings");
    expect(warnings).toHaveTextContent("admin.ppMergeWarnOwnershipTransfers");
    expect(warnings).toHaveTextContent(
      '"merged":"Cobra (dupe)","survivor":"The Cobra","requests":3,"agreements":1',
    );
    expect(warnings).toHaveTextContent("admin.ppMergeWarnGrantsEnded");
    // Warnings never block.
    expect(confirmButton()).toBeEnabled();
  });

  it("warns, with the count, of event Getting there areas far from the survivor's pin", async () => {
    setPreview(makePreview({
      warnings: [
        {
          code: "EVENT_ARRIVAL_AREAS_SWITCH_OFF",
          count: 2,
          ids: ["a-1", "a-2"],
          survivorHasPin: true,
        },
      ],
    }));
    renderDialog();
    await pickOther();
    const warnings = screen.getByTestId("platform-place-merge-warnings");
    expect(warnings).toHaveTextContent("admin.ppMergeWarnEventArrivalAreasOff");
    expect(warnings).not.toHaveTextContent("admin.ppMergeWarnEventArrivalAreasOffNoPin");
    expect(warnings).toHaveTextContent('"count":2');
    expect(warnings).toHaveTextContent('"survivor":"The Cobra"');
    expect(confirmButton()).toBeEnabled();
  });

  it("says the survivor has no map pin when that is why every event area switches off", async () => {
    setPreview(makePreview({
      warnings: [
        {
          code: "EVENT_ARRIVAL_AREAS_SWITCH_OFF",
          count: 3,
          ids: ["a-1", "a-2", "a-3"],
          survivorHasPin: false,
        },
      ],
    }));
    renderDialog();
    await pickOther();
    const warnings = screen.getByTestId("platform-place-merge-warnings");
    expect(warnings).toHaveTextContent("admin.ppMergeWarnEventArrivalAreasOffNoPin");
    expect(warnings).toHaveTextContent('"count":3');
    expect(confirmButton()).toBeEnabled();
  });

  it("warns that a non-active merged place's Getting there areas become public, without blocking", async () => {
    setPreview(makePreview({
      warnings: [
        {
          code: "MERGED_PLACE_AREAS_BECOME_PUBLIC",
          count: 2,
          ids: ["a-1", "a-2"],
        },
      ],
    }));
    renderDialog();
    await pickOther();
    const warnings = screen.getByTestId("platform-place-merge-warnings");
    expect(warnings).toHaveTextContent("admin.ppMergeWarnMergedAreasBecomePublic");
    expect(warnings).toHaveTextContent('"count":2');
    expect(warnings).toHaveTextContent('"merged":"Cobra (dupe)","survivor":"The Cobra"');
    expect(confirmButton()).toBeEnabled();
  });

  it("the become-public line names both places and says place, never venue", () => {
    for (const messages of [enMessages, esMessages]) {
      const line = (messages as { admin: Record<string, string> }).admin
        .ppMergeWarnMergedAreasBecomePublic!;
      expect(line).toContain("{merged}");
      expect(line).toContain("{survivor}");
      expect(line).toContain("{count}");
      expect(line).not.toMatch(/venue/i);
    }
    // It is about the place page, and who will see the areas there.
    const en = (enMessages as { admin: Record<string, string> }).admin
      .ppMergeWarnMergedAreasBecomePublic!;
    expect(en).toMatch(/place page/);
    expect(en).toMatch(/anyone will see/);
    const es = (esMessages as { admin: Record<string, string> }).admin
      .ppMergeWarnMergedAreasBecomePublic!;
    expect(es).toMatch(/página del lugar/);
    // `{count}` is what becomes visible (no load-in, nothing switched off), never
    // the merged place's total: the count sits only in the "will see" part.
    for (const line of [en, es]) {
      const [hides, sees] = line.split(/\.\s/);
      expect(hides).not.toContain("{count}");
      expect(sees).toContain("{count}");
    }
  });

  it("the two switch-off lines say different things, in both catalogs", () => {
    for (const [messages, noPin] of [
      [enMessages, "has no map pin"],
      [esMessages, "no tiene pin en el mapa"],
    ] as const) {
      const admin = (messages as { admin: Record<string, string> }).admin;
      expect(admin.ppMergeWarnEventArrivalAreasOff).toMatch(/3 km/);
      expect(admin.ppMergeWarnEventArrivalAreasOffNoPin).not.toMatch(/3 km/);
      expect(admin.ppMergeWarnEventArrivalAreasOffNoPin).toContain(noPin);
      expect(admin.ppMergeWarnEventArrivalAreasOffNoPin).toMatch(/\{survivor\}/);
    }
  });

  it("a blocker disables confirm and is said with its count", async () => {
    setPreview(makePreview({
      blockers: [{ code: "BOOKING_HOLDS_OVERLAP", count: 3 }],
      canMerge: false,
    }));
    renderDialog();
    await pickOther();
    const blockers = screen.getByTestId("platform-place-merge-blockers");
    expect(blockers).toHaveTextContent("admin.ppMergeBlockHoldsOverlap");
    expect(blockers).toHaveTextContent('"count":3');
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mergeMutateAsync).not.toHaveBeenCalled();
  });

  it("ARRIVAL_AREA_LIMIT names every area with its kind and which place it is on", async () => {
    setPreview(makePreview({
      blockers: [
        {
          code: "ARRIVAL_AREA_LIMIT",
          count: 11,
          limit: 10,
          ids: ["a-1", "a-2"],
          arrivalAreas: [
            { id: "a-1", placeId: CURRENT_ID, side: "survivor", kind: "PARKING", label: "Back lot" },
            { id: "a-2", placeId: OTHER_ID, side: "merged", kind: "LOAD_IN", label: "Alley door" },
          ],
        },
      ],
      canMerge: false,
    }));
    renderDialog();
    await pickOther();
    const blockers = screen.getByTestId("platform-place-merge-blockers");
    expect(blockers).toHaveTextContent("admin.ppMergeBlockArrivalAreaLimit");
    expect(blockers).toHaveTextContent('"count":11,"limit":10');
    // One line per area (the design-system mock renders each as a span).
    expect(blockers).toHaveTextContent(
      '"label":"Back lot","kind":"admin.ppMergeArrivalAreaKindParking","side":"admin.ppMergeArrivalAreaSideSurvivor"',
    );
    expect(blockers).toHaveTextContent(
      '"label":"Alley door","kind":"admin.ppMergeArrivalAreaKindLoadIn","side":"admin.ppMergeArrivalAreaSideMerged"',
    );
    expect(confirmButton()).toBeDisabled();
  });

  it("swapping re-asks the preview with the ids reversed", async () => {
    setPreview(makePreview());
    setPreview(makePreview({}, CURRENT_ID, OTHER_ID));
    renderDialog();
    await pickOther();
    expect(
      screen.getByRole("button", { name: /admin\.ppMergeKeepInstead/ }),
    ).toHaveTextContent('"name":"Cobra (dupe)"');

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /admin\.ppMergeKeepInstead/ }),
      );
    });
    expect(previewCalls.at(-1)).toEqual({
      input: { survivorId: CURRENT_ID, mergedId: OTHER_ID },
      enabled: true,
    });
    // The swap now offers to flip back, and shows the reversed answer.
    expect(
      screen.getByRole("button", { name: /admin\.ppMergeKeepInstead/ }),
    ).toHaveTextContent('"name":"The Cobra"');
    expect(
      screen.getByTestId("platform-place-merge-survivor"),
    ).toHaveTextContent("Cobra (dupe)");
    expect(
      screen.getByTestId("platform-place-merge-merged"),
    ).toHaveTextContent("The Cobra");
  });

  it("a swap whose preview is still fetching keeps confirm disabled", async () => {
    setPreview(makePreview());
    setPreview(makePreview({}, CURRENT_ID, OTHER_ID));
    previewState.fetchingKeys.add(`${CURRENT_ID}|${OTHER_ID}`);
    renderDialog();
    await pickOther();
    expect(confirmButton()).toBeEnabled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /admin\.ppMergeKeepInstead/ }),
      );
    });
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mergeMutateAsync).not.toHaveBeenCalled();
  });

  it("a confirm after a swap merges the other place into this one", async () => {
    setPreview(makePreview());
    setPreview(makePreview({}, CURRENT_ID, OTHER_ID));
    mergeMutateAsync.mockResolvedValueOnce({ survivorId: CURRENT_ID });
    const onMerged = vi.fn();
    renderDialog({ onMerged });
    await pickOther();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /admin\.ppMergeKeepInstead/ }),
      );
    });
    await pressConfirm();
    expect(mergeMutateAsync).toHaveBeenCalledWith({
      survivorId: CURRENT_ID,
      mergedId: OTHER_ID,
    });
    expect(onMerged).toHaveBeenCalledWith({ survivorId: CURRENT_ID });
  });

  it("a failed re-read keeps confirm disabled even with old clear data", async () => {
    // react-query keeps the last data when a refetch fails, here with no
    // blockers; the error must still win.
    setPreview(makePreview());
    previewState.error = new Error("network");
    renderDialog();
    await pickOther();
    expect(
      screen.getByTestId("platform-place-merge-preview-error"),
    ).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("merges with the previewed ids, toasts, and hands the survivor back", async () => {
    setPreview(makePreview());
    mergeMutateAsync.mockResolvedValueOnce({ survivorId: OTHER_ID });
    const onMerged = vi.fn();
    renderDialog({ onMerged });
    await pickOther();
    await pressConfirm();
    expect(mergeMutateAsync).toHaveBeenCalledTimes(1);
    expect(mergeMutateAsync).toHaveBeenCalledWith({
      survivorId: OTHER_ID,
      mergedId: CURRENT_ID,
    });
    expect(toastSuccess).toHaveBeenCalledWith({
      title: expect.stringContaining("admin.ppMergeMerged"),
    });
    expect(onMerged).toHaveBeenCalledWith({ survivorId: OTHER_ID });
  });

  it("a second press while the first is in flight sends nothing", async () => {
    setPreview(makePreview());
    let resolve!: (v: unknown) => void;
    mergeMutateAsync.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    renderDialog();
    await pickOther();
    await act(async () => {
      fireEvent.click(confirmButton());
      fireEvent.click(confirmButton());
    });
    expect(mergeMutateAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ survivorId: OTHER_ID });
      await Promise.resolve();
    });
  });

  it("while merging, the confirm is busy and the dialog cannot be dismissed", async () => {
    setPreview(makePreview());
    mergePending.current = true;
    renderDialog();
    await pickOther();
    const busy = screen.getByRole("button", { name: "admin.ppMergeMerging" });
    expect(busy).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "admin.ppMergeCancelCta" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("PLACE_MERGE_RETRY says try again and keeps the dialog open", async () => {
    setPreview(makePreview());
    mergeMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("PLACE_MERGE_RETRY"), {
        data: { appCode: "CONFLICT", meta: { reason: "PLACE_MERGE_RETRY" } },
      }),
    );
    const onMerged = vi.fn();
    renderDialog({ onMerged });
    await pickOther();
    await pressConfirm();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.ppMergeRetryError",
    );
    expect(onMerged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("PLACE_MERGE_BLOCKED re-reads the preview", async () => {
    setPreview(makePreview());
    mergeMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("PLACE_MERGE_BLOCKED"), {
        data: {
          appCode: "CONFLICT",
          meta: { reason: "PLACE_MERGE_BLOCKED", blockers: [] },
        },
      }),
    );
    renderDialog();
    await pickOther();
    await pressConfirm();
    expect(previewRefetch).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.ppMergeBlockedError",
    );
  });

  it("any other error is translated with t", async () => {
    setPreview(makePreview());
    mergeMutateAsync.mockRejectedValueOnce(new Error("boom"));
    renderDialog();
    await pickOther();
    await pressConfirm();
    expect(screen.getByRole("alert")).toHaveTextContent("boom [t]");
  });

  it("a preview error is said with t and can be retried", async () => {
    previewState.error = Object.assign(new Error("STAFF_ONLY"), {
      data: { appCode: "STAFF_ONLY" },
    });
    renderDialog();
    await pickOther();
    const box = screen.getByTestId("platform-place-merge-preview-error");
    expect(box).toHaveTextContent("STAFF_ONLY [t]");
    fireEvent.click(
      screen.getByRole("button", { name: "admin.ppMergeCheckAgain" }),
    );
    expect(previewRefetch).toHaveBeenCalled();
    expect(confirmButton()).toBeDisabled();
  });

  it("a preview that needs the second factor shows the step-up notice", async () => {
    previewState.error = Object.assign(new Error("x"), {
      data: { appCode: "SECOND_FACTOR_REQUIRED" },
    });
    renderDialog();
    await pickOther();
    expect(screen.getByTestId("place-second-factor-notice")).toBeInTheDocument();
  });
});
