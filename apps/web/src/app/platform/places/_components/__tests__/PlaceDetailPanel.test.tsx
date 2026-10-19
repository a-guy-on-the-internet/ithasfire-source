import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformPlaceRow, PlaceVerificationStatus } from "../types";

type WaivePayload = Record<string, unknown>;
const verifyMutateAsync = vi.fn((_payload: WaivePayload) =>
  Promise.resolve({}),
);
const restoreMutateAsync = vi.fn(
  (_payload: WaivePayload): Promise<unknown> => Promise.resolve({}),
);
const toggleMutate = vi.fn();
const toastSuccess = vi.fn();
const toastDanger = vi.fn();
const staffRoles = { current: ["ADMIN"] as string[] };

type Editability = {
  placeId: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  reason: string | null;
  linkedListingCount: number;
  duplicatePlaceId: string | null;
  archivedByModerator: boolean;
  statusChangedAt: string | null;
};
const editabilityState: {
  data: Editability | undefined;
  error: unknown;
  enabledCalls: boolean[];
} = { data: undefined, error: null, enabledCalls: [] };
const editabilityFetch = vi.fn(() => Promise.resolve(editabilityState.data));
/** `entityPages.placePageEditAccess` — the moderator page-editor probe. */
const pageAccessState: {
  data:
    | {
        canEditPage: boolean;
        editorKind: "owner" | "community_moderator" | null;
        reason: string | null;
      }
    | undefined;
  enabledCalls: boolean[];
} = { data: undefined, enabledCalls: [] };
const listPlacesFetch = vi.fn(
  (_input: unknown, _opts?: unknown): Promise<{ places: unknown[] }> =>
    Promise.resolve({ places: [] }),
);
/** Shared so a test can see what was invalidated, and in which order. */
const listInvalidate = vi.fn();
const editabilityInvalidate = vi.fn();
/** The last mode the panel handed the shared PlaceDialog. */
const dialogMode: { current: unknown } = { current: null };

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    Archive: Icon,
    ArrowRight: Icon,
    BadgeCheck: Icon,
    ExternalLink: Icon,
    Eye: Icon,
    Merge: Icon,
    Pencil: Icon,
    RotateCcw: Icon,
    ShieldCheck: Icon,
    X: Icon,
    AlertTriangle: Icon,
  };
});

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/places" }));

vi.mock("@/components/places/PlaceDialog", () => ({
  REFUSAL_COPY: {
    OWNED: { title: "refused.owned.title", body: "refused.owned.body" },
    CLAIM_PENDING: { title: "refused.claim.title", body: "refused.claim.body" },
    OWNED_EVENTS_AT_PLACE: {
      title: "refused.events.title",
      body: "refused.events.body",
    },
    NOT_ACTIVE: { title: "refused.na.title", body: "refused.na.body" },
    NOT_COMMUNITY_ARCHIVED: {
      title: "refused.na.title",
      body: "refused.na.body",
    },
    ADDRESS_WITHHELD: {
      title: "refused.withheld.title",
      body: "refused.withheld.body",
    },
  },
  SecondFactorNotice: () => <div data-testid="place-second-factor-notice" />,
  PlaceDialog: ({ mode }: { mode: unknown }) => {
    dialogMode.current = mode;
    return mode ? <div data-testid="place-dialog" /> : null;
  },
}));

/** The panel's side of the merge flow; the dialog has its own tests. */
const mergeDialogProps: {
  current: { onMerged: (r: { survivorId: string }) => void } | null;
} = { current: null };
vi.mock("../PlaceMergeDialog", () => ({
  PlaceMergeDialog: (props: {
    onMerged: (r: { survivorId: string }) => void;
    onClose: () => void;
  }) => {
    mergeDialogProps.current = props;
    return <div data-testid="place-merge-dialog" />;
  },
}));

vi.mock("@/components/places/place-or-address.helpers", () => ({
  toRefusalReason: (r: string | null) => r ?? "NOT_ACTIVE",
}));

/**
 * `@th/ui` is mocked down to bare DOM so the assertions are about THIS
 * component's logic, not the design system. `Button` maps `onPress`/`disabled`
 * onto a real `<button>` so `getByRole("button", { name })` and
 * `toBeDisabled()` mean what they normally mean — that is the whole point of
 * the accessible-name checks below.
 */
