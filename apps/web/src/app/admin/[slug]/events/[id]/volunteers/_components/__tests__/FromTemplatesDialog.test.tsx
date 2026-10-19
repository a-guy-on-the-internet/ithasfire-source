import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-017 — the apply dialog resolves ANCHORS, not wall clocks.
 *
 * The release-ordering hazard this locks down: the dialog used to call
 * `materializeTemplateShift`, which ignores `anchor` / `offsetMinutes`. On an
 * anchored preset the stored minute-of-day fields carry only the DURATION, so
 * an EVENT_START −180 preset stored as (16:00, 18:30) materialized as
 * "16:00–18:30 on the event day" — wrong times, silently, with no error.
 */

const CHICAGO = "America/Chicago";
/** 2026-06-12, 20:00 America/Chicago (CDT, UTC−5). */
const EVENT_STARTS_AT = new Date("2026-06-13T01:00:00.000Z");

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const EVENT_ID = "99999999-9999-4999-8999-999999999999";
const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_ID = "33333333-3333-4333-8333-333333333333";

interface Preset {
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  capacity: number | null;
  anchor: "WALL_CLOCK" | "EVENT_START" | "EVENT_END";
  offsetMinutes: number;
}

/** Load-in: three hours before the show, lasting 2h30. */
const loadIn: Preset = {
  label: "Load-in",
  startMinuteOfDay: 16 * 60,
  endMinuteOfDay: 18 * 60 + 30,
  startDayOffset: 0,
  endsNextDay: false,
  capacity: 2,
  anchor: "EVENT_START",
  offsetMinutes: -180,
};

/** Strike: at the end of the show. Unschedulable without an end time. */
const strike: Preset = {
  label: "Strike",
  startMinuteOfDay: 23 * 60,
  endMinuteOfDay: 24 * 60 - 1,
  startDayOffset: 0,
  endsNextDay: false,
  capacity: null,
  anchor: "EVENT_END",
  offsetMinutes: 0,
};

const testState = vi.hoisted(() => ({
  presets: [] as unknown[],
  mutateOptions: null as { onSuccess?: (data: unknown) => void } | null,
  mutate: vi.fn(),
}));

