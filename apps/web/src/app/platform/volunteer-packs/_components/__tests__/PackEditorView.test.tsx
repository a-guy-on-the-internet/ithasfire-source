import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-014 / FR-016 — the pack editor's two load-bearing behaviours.
 *
 * 1. What SAVE sends. Everything a catalogue shift carries has to survive the
 *    round trip, because `upsertVolunteerPack` reconciles shifts as a
 *    replace-set: a field the editor forgets to read is a field the next typo
 *    fix silently deletes. `notes` and `anchor`/`offsetMinutes` are the two
 *    that would go quietly.
 * 2. That the preview shows the SAVED pack through the organizer's own
 *    component, DRAFT included.
 */

const PACK_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  upsert: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
  toastDanger: vi.fn(),
  status: "DRAFT" as "DRAFT" | "LIVE",
  roles: true,
}));

const pack = () => ({
  id: PACK_ID,
  key: "house-show",
  name: "House show",
  blurb: "Six roles for a living-room gig.",
  status: state.status,
  targetCategoryIds: [] as string[],
  rankFirst: false,
  sortOrder: 3,
  curatedByHumanId: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  roles: state.roles ? packRoles() : [],
});

const packRoles = () => [
  {
    id: "role-1",
    orgId: null,
    name: "Load-in",
    description: "Carry the gear.",
    defaultCapacity: 3,
    sortOrder: 0,
    archived: false,
    isPlatform: true,
    packId: PACK_ID,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    shifts: [
      {
        id: "shift-1",
        templateId: "role-1",
        label: "Load-in",
        // Anchored: these two carry the DURATION (2 h), not a wall clock.
        startMinuteOfDay: 720,
        endMinuteOfDay: 840,
        // Day BEFORE the show — the field that had no round-trip assertion.
        startDayOffset: -1,
        endsNextDay: false,
        capacity: 2,
        position: 0,
        anchor: "EVENT_START" as const,
        offsetMinutes: -180,
        notes: "Park round the back.",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ],
  },
];

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={rest["data-testid"]}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  Modal: Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <h1>{title}</h1>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  ),
  MultiChipGroup: () => <div />,
  Spinner: () => <span />,
  Switch: () => <input type="checkbox" readOnly />,
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={rest["data-testid"]}>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Tooltip: ({ anchor }: { anchor?: ReactNode }) => <>{anchor}</>,
  useFormatters: () => ({ dateTime: () => "" }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: state.toastDanger, warning: vi.fn() },
  }),
  // Category names are picked by locale (category-display-name).
  useLocale: () => "en",
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteerPacks: {
      admin: {
        list: {
          useQuery: () => ({
            data: {
              packs: [
                { ...pack(), roleCount: 1, forkCount: 0, roles: undefined },
              ],
            },
            isLoading: false,
            error: null,
          }),
        },
        get: {
          useQuery: () => ({
            data: { pack: pack() },
            isLoading: false,
            error: null,
          }),
        },
        upsert: {
          useMutation: () => ({ mutateAsync: state.upsert, isPending: false }),
        },
        setStatus: {
          useMutation: () => ({
            mutateAsync: state.setStatus,
            isPending: false,
          }),
        },
        remove: {
          useMutation: () => ({ mutateAsync: state.remove, isPending: false }),
        },
      },
    },
    categories: {
      list: { useQuery: () => ({ data: { categories: [] } }) },
    },
    useUtils: () => ({
      volunteerPacks: {
        admin: {
          list: { invalidate: vi.fn() },
          get: { invalidate: vi.fn() },
        },
        list: { invalidate: vi.fn() },
      },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

// Rendered rather than stubbed to null: whether the confirm STAYS OPEN after a
// failed delete is the behaviour under test.
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open?: boolean;
    onConfirm?: () => void;
  }) =>
    open ? (
      <button
        type="button"
        data-testid="volunteer-pack-delete-confirm"
        onClick={onConfirm}
      />
    ) : null,
}));

vi.mock("../volunteer-packs.module.css", () => ({
  default: { editorColumns: "editorColumns" },
}));

import { PackEditorView } from "../PackEditorView";