vi.mock("@th/ui", () => {
  const Modal = ({
    open,
    children,
  }: {
    open: boolean;
    children?: ReactNode;
  }) => (open ? <div>{children}</div> : null);
  Modal.Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  // Like the real header (overlay/Modal.tsx): its own X named "Close", so a
  // second "Close" in the panel would show up as a duplicate here.
  Modal.Header = ({
    title,
    subtitle,
    onClose,
  }: {
    title: string;
    subtitle?: string;
    onClose?: () => void;
  }) => (
    <header>
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
      <button type="button" aria-label="Close" onClick={onClose} />
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
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    DateTime: ({ value }: { value: string }) => (
      <span>{value.slice(0, 10)}</span>
    ),
    Switch: ({
      id,
      checked,
      onCheckedChange,
      disabled,
    }: {
      id?: string;
      checked: boolean;
      onCheckedChange: (v: boolean) => void;
      disabled?: boolean;
    }) => (
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
      />
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
    LabeledTextInput: ({
      label,
      value,
      onChangeText,
      testId,
    }: {
      label: string;
      value?: string;
      onChangeText?: (v: string) => void;
      testId?: string;
    }) => (
      <label>
        {label}
        <input
          data-testid={testId}
          value={value}
          onChange={(e) => onChangeText?.(e.target.value)}
        />
      </label>
    ),
    Tooltip: ({ anchor }: { anchor?: ReactNode }) => <>{anchor}</>,
    NextLinkAnchor: ({
      href,
      children,
      target,
    }: {
      href: string;
      children?: ReactNode;
      target?: string;
    }) => (
      <a href={href} target={target}>
        {children}
      </a>
    ),
    useNotify: () => ({
      toast: { success: toastSuccess, danger: toastDanger },
    }),
    useTranslations: () => (key: string, args?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "admin.ppDetailWaiveVerification": "Waive verification",
        "admin.ppDetailWaiveConfirmTitle": "Waive verification?",
        "admin.ppDetailWaiveConfirmCta": "Waive without review",
        "admin.ppDetailWaiveCancelCta": "Don't waive",
        "admin.ppDetailWaiveNoteLabel": "Reason (optional)",
        "admin.ppDetailVerifyPlace": "Verify Place",
        "admin.ppDetailOverrideVerifyPlace": "Override: Verify Place",
        "admin.ppDetailReviewVerificationRequest":
          "Review Verification Request",
        "admin.ppDetailEdit": "Edit",
        "admin.ppMergeAction": "Merge into…",
        "admin.ppDetailOwnerEdits": "Its owner edits this place",
        "admin.ppDetailViewPage": "View place page",
        "communityPlacePage.editorTitle": "Edit place page",
        "admin.ppDetailArchivePlace": "Archive place",
        "admin.ppDetailRestorePlace": "Restore place",
        "admin.ppDetailRestoreConfirmCta": "Restore",
        "admin.ppDetailRestoreCancelCta": "Keep archived",
        "admin.ppDetailOpenActive": "Open the active one",
        "admin.ppDetailDirectorySwitch": "Shown in the places directory",
        "admin.ppDetailByModerator": "by a moderator",
        "communityCreate.pdArchiveBlocked": `${String(args?.count ?? "")} upcoming listings use this place`,
        "admin.ppDetailRefusedDuplicate":
          "Can’t restore: another place with this name is active within 50 m.",
        "admin.ppDetailArchivedNote":
          "Hidden from place search and the picker. Past listings still show it.",
        "common.close": "Close",
        "admin.ppDetailRestoreConfirmTitle": `Restore ${String(args?.name ?? "")}?`,
        "admin.ppDetailRestored": `${String(args?.name ?? "")} is back.`,
        "admin.ppDetailListingsUpcoming": `${String(args?.count ?? "")} upcoming`,
        "admin.ppDetailWaiveConfirmBody": `${String(args?.name ?? "")} will be marked verified`,
      };
      return dict[key] ?? key;
    },
  };
});

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown, t?: unknown) =>
    `${String(e)}${typeof t === "function" ? " [t]" : " [no t]"}`,
}));

vi.mock("@/lib/crypto-utils", () => ({
  buildFreshClientKey: () => "fresh-client-key-1234",
}));

