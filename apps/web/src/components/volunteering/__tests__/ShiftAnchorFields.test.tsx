import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * FR-017 — the anchor control and its resolved preview.
 *
 * The acceptance criterion in words: a shift anchored EVENT_START −180
 * resolves to 17:00 for a 20:00 show and 11:00 for a 14:00 matinee. That is
 * exactly what the two contrasting preview rows have to show, because it is
 * the thing a wall-clock preset gets wrong.
 */

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
  // Real Intl so the preview strings are the actual resolved wall clocks.
  useFormatters: () => ({
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
  }),
  useTranslations: () => (key: string) => key,
}));

import {
  ShiftAnchorFields,
  ShiftAnchorPreview,
  useSampleShowtimeTargets,
} from "../ShiftAnchorFields";
import {
  emptyShiftDraftFields,
  type ShiftDraftFields,
} from "@/lib/template-shift-offset";

function Harness({ initial }: { initial: Partial<ShiftDraftFields> }) {
  const [fields, setFields] = useState<ShiftDraftFields>({
    ...emptyShiftDraftFields(),
    ...initial,
  });
  const previewTargets = useSampleShowtimeTargets();
  return (
    <>
      <ShiftAnchorFields
        fields={fields}
        onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}
        testIdBase="shift-0"
      />
      <ShiftAnchorPreview
        fields={fields}
        previewTargets={previewTargets}
        testIdBase="shift-0"
      />
    </>
  );
}

/**
 * The composer's "Time it from the event" shape: `fields` live in the PARENT
 * and the control is unmounted on Cancel. Anything the control remembers only
 * in its own `useState` is gone on reopen.
 */
function RemountHarness({ initial }: { initial: Partial<ShiftDraftFields> }) {
  const [fields, setFields] = useState<ShiftDraftFields>({
    ...emptyShiftDraftFields(),
    ...initial,
  });
  const [open, setOpen] = useState(true);
  const previewTargets = useSampleShowtimeTargets();
  return (
    <>
      <button data-testid="toggle" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      {open ? (
        <ShiftAnchorFields
          fields={fields}
          onChange={(patch) =>
            setFields((current) => ({ ...current, ...patch }))
          }
          testIdBase="shift-0"
          anchorOptions={["EVENT_START", "EVENT_END"]}
        />
      ) : null}
      <ShiftAnchorPreview
        fields={fields}
        previewTargets={previewTargets}
        testIdBase="shift-0"
      />
    </>
  );
}