describe("PackEditorView", () => {
  beforeEach(() => {
    state.upsert.mockReset();
    state.upsert.mockResolvedValue({ pack: pack() });
    state.setStatus.mockReset();
    state.setStatus.mockResolvedValue({ pack: pack() });
    state.remove.mockReset();
    state.remove.mockResolvedValue(undefined);
    state.toastDanger.mockReset();
    state.status = "DRAFT";
    state.roles = true;
  });

  it("round-trips every field a catalogue shift carries", async () => {
    render(<PackEditorView packKey="house-show" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("volunteer-pack-save"));
    });

    expect(state.upsert).toHaveBeenCalledTimes(1);
    const payload = state.upsert.mock.calls[0]![0];

    expect(payload.key).toBe("house-show");
    expect(payload.name).toBe("House show");
    expect(payload.sortOrder).toBe(3);

    const [role] = payload.roles;
    expect(role.name).toBe("Load-in");
    expect(role.description).toBe("Carry the gear.");
    expect(role.defaultCapacity).toBe(3);

    const [shift] = role.shifts;
    // The anchor is the whole point of the preset — flattening it to
    // WALL_CLOCK on a save would reschedule load-in for every organizer.
    expect(shift.anchor).toBe("EVENT_START");
    expect(shift.offsetMinutes).toBe(-180);
    expect(shift.startMinuteOfDay).toBe(720);
    expect(shift.endMinuteOfDay).toBe(840);
    expect(shift.capacity).toBe(2);
    // Dropping the day offset would move a load-in booked for the day BEFORE
    // the show onto the show itself.
    expect(shift.startDayOffset).toBe(-1);
    // Derived from the times, never seeded — asserted so a future "seed it
    // from the server" change has to confront the round trip deliberately.
    expect(shift.endsNextDay).toBe(false);
    // Replace-set ordering: `position` is the row index, not the stored id.
    expect(shift.position).toBe(0);
    // `upsertVolunteerPack` writes `notes: shift.notes ?? null`, so an editor
    // that never read the column would wipe this on the first typo fix.
    expect(shift.notes).toBe("Park round the back.");
  });

  it("blocks Publish while the editor is dirty, but never Unpublish", () => {
    const { unmount } = render(<PackEditorView packKey="house-show" />);

    const toggle = () =>
      screen.getByTestId("volunteer-pack-toggle-status") as HTMLButtonElement;
    expect(toggle().disabled).toBe(false);

    fireEvent.change(screen.getByTestId("volunteer-pack-name"), {
      target: { value: "House show (revised)" },
    });

    // `setStatus` ships the last SAVED pack, so publishing here would put a
    // pack live platform-wide that does not match what is on screen.
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId("volunteer-pack-publish-blocked")).toBeTruthy();
    fireEvent.click(toggle());
    expect(state.setStatus).not.toHaveBeenCalled();

    unmount();

    // The gate is DIRECTIONAL. Pulling a live pack down is the safe direction
    // and must stay reachable — forcing a save first would push the very edits
    // the curator is retreating from into the live pack.
    state.status = "LIVE";
    render(<PackEditorView packKey="house-show" />);
    fireEvent.change(screen.getByTestId("volunteer-pack-name"), {
      target: { value: "House show (revised)" },
    });
    expect(
      (screen.getByTestId("volunteer-pack-toggle-status") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByTestId("volunteer-pack-publish-blocked")).toBeNull();
  });

  it("shows the authored copy for a typed error code, and keeps the confirm open", async () => {
    // `fail()` sets `message = code`, so this is the shape the client sees.
    state.remove.mockRejectedValue(
      Object.assign(new Error("VOLUNTEER_PACK_HAS_PLATFORM_ROLES"), {
        data: { appCode: "VOLUNTEER_PACK_HAS_PLATFORM_ROLES" },
      }),
    );

    render(<PackEditorView packKey="house-show" />);
    fireEvent.click(screen.getByTestId("volunteer-pack-delete-open"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("volunteer-pack-delete-confirm"));
    });

    // Not `formatErrorMessage`'s generic fallback (mocked to "err" above): the
    // catalogues already carry copy for this code and the curator must see it.
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]![0].message).toBe(
      "errors.volunteerPackHasPlatformRoles",
    );
    // The dialog stays put — the fix for this failure is "remove the roles",
    // and the curator comes straight back to this button.
    expect(screen.getByTestId("volunteer-pack-delete-confirm")).toBeTruthy();
  });

  it("does not preview a role-less pack as a card an organizer would never see", () => {
    state.roles = false;
    render(<PackEditorView packKey="house-show" />);

    fireEvent.click(screen.getByTestId("volunteer-pack-preview-open"));

    // `PackPickerGrid` filters `roles.length > 0`, so rendering the card here
    // would be the preview telling the one lie it exists to prevent.
    expect(screen.queryByTestId("volunteer-pack-preview")).toBeNull();
    expect(screen.getByTestId("volunteer-pack-preview-no-roles")).toBeTruthy();
  });

  it("refuses to save two roles with the same name", async () => {
    render(<PackEditorView packKey="house-show" />);

    fireEvent.click(screen.getByTestId("volunteer-pack-add-role"));
    fireEvent.change(screen.getByTestId("volunteer-pack-role-1-name"), {
      target: { value: "load-IN" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("volunteer-pack-save"));
    });

    // Mirrors the partial unique index, so the curator gets a sentence rather
    // than a raw constraint violation from Postgres.
    expect(state.upsert).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("volunteer-pack-save-error").textContent,
    ).toContain("volunteerPackRoleNameDuplicate");
  });

  it("previews a DRAFT pack through the organizer's own catalogue component", () => {
    render(<PackEditorView packKey="house-show" />);

    fireEvent.click(screen.getByTestId("volunteer-pack-preview-open"));

    // FR-016: status gates nothing here — a draft previews.
    expect(screen.getByTestId("volunteer-pack-preview")).toBeTruthy();
    const card = screen.getByTestId("volunteer-pack-house-show");
    expect(card.textContent).toContain("Load-in");
    expect(card.textContent).toContain("Six roles for a living-room gig.");
  });

  it("warns that the preview is the saved version once the editor is dirty", () => {
    render(<PackEditorView packKey="house-show" />);

    expect(screen.queryByTestId("volunteer-pack-dirty")).toBeNull();

    fireEvent.change(screen.getByTestId("volunteer-pack-name"), {
      target: { value: "House show (revised)" },
    });
    expect(screen.getByTestId("volunteer-pack-dirty")).toBeTruthy();

    fireEvent.click(screen.getByTestId("volunteer-pack-preview-open"));
    // The one lie a preview must never tell: showing local edits as if an
    // organizer could already see them.
    expect(screen.getByTestId("volunteer-pack-preview-stale")).toBeTruthy();
  });
});