vi.mock("@/lib/verification-config", () => ({
  VERIFICATION_ICON_MAP: new Proxy(
    {},
    { get: () => ({ Icon: () => <span />, color: "x", themeKey: "x" }) },
  ),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      platform: {
        listPlaces: { invalidate: listInvalidate, fetch: listPlacesFetch },
      },
      community: {
        getPlaceEditability: {
          invalidate: editabilityInvalidate,
          fetch: editabilityFetch,
        },
      },
    }),
    entityPages: {
      placePageEditAccess: {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => {
          pageAccessState.enabledCalls.push(Boolean(opts.enabled));
          return {
            data: opts.enabled ? pageAccessState.data : undefined,
          };
        },
      },
    },
    community: {
      getPlaceEditability: {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => {
          editabilityState.enabledCalls.push(Boolean(opts.enabled));
          const on = Boolean(opts.enabled);
          return {
            data: on ? editabilityState.data : undefined,
            error: on ? editabilityState.error : null,
            isError: on && editabilityState.error != null,
            refetch: vi.fn(),
          };
        },
      },
      restorePlace: {
        useMutation: () => ({
          mutateAsync: restoreMutateAsync,
          isPending: false,
        }),
      },
    },
    platform: {
      checkStaffAccess: {
        useQuery: () => ({
          data: { allowed: true, roles: staffRoles.current, actorHumanId: "a" },
        }),
      },
      updatePlaceVerificationStatus: {
        useMutation: () => ({
          mutateAsync: verifyMutateAsync,
          isPending: false,
        }),
      },
    },
    placeReviews: {
      toggleDirectoryListing: {
        useMutation: () => ({ mutate: toggleMutate, isPending: false }),
      },
    },
  },
}));

import { PlaceDetailPanel } from "../PlaceDetailPanel";

const place = (
  verificationStatus: PlaceVerificationStatus,
): PlatformPlaceRow => ({
  placeId: "00000000-0000-4000-8000-00000000d037",
  name: "Logan Square DIY",
  formattedAddress: "2500 N Milwaukee Ave",
  city: "Chicago",
  region: "IL",
  countryCode: "US",
  capacity: 180,
  status: "ACTIVE",
  verificationStatus,
  ownerCount: 2,
  listedInDirectory: false,
  publicPath: "/places/logan-square-diy",
});

function renderPanel(
  status: PlaceVerificationStatus,
  overrides: Partial<PlatformPlaceRow> = {},
  handlers: {
    onClose?: () => void;
    onOpenPlace?: (row: PlatformPlaceRow) => void;
  } = {},
) {
  return render(
    <PlaceDetailPanel
      place={{ ...place(status), ...overrides }}
      open
      onClose={handlers.onClose ?? vi.fn()}
      onMutated={vi.fn()}
      onOpenReview={vi.fn()}
      onOpenPlace={handlers.onOpenPlace ?? vi.fn()}
    />,
  );
}

const waiveTrigger = () =>
  screen.queryByTestId("platform-place-waive-verification");

/**
 * Press the confirm CTA and flush the async mutation handler, so the state
 * updates it schedules land inside `act` instead of leaking a warning.
 */
async function confirmWaive() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Waive without review" }),
    );
    // Flush the mutation promise chain inside `act` so the state updates it
    // schedules are not reported as unwrapped.
    await Promise.resolve();
  });
}