describe("ShiftAnchorFields", () => {
  it("resolves an EVENT_START −180 preset differently for each showtime", () => {
    render(
      <Harness
        initial={{
          label: "Load-in",
          // Anchored: these two carry the DURATION (2h30), not a wall clock.
          startTime: "16:00",
          endTime: "18:30",
          anchor: "EVENT_START",
          offsetMinutes: "-180",
        }}
      />,
    );

    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    const matinee = screen.getByTestId("shift-0-preview-matinee").textContent;

    // 20:00 − 3h = 17:00, lasting 2h30 → 19:30.
    expect(evening).toContain("5:00 PM");
    expect(evening).toContain("7:30 PM");
    // 14:00 − 3h = 11:00 → 13:30. The same preset, a different clock —
    // which a wall-clock preset could never express.
    expect(matinee).toContain("11:00 AM");
    expect(matinee).toContain("1:30 PM");
  });

  it("shows a wall-clock preset reading the same against both showtimes", () => {
    render(
      <Harness
        initial={{
          label: "Doors",
          startTime: "18:00",
          endTime: "19:00",
          anchor: "WALL_CLOCK",
        }}
      />,
    );

    expect(screen.getByTestId("shift-0-preview-evening").textContent).toContain(
      "6:00 PM",
    );
    expect(screen.getByTestId("shift-0-preview-matinee").textContent).toContain(
      "6:00 PM",
    );
  });

  it("hides the offset and duration fields on a wall-clock preset", () => {
    render(<Harness initial={{ startTime: "18:00", endTime: "19:00" }} />);

    expect(screen.queryByTestId("shift-0-offset-hours")).toBeNull();
    expect(screen.queryByTestId("shift-0-duration-hours")).toBeNull();
  });

  it("seeds a duration when the row is switched to an anchored mode", () => {
    render(<Harness initial={{}} />);

    fireEvent.change(screen.getByTestId("shift-0-anchor"), {
      target: { value: "EVENT_START" },
    });

    // An anchored preset still needs both minute-of-day columns; without a
    // seeded duration the row would fail validation against fields the
    // editor no longer shows.
    expect(
      (screen.getByTestId("shift-0-duration-hours") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      (screen.getByTestId("shift-0-duration-minutes") as HTMLInputElement)
        .value,
    ).toBe("0");
  });

  it("keeps the offset signed by the before/after direction", () => {
    render(
      <Harness
        initial={{
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "-180",
        }}
      />,
    );

    expect(
      (screen.getByTestId("shift-0-offset-direction") as HTMLSelectElement)
        .value,
    ).toBe("before");

    fireEvent.change(screen.getByTestId("shift-0-offset-direction"), {
      target: { value: "after" },
    });

    // "3 hours after the show starts" — 20:00 + 3h = 23:00.
    expect(screen.getByTestId("shift-0-preview-evening").textContent).toContain(
      "11:00 PM",
    );
  });

  it("keeps the direction when the magnitude is cleared through zero", () => {
    render(
      <Harness
        initial={{
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "-180",
        }}
      />,
    );

    const direction = () =>
      (screen.getByTestId("shift-0-offset-direction") as HTMLSelectElement)
        .value;

    expect(direction()).toBe("before");

    // Clearing the box to retype it is the ordinary way to edit a number, and
    // it takes the magnitude through 0. `-0` stringifies to "0", so deriving
    // the direction from the sign flipped the select to "after" right here.
    fireEvent.change(screen.getByTestId("shift-0-offset-hours"), {
      target: { value: "" },
    });
    expect(direction()).toBe("before");

    fireEvent.change(screen.getByTestId("shift-0-offset-minutes"), {
      target: { value: "30" },
    });
    expect(direction()).toBe("before");

    // "30 minutes BEFORE the show" — 20:00 − 30m = 19:30, lasting 2h.
    // The bug saved EVENT_START +30 and scheduled 20:30 instead.
    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    expect(evening).toContain("7:30 PM");
    expect(evening).toContain("9:30 PM");
  });

  it("restores the offset after a round trip through clock time", () => {
    render(
      <Harness
        initial={{
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "-180",
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("shift-0-anchor"), {
      target: { value: "WALL_CLOCK" },
    });
    expect(screen.queryByTestId("shift-0-offset-hours")).toBeNull();

    fireEvent.change(screen.getByTestId("shift-0-anchor"), {
      target: { value: "EVENT_START" },
    });

    expect(
      (screen.getByTestId("shift-0-offset-hours") as HTMLInputElement).value,
    ).toBe("3");
    expect(
      (screen.getByTestId("shift-0-offset-direction") as HTMLSelectElement)
        .value,
    ).toBe("before");
    // 20:00 − 3h = 17:00 again, not the silent EVENT_START +0.
    expect(screen.getByTestId("shift-0-preview-evening").textContent).toContain(
      "5:00 PM",
    );
  });

  it("seeds a real duration when a zero-length row is anchored", () => {
    // 18:00–18:00 is legal to TYPE (validation is save-time) but rejected as
    // `ends_equal_start`. Anchoring it hides the clock fields, so the row must
    // not be left reading a confident "24 h 0 min" it can never save.
    render(<Harness initial={{ startTime: "18:00", endTime: "18:00" }} />);

    fireEvent.change(screen.getByTestId("shift-0-anchor"), {
      target: { value: "EVENT_START" },
    });

    expect(
      (screen.getByTestId("shift-0-duration-hours") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      (screen.getByTestId("shift-0-duration-minutes") as HTMLInputElement)
        .value,
    ).toBe("0");
    // 20:00 show, offset 0, lasting 2h.
    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    expect(evening).toContain("8:00 PM");
    expect(evening).toContain("10:00 PM");
  });

  it("keeps the duration intact when the hours box is cleared to retype it", () => {
    render(
      <Harness
        initial={{
          // 2 h 00, anchored — the clock fields are hidden, so "Lasts" is the
          // only way the organizer can see or set the length.
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "0",
        }}
      />,
    );

    const hours = () =>
      screen.getByTestId("shift-0-duration-hours") as HTMLInputElement;
    const minutes = () =>
      screen.getByTestId("shift-0-duration-minutes") as HTMLInputElement;

    expect(hours().value).toBe("2");
    expect(minutes().value).toBe("0");

    // Clearing the box is the ordinary way to retype a number. It must not
    // commit 0 — `withShiftDraftDurationMinutes` clamps that to ONE MINUTE,
    // which rewrote endTime to 12:01 and re-rendered the minutes box as "1".
    fireEvent.change(hours(), { target: { value: "" } });
    expect(hours().value).toBe("");
    expect(minutes().value).toBe("0");

    // The preview still shows the last committed duration, and says so.
    expect(screen.getByTestId("shift-0-duration-pending")).toBeTruthy();

    fireEvent.change(hours(), { target: { value: "3" } });
    expect(hours().value).toBe("3");
    // The bug's signature: 3 h 01 (181 minutes) instead of 3 h 00.
    expect(minutes().value).toBe("0");
    expect(screen.queryByTestId("shift-0-duration-pending")).toBeNull();

    // 8:00 PM show, offset 0, lasting exactly 3 h → 11:00 PM, not 11:01 PM.
    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    expect(evening).toContain("8:00 PM");
    expect(evening).toContain("11:00 PM");
    expect(evening).not.toContain("11:01 PM");
  });

  it("holds both duration boxes at zero without writing a 1-minute shift", () => {
    render(
      <Harness
        initial={{
          // 2 h 00 — so clearing HOURS leaves 0 h 0 min, the case that used to
          // clamp to a one-minute shift.
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "0",
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("shift-0-duration-hours"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("shift-0-duration-minutes"), {
      target: { value: "" },
    });

    // Nothing committed: the stored preset is still 2 h (20:00 → 22:00), NOT
    // the 20:00 → 20:01 the clamp used to write.
    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    expect(evening).toContain("8:00 PM");
    expect(evening).toContain("10:00 PM");
    expect(evening).not.toContain("8:01 PM");

    fireEvent.change(screen.getByTestId("shift-0-duration-minutes"), {
      target: { value: "45" },
    });
    expect(
      (screen.getByTestId("shift-0-duration-hours") as HTMLInputElement).value,
    ).toBe("0");
    expect(screen.getByTestId("shift-0-preview-evening").textContent).toContain(
      "8:45 PM",
    );
  });

  it("keeps the chosen direction across an unmount/remount of the control", () => {
    // The composer seeds `offsetMinutes: "0"`, so the sign carries no
    // information — the direction has to survive on the row itself.
    render(
      <RemountHarness
        initial={{
          // Anchored, 2 h long, offset still at the composer's seeded zero.
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "0",
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("shift-0-offset-direction"), {
      target: { value: "before" },
    });
    expect(
      (screen.getByTestId("shift-0-offset-direction") as HTMLSelectElement)
        .value,
    ).toBe("before");

    // Cancel → reopen. `fields` survive in the parent; the control does not.
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.queryByTestId("shift-0-offset-direction")).toBeNull();
    fireEvent.click(screen.getByTestId("toggle"));

    expect(
      (screen.getByTestId("shift-0-offset-direction") as HTMLSelectElement)
        .value,
    ).toBe("before");

    fireEvent.change(screen.getByTestId("shift-0-offset-hours"), {
      target: { value: "3" },
    });

    // "3 hours BEFORE the show" — 20:00 − 3h = 5:00 PM. The bug re-seeded
    // "after" on remount and scheduled load-out at 11:00 PM instead.
    const evening = screen.getByTestId("shift-0-preview-evening").textContent;
    expect(evening).toContain("5:00 PM");
    expect(evening).not.toContain("11:00 PM");
  });

  it("caps the duration hours at the schema's 23:59 ceiling", () => {
    render(
      <Harness
        initial={{
          startTime: "12:00",
          endTime: "14:00",
          anchor: "EVENT_START",
          offsetMinutes: "0",
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("shift-0-duration-hours"), {
      target: { value: "99" },
    });

    expect(
      (screen.getByTestId("shift-0-duration-hours") as HTMLInputElement).value,
    ).toBe("23");
  });
});