/**
 * The mock forwards `onKeyDown` / `tabIndex` as well as the ARIA attributes.
 *
 * It used to drop them, which is exactly how a `handleTemplateKeyDown` that
 * destructured `preventDefault` off the SyntheticEvent — and therefore threw a
 * TypeError on every Enter/Space, leaving no template selectable by keyboard —
 * shipped with a green suite.
 */
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => {
    const safe: Record<string, unknown> = { onClick: onPress };
    for (const [key, value] of Object.entries(props)) {
      if (
        key === "role" ||
        key === "data-testid" ||
        key === "onKeyDown" ||
        key === "tabIndex" ||
        key.startsWith("aria-")
      ) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Modal: Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <h1>{title}</h1>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  ),
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={rest["data-testid"]}>{children}</span>,
  useFormatters: () => ({ dateTime: () => "FORMATTED" }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      templates: {
        list: {
          useQuery: () => ({
            data: [
              {
                id: TEMPLATE_ID,
                name: "Load-in crew",
                description: null,
                defaultCapacity: null,
                archived: false,
                isPlatform: true,
                packId: "88888888-8888-4888-8888-888888888888",
              },
            ],
            isLoading: false,
            isError: false,
          }),
        },
      },
      roles: {
        createFromTemplates: {
          useMutation: (options: { onSuccess?: (data: unknown) => void }) => {
            testState.mutateOptions = options;
            return { mutate: testState.mutate, isPending: false };
          },
        },
      },
    },
    volunteerPacks: {
      list: {
        useQuery: () => ({
          data: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              key: "house-show",
              name: "House show",
              roles: [{ id: TEMPLATE_ID, shifts: testState.presets }],
            },
          ],
          isLoading: false,
          isError: false,
        }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { FromTemplatesDialog } from "../FromTemplatesDialog";

function renderDialog(overrides?: {
  eventEndsAt?: Date | null;
  onSuccess?: (seeded: unknown) => void;
}) {
  return render(
    <FromTemplatesDialog
      open
      orgId={ORG_ID}
      eventId={EVENT_ID}
      eventStartsAt={EVENT_STARTS_AT}
      eventEndsAt={overrides?.eventEndsAt ?? null}
      eventTimezone={CHICAGO}
      onClose={vi.fn()}
      onSuccess={overrides?.onSuccess ?? vi.fn()}
    />,
  );
}

describe("FromTemplatesDialog — anchored shift resolution", () => {
  beforeEach(() => {
    testState.presets = [];
    testState.mutateOptions = null;
    testState.mutate.mockReset();
  });

  it("resolves an EVENT_START −180 preset against the event, not its stored wall clock", () => {
    testState.presets = [loadIn];
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });

    fireEvent.click(
      screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`),
    );
    fireEvent.click(
      screen.getByText("admin.volunteerRoleDialogFromTemplatesCta"),
    );

    expect(testState.mutate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      templateIds: [TEMPLATE_ID],
    });

    testState.mutateOptions?.onSuccess?.({
      templateShiftsByRoleId: { [ROLE_ID]: [loadIn] },
    });

    const seeded = onSuccess.mock.calls[0]?.[0] as {
      byRoleId: Record<
        string,
        Array<{ label: string; startsAtIso: string; endsAtIso: string }>
      >;
      skipped: unknown[];
    };

    // 20:00 CDT show − 3h = 17:00 CDT = 22:00Z. The pre-fix wall-clock path
    // would have produced 16:00 CDT (21:00Z) — the exact silent bug.
    expect(seeded.byRoleId[ROLE_ID]).toEqual([
      {
        label: "Load-in",
        startsAtIso: "2026-06-12T22:00:00.000Z",
        endsAtIso: "2026-06-13T00:30:00.000Z",
        capacity: 2,
      },
    ]);
    expect(seeded.skipped).toHaveLength(0);
  });

  it("disables an EVENT_END preset with a stated reason when the date has no end time", () => {
    testState.presets = [strike];
    renderDialog({ eventEndsAt: null });

    const row = screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.queryByTestId(`volunteer-template-option-${TEMPLATE_ID}-blocked`)
        ?.textContent,
    ).toBe("admin.volunteerShiftAnchorMissingEventEnd");

    // Clicking a blocked row must not select it, and confirm stays disabled.
    fireEvent.click(row);
    expect(row.getAttribute("aria-checked")).toBe("false");
    const confirm = screen.getByText(
      "admin.volunteerRoleDialogFromTemplatesCta",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(testState.mutate).not.toHaveBeenCalled();
  });

  it("keeps an EVENT_END preset applicable once the date has an end time", () => {
    testState.presets = [strike];
    renderDialog({ eventEndsAt: new Date("2026-06-13T04:00:00.000Z") });

    const row = screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(
      screen.queryByTestId(`volunteer-template-option-${TEMPLATE_ID}-blocked`),
    ).toBeNull();
  });

  it("reports a preset it could not resolve instead of writing a guessed time", () => {
    testState.presets = [];
    const onSuccess = vi.fn();
    renderDialog({ eventEndsAt: null, onSuccess });

    fireEvent.click(
      screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`),
    );
    fireEvent.click(
      screen.getByText("admin.volunteerRoleDialogFromTemplatesCta"),
    );

    // An org-owned template's presets are only known AFTER the mutation, so
    // this is the backstop path: unresolvable presets are skipped and named.
    testState.mutateOptions?.onSuccess?.({
      templateShiftsByRoleId: { [ROLE_ID]: [loadIn, strike] },
    });

    const seeded = onSuccess.mock.calls[0]?.[0] as {
      byRoleId: Record<string, unknown[]>;
      skipped: Array<{ label: string; reason: string }>;
    };

    expect(seeded.byRoleId[ROLE_ID]).toHaveLength(1);
    expect(seeded.skipped).toEqual([
      { roleId: ROLE_ID, label: "Strike", reason: "missing_event_end" },
    ]);
  });
});

describe("FromTemplatesDialog — keyboard selection", () => {
  beforeEach(() => {
    testState.presets = [];
    testState.mutateOptions = null;
    testState.mutate.mockReset();
  });

  it("selects a template row with Space", () => {
    testState.presets = [loadIn];
    renderDialog();

    const row = screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`);
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-checked")).toBe("false");

    fireEvent.keyDown(row, { key: " " });

    expect(row.getAttribute("aria-checked")).toBe("true");
    const confirm = screen.getByText(
      "admin.volunteerRoleDialogFromTemplatesCta",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it("deselects with Enter", () => {
    testState.presets = [loadIn];
    renderDialog();

    const row = screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps a blocked row reachable but inert", () => {
    testState.presets = [strike];
    renderDialog({ eventEndsAt: null });

    const row = screen.getByTestId(`volunteer-template-option-${TEMPLATE_ID}`);
    // Reachable: `tabIndex={-1}` would hide the row — and the stated reason it
    // can't be used — from a keyboard/screen-reader user entirely.
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(row, { key: " " });

    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(testState.mutate).not.toHaveBeenCalled();
  });
});