describe("PlaceDetailPanel — waive verification", () => {
  beforeEach(() => {
    verifyMutateAsync.mockClear();
    staffRoles.current = ["ADMIN"];
  });

  // ── Affordance gating ──────────────────────────────────────────────
  it.each(["UNVERIFIED", "REJECTED"] as const)(
    "offers Waive on %s",
    (status) => {
      renderPanel(status);
      expect(waiveTrigger()).toBeInTheDocument();
    },
  );

  it("does NOT offer Waive on PENDING — that place has an open request the server refuses to bypass", () => {
    renderPanel("PENDING");
    expect(waiveTrigger()).not.toBeInTheDocument();
    // The real path is still offered.
    expect(
      screen.getByRole("button", { name: "Review Verification Request" }),
    ).toBeInTheDocument();
  });

  it("does NOT offer Waive on VERIFIED", () => {
    renderPanel("VERIFIED");
    expect(waiveTrigger()).not.toBeInTheDocument();
  });

  it("hides Waive, Verify and Override from a SUPPORT-only actor (mutation is ADMIN/REVIEWER)", () => {
    staffRoles.current = ["SUPPORT"];
    renderPanel("UNVERIFIED");
    expect(waiveTrigger()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Verify Place" }),
    ).not.toBeInTheDocument();

    renderPanel("REJECTED");
    expect(
      screen.queryByRole("button", { name: "Override: Verify Place" }),
    ).not.toBeInTheDocument();
  });

  it("shows them to a REVIEWER", () => {
    staffRoles.current = ["REVIEWER"];
    renderPanel("UNVERIFIED");
    expect(waiveTrigger()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Verify Place" }),
    ).toBeInTheDocument();
  });

  // ── Confirmation dialog ────────────────────────────────────────────
  it("opens a confirmation naming the place rather than mutating on the first click", () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);

    expect(screen.getByText("Waive verification?")).toBeInTheDocument();
    expect(
      screen.getByText("Logan Square DIY will be marked verified"),
    ).toBeInTheDocument();
    expect(verifyMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps exactly ONE button named 'Waive verification' while the dialog is open, and disables it", () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);

    // Regression guard for the accessible-name collision: the confirm CTA
    // must NOT reuse the trigger's name.
    expect(
      screen.getAllByRole("button", { name: "Waive verification" }),
    ).toHaveLength(1);
    expect(waiveTrigger()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Waive without review" }),
    ).toBeInTheDocument();
  });

  // ── Mutation payload ───────────────────────────────────────────────
  it("sends reason WAIVED_DOCUMENT_REVIEW plus the sanitized-bound note", async () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);
    fireEvent.change(screen.getByTestId("platform-place-waive-note"), {
      target: { value: "  Owner confirmed on a call with ops  " },
    });
    await confirmWaive();

    expect(verifyMutateAsync).toHaveBeenCalledWith({
      placeId: "00000000-0000-4000-8000-00000000d037",
      verificationStatus: "VERIFIED",
      clientKey: "fresh-client-key-1234",
      reason: "WAIVED_DOCUMENT_REVIEW",
      note: "Owner confirmed on a call with ops",
    });
  });

  it("omits `note` entirely when the reason field is left blank", async () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);
    await confirmWaive();

    const payload = verifyMutateAsync.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("note");
    expect(payload?.reason).toBe("WAIVED_DOCUMENT_REVIEW");
  });

  it("omits `note` when the field holds only whitespace", async () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);
    fireEvent.change(screen.getByTestId("platform-place-waive-note"), {
      target: { value: "    " },
    });
    await confirmWaive();

    expect(verifyMutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("note");
  });

  it("gives the dialog's cancel its own name, and the panel one Close", () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);

    // Modal makes everything outside the topmost dialog inert and
    // aria-hidden (overlay/Modal.tsx), but this mock renders both layers.
    // Each layer's only "Close" is its header's X: a footer "Close" or a
    // cancel reusing the name would push the count past the header count.
    const headers = document.querySelectorAll("header");
    expect(headers.length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(
      headers.length,
    );
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Don't waive" }),
    ).toBeInTheDocument();
  });

  it("does not mutate when the confirmation is dismissed", () => {
    renderPanel("UNVERIFIED");
    fireEvent.click(waiveTrigger()!);
    fireEvent.click(screen.getByRole("button", { name: "Don't waive" }));

    expect(verifyMutateAsync).not.toHaveBeenCalled();
    // Dialog closed, trigger usable again.
    expect(waiveTrigger()).not.toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Place lifecycle (board v3, owner-approved 2026-10-14)
// ─────────────────────────────────────────────────────────────────────────────

const ID = "00000000-0000-4000-8000-00000000d037";
const DUP_ID = "00000000-0000-4000-8000-00000000d099";

function editability(over: Partial<Editability> = {}): Editability {
  return {
    placeId: ID,
    status: "ACTIVE",
    canEdit: true,
    canArchive: true,
    canRestore: false,
    reason: null,
    linkedListingCount: 0,
    duplicatePlaceId: null,
    archivedByModerator: false,
    statusChangedAt: null,
    ...over,
  };
}

const archivedEditability = (over: Partial<Editability> = {}) =>
  editability({
    status: "ARCHIVED",
    canEdit: false,
    canArchive: false,
    canRestore: true,
    archivedByModerator: true,
    statusChangedAt: "2026-10-14T15:00:00.000Z",
    ...over,
  });

function resetLifecycle() {
  staffRoles.current = ["ADMIN"];
  editabilityState.data = editability();
  editabilityState.error = null;
  editabilityState.enabledCalls = [];
  dialogMode.current = null;
  restoreMutateAsync.mockReset();
  restoreMutateAsync.mockImplementation(() => Promise.resolve({}));
  editabilityFetch.mockClear();
  listPlacesFetch.mockReset();
  listPlacesFetch.mockImplementation(() => Promise.resolve({ places: [] }));
  toggleMutate.mockClear();
  toastSuccess.mockClear();
  toastDanger.mockClear();
}

const ownerless = { ownerCount: 0 } as const;
const archivedOwnerless = { ownerCount: 0, status: "ARCHIVED" } as const;

describe("PlaceDetailPanel — header and details", () => {
  beforeEach(resetLifecycle);

  it("titles the panel with the place and its address, and links the public page in a new tab", () => {
    renderPanel("VERIFIED");
    expect(
      screen.getByRole("heading", { name: "Logan Square DIY" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2500 N Milwaukee Ave, Chicago, IL, US", {
        selector: "p",
      }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /View place page/ });
    expect(link).toHaveAttribute("href", "/places/logan-square-diy");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides the public link when the place has no page", () => {
    renderPanel("VERIFIED", { publicPath: null });
    expect(
      screen.queryByRole("link", { name: /View place page/ }),
    ).not.toBeInTheDocument();
  });

  it("has no text inputs and no Save for any place", () => {
    renderPanel("UNVERIFIED", ownerless);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("an owned place is read-only: says who edits it, no Edit, no Archive", () => {
    renderPanel("VERIFIED");
    expect(screen.getByText("Its owner edits this place")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Archive place/ }),
    ).not.toBeInTheDocument();
  });

  it("shows upcoming listings for an ownerless place", () => {
    editabilityState.data = editability({ linkedListingCount: 2 });
    renderPanel("UNVERIFIED", ownerless);
    expect(screen.getByText("2 upcoming")).toBeInTheDocument();
  });
});

describe("PlaceDetailPanel — who sees lifecycle actions", () => {
  beforeEach(resetLifecycle);

  it.each([["REVIEWER"], ["SUPPORT"], ["DEVELOPER"]])(
    "%s sees no Edit / Archive / Restore and never asks for editability",
    (role) => {
      staffRoles.current = [role];
      renderPanel("UNVERIFIED", ownerless);
      expect(editabilityState.enabledCalls.every((on) => !on)).toBe(true);
      expect(
        screen.queryByRole("button", { name: /Edit/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Archive place/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("ADMIN on an active ownerless place gets Edit and Archive", () => {
    renderPanel("UNVERIFIED", ownerless);
    expect(editabilityState.enabledCalls).toContain(true);
    expect(screen.getByRole("button", { name: /Edit/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Archive place/ }),
    ).toBeInTheDocument();
  });

  it("upcoming listings block Archive: the slot says why instead", () => {
    editabilityState.data = editability({
      canArchive: false,
      linkedListingCount: 2,
    });
    renderPanel("UNVERIFIED", ownerless);
    expect(
      screen.queryByRole("button", { name: /Archive place/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("2 upcoming listings use this place"),
    ).toBeInTheDocument();
  });

  it("address withheld: upcoming listings still say why Archive is missing", () => {
    editabilityState.data = editability({
      canEdit: false,
      canArchive: false,
      reason: "ADDRESS_WITHHELD",
      linkedListingCount: 2,
    });
    renderPanel("UNVERIFIED", ownerless);
    expect(screen.getByText("refused.withheld.title")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Archive place/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("2 upcoming listings use this place"),
    ).toBeInTheDocument();
  });

  it("a block other than the listings (owned events) shows no listings caption", () => {
    editabilityState.data = editability({
      canEdit: false,
      canArchive: false,
      reason: "OWNED_EVENTS_AT_PLACE",
      linkedListingCount: 2,
    });
    renderPanel("UNVERIFIED", ownerless);
    expect(
      screen.queryByTestId("platform-place-archive-blocked"),
    ).not.toBeInTheDocument();
  });

  it("the panel has exactly one Close (the header's X), never a footer twin", () => {
    editabilityState.data = archivedEditability();
    renderPanel("UNVERIFIED", { ownerCount: 0, status: "ARCHIVED" });
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("Edit stays focusable while editability is re-checked (aria-disabled, not disabled)", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    editabilityFetch.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)) as never,
    );
    renderPanel("UNVERIFIED", ownerless);
    const edit = screen.getByRole("button", { name: /Edit/ });
    edit.focus();
    fireEvent.click(edit);
    expect(edit).not.toBeDisabled();
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(edit);
    // A second press while checking does not ask twice.
    fireEvent.click(edit);
    expect(editabilityFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(editability());
      await Promise.resolve();
    });
  });

  it("SECOND_FACTOR_REQUIRED replaces the actions with the step-up notice", () => {
    editabilityState.data = undefined;
    editabilityState.error = { data: { appCode: "SECOND_FACTOR_REQUIRED" } };
    renderPanel("UNVERIFIED", ownerless);
    expect(
      screen.getByTestId("place-second-factor-notice"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Archive place/ }),
    ).not.toBeInTheDocument();
  });
});

describe("PlaceDetailPanel — edit and archive open the shared PlaceDialog", () => {
  beforeEach(resetLifecycle);

  it("Edit asks editability again, then opens PlaceDialog in edit mode at the form", async () => {
    editabilityState.data = editability({ linkedListingCount: 3 });
    renderPanel("UNVERIFIED", ownerless);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
      await Promise.resolve();
    });
    expect(editabilityFetch).toHaveBeenCalledTimes(1);
    expect(dialogMode.current).toMatchObject({
      kind: "edit",
      canEdit: true,
      canArchive: true,
      linkedListingCount: 3,
      startAt: "form",
      place: { placeId: ID, name: "Logan Square DIY" },
    });
  });

  it("Archive place opens PlaceDialog on its archive confirm", async () => {
    renderPanel("UNVERIFIED", ownerless);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Archive place/ }));
      await Promise.resolve();
    });
    expect(dialogMode.current).toMatchObject({
      kind: "edit",
      startAt: "archive",
    });
  });
});

describe("PlaceDetailPanel — archived place", () => {
  beforeEach(resetLifecycle);

  it("shows the Archived badge, the date by a moderator, and hides Verification and Directory", () => {
    editabilityState.data = archivedEditability();
    renderPanel("UNVERIFIED", archivedOwnerless);
    expect(
      screen.getByText("admin.ppDetailStatusArchived"),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-10-14")).toBeInTheDocument();
    expect(screen.getByText(/by a moderator/)).toBeInTheDocument();
    expect(
      screen.queryByText("admin.ppDetailSectionVerification"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(waiveTrigger()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Verify Place/ }),
    ).not.toBeInTheDocument();
  });

  it("Restore place is the one primary; confirm then restore with a client key", async () => {
    editabilityState.data = archivedEditability();
    const onClose = vi.fn();
    renderPanel("UNVERIFIED", archivedOwnerless, { onClose });
    fireEvent.click(screen.getByRole("button", { name: /Restore place/ }));
    expect(screen.getByText("Restore Logan Square DIY?")).toBeInTheDocument();
    expect(restoreMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      await Promise.resolve();
    });
    expect(restoreMutateAsync).toHaveBeenCalledWith({
      placeId: ID,
      clientKey: "fresh-client-key-1234",
    });
    expect(toastSuccess).toHaveBeenCalledWith({
      title: "Logan Square DIY is back.",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("a refused restore toasts the error through the translator", async () => {
    editabilityState.data = archivedEditability();
    restoreMutateAsync.mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );
    renderPanel("UNVERIFIED", archivedOwnerless);
    fireEvent.click(screen.getByRole("button", { name: /Restore place/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      await Promise.resolve();
    });
    expect(toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Error: boom [t]" }),
    );
  });

  it("a restore that needs the second factor shows the notice instead of a toast", async () => {
    editabilityState.data = archivedEditability();
    restoreMutateAsync.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("step-up"), {
          data: { appCode: "SECOND_FACTOR_REQUIRED" },
        }),
      ),
    );
    renderPanel("UNVERIFIED", archivedOwnerless);
    fireEvent.click(screen.getByRole("button", { name: /Restore place/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      await Promise.resolve();
    });
    expect(
      screen.getByTestId("place-second-factor-notice"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Restore place/ }),
    ).not.toBeInTheDocument();
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("not archived by a moderator (owner ruling 2026-10-14): an ADMIN still gets Restore, and the date stands alone", () => {
    editabilityState.data = archivedEditability({ archivedByModerator: false });
    renderPanel("UNVERIFIED", archivedOwnerless);
    expect(screen.getByText("2026-10-14")).toBeInTheDocument();
    expect(screen.queryByText(/by a moderator/)).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Restore place/ }),
    ).toBeInTheDocument();
  });

  it("claim pending: the shared refusal copy replaces Restore", () => {
    editabilityState.data = archivedEditability({
      canRestore: false,
      reason: "CLAIM_PENDING",
    });
    renderPanel("UNVERIFIED", archivedOwnerless);
    expect(screen.getByText("refused.claim.title")).toBeInTheDocument();
    expect(screen.getByText("refused.claim.body")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Restore place/ }),
    ).not.toBeInTheDocument();
  });

  it("duplicate active: says so and opens the active place's panel", async () => {
    editabilityState.data = archivedEditability({
      canRestore: false,
      reason: "DUPLICATE_ACTIVE",
      duplicatePlaceId: DUP_ID,
    });
    const dupRow = { ...place("VERIFIED"), placeId: DUP_ID };
    listPlacesFetch.mockImplementation(() =>
      Promise.resolve({ places: [dupRow] }),
    );
    const onOpenPlace = vi.fn();
    renderPanel("UNVERIFIED", archivedOwnerless, { onOpenPlace });
    expect(
      screen.getByText(
        "Can’t restore: another place with this name is active within 50 m.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/by a moderator/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Restore place/ }),
    ).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Open the active one/ }),
      );
      await Promise.resolve();
    });
    // The exact by-id read: no name search, no status filter.
    expect(listPlacesFetch).toHaveBeenCalledWith(
      { placeIds: [DUP_ID], limit: 1, offset: 0 },
      { staleTime: 0 },
    );
    expect(onOpenPlace).toHaveBeenCalledWith(dupRow);
  });

  it("duplicate active: a place the read no longer returns toasts instead of opening", async () => {
    editabilityState.data = archivedEditability({
      canRestore: false,
      reason: "DUPLICATE_ACTIVE",
      duplicatePlaceId: DUP_ID,
    });
    const onOpenPlace = vi.fn();
    renderPanel("UNVERIFIED", archivedOwnerless, { onOpenPlace });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Open the active one/ }),
      );
      await Promise.resolve();
    });
    expect(listPlacesFetch).toHaveBeenCalledWith(
      expect.objectContaining({ placeIds: [DUP_ID] }),
      { staleTime: 0 },
    );
    expect(onOpenPlace).not.toHaveBeenCalled();
    expect(toastDanger).toHaveBeenCalledTimes(1);
  });
});

describe("PlaceDetailPanel — directory switch", () => {
  beforeEach(resetLifecycle);

  it("is a labelled switch wired to toggleDirectoryListing", () => {
    renderPanel("VERIFIED");
    const sw = screen.getByRole("switch", {
      name: "Shown in the places directory",
    });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(toggleMutate).toHaveBeenCalledWith({
      placeId: ID,
      listedInDirectory: true,
    });
  });
});

describe("PlaceDetailPanel — one primary", () => {
  beforeEach(resetLifecycle);

  it("an unverified active place shows Verify and no footer primary", () => {
    renderPanel("UNVERIFIED", ownerless);
    expect(
      screen.getByRole("button", { name: /Verify Place/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Restore place/ }),
    ).not.toBeInTheDocument();
  });
});

describe("PlaceDetailPanel — merge into another place", () => {
  beforeEach(() => {
    resetLifecycle();
    mergeDialogProps.current = null;
    listInvalidate.mockClear();
    editabilityInvalidate.mockClear();
  });

  it("offers Merge into… to ADMIN, on owned and archived places too", () => {
    const { unmount } = renderPanel("VERIFIED");
    expect(
      screen.getByRole("button", { name: /Merge into…/ }),
    ).toBeInTheDocument();
    unmount();
    renderPanel("UNVERIFIED", { status: "ARCHIVED", ownerCount: 0 });
    expect(
      screen.getByRole("button", { name: /Merge into…/ }),
    ).toBeInTheDocument();
  });

  it("hides it from staff who are not ADMIN", () => {
    staffRoles.current = ["REVIEWER"];
    renderPanel("VERIFIED");
    expect(
      screen.queryByRole("button", { name: /Merge into…/ }),
    ).not.toBeInTheDocument();
  });

  it("opens the dialog, and a merge moves the panel to the survivor", async () => {
    const survivorRow = {
      ...place("VERIFIED"),
      placeId: "00000000-0000-4000-8000-0000000000aa",
      name: "Logan Square DIY (main)",
    };
    listPlacesFetch.mockResolvedValueOnce({ places: [survivorRow] });
    const onOpenPlace = vi.fn();
    renderPanel("VERIFIED", {}, { onOpenPlace });
    expect(screen.queryByTestId("place-merge-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Merge into…/ }));
    expect(screen.getByTestId("place-merge-dialog")).toBeInTheDocument();

    await act(async () => {
      mergeDialogProps.current!.onMerged({ survivorId: survivorRow.placeId });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Read fresh: a cached row would predate the merge.
    expect(listPlacesFetch).toHaveBeenCalledWith(
      expect.objectContaining({ placeIds: [survivorRow.placeId] }),
      { staleTime: 0 },
    );
    expect(onOpenPlace).toHaveBeenCalledWith(survivorRow);
    expect(editabilityInvalidate).toHaveBeenCalledWith({
      placeId: survivorRow.placeId,
    });
    // The list refreshes only after the panel has moved, so the deleted
    // place never re-reads into a not-found flash.
    expect(listInvalidate).toHaveBeenCalled();
    expect(onOpenPlace.mock.invocationCallOrder[0]!).toBeLessThan(
      listInvalidate.mock.invocationCallOrder[0]!,
    );
    expect(screen.queryByTestId("place-merge-dialog")).not.toBeInTheDocument();
  });

  it("closes the panel when the survivor cannot be read", async () => {
    listPlacesFetch.mockResolvedValueOnce({ places: [] });
    const onClose = vi.fn();
    const onOpenPlace = vi.fn();
    renderPanel("VERIFIED", {}, { onClose, onOpenPlace });
    fireEvent.click(screen.getByRole("button", { name: /Merge into…/ }));
    await act(async () => {
      mergeDialogProps.current!.onMerged({
        survivorId: "00000000-0000-4000-8000-0000000000bb",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOpenPlace).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(listInvalidate).toHaveBeenCalled();
  });
});

describe("PlaceDetailPanel — moderator page editor link (moderator-place-page D8)", () => {
  beforeEach(() => {
    resetLifecycle();
    pageAccessState.data = undefined;
    pageAccessState.enabledCalls = [];
  });

  it("links an ADMIN to the moderator editor when the probe says community_moderator", () => {
    pageAccessState.data = {
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    };
    renderPanel("UNVERIFIED", ownerless);
    const link = screen.getByRole("link", { name: /Edit place page/ });
    expect(link).toHaveAttribute(
      "href",
      "/moderate/places/00000000-0000-4000-8000-00000000d037/page",
    );
    expect(link).not.toHaveAttribute("target");
  });

  it("shows no link when the probe refuses (claim pending)", () => {
    pageAccessState.data = {
      canEditPage: false,
      editorKind: null,
      reason: "CLAIM_PENDING",
    };
    renderPanel("UNVERIFIED", ownerless);
    expect(
      screen.queryByRole("link", { name: /Edit place page/ }),
    ).not.toBeInTheDocument();
  });

  it("never asks for an owned place, an archived one, or a non-ADMIN", () => {
    pageAccessState.data = {
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    };
    const owned = renderPanel("VERIFIED");
    owned.unmount();
    const archived = renderPanel("UNVERIFIED", archivedOwnerless);
    archived.unmount();
    staffRoles.current = ["REVIEWER"];
    renderPanel("UNVERIFIED", ownerless);
    staffRoles.current = ["ADMIN"];
    expect(pageAccessState.enabledCalls).not.toContain(true);
    expect(
      screen.queryByRole("link", { name: /Edit place page/ }),
    ).not.toBeInTheDocument();
  });
});
