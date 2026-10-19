import { describe, expect, it } from "vitest";

import {
  createEmptyShiftComposerRow,
  createPresetShiftComposerRow,
  duplicateShiftComposerRow,
  repeatShiftComposerRowAcrossDays,
  toCreateShiftBatchItem,
  validateShiftComposerRow,
} from "../shift-composer-helpers";

describe("shift-composer-helpers", () => {
  it("seeds a new row from the previous row end time", () => {
    const row = createEmptyShiftComposerRow({
      previousRow: { endsAt: "2026-07-01T21:00:00.000Z" },
      createId: () => "draft-1",
    });

    expect(row).toEqual({
      id: "draft-1",
      startsAt: "2026-07-01T21:00:00.000Z",
      endsAt: "2026-07-01T23:00:00.000Z",
      label: "",
      capacity: "",
    });
  });

  it("builds preset rows relative to the event window", () => {
    const mainRow = createPresetShiftComposerRow({
      preset: "main",
      eventStartsAt: "2026-07-01T19:00:00.000Z",
      eventEndsAt: "2026-07-01T23:30:00.000Z",
      createId: () => "draft-main",
    });
    const cleanupRow = createPresetShiftComposerRow({
      preset: "cleanup",
      eventStartsAt: "2026-07-01T19:00:00.000Z",
      eventEndsAt: "2026-07-01T23:30:00.000Z",
      createId: () => "draft-cleanup",
    });

    expect(mainRow).toEqual({
      id: "draft-main",
      label: "Main shift",
      capacity: "",
      startsAt: "2026-07-01T19:00:00.000Z",
      endsAt: "2026-07-01T23:30:00.000Z",
    });
    expect(cleanupRow).toEqual({
      id: "draft-cleanup",
      label: "Cleanup",
      capacity: "",
      startsAt: "2026-07-01T23:30:00.000Z",
      endsAt: "2026-07-02T01:00:00.000Z",
    });
  });

  it("duplicates a draft without changing its values", () => {
    const duplicated = duplicateShiftComposerRow(
      {
        id: "draft-1",
        startsAt: "2026-07-01T19:00:00.000Z",
        endsAt: "2026-07-01T21:00:00.000Z",
        label: "Setup",
        capacity: "3",
      },
      () => "draft-2",
    );

    expect(duplicated).toEqual({
      id: "draft-2",
      startsAt: "2026-07-01T19:00:00.000Z",
      endsAt: "2026-07-01T21:00:00.000Z",
      label: "Setup",
      capacity: "3",
    });
  });

  it("returns field-level validation errors for invalid rows", () => {
    const errors = validateShiftComposerRow({
      id: "draft-1",
      startsAt: "2026-07-01T21:00:00.000Z",
      endsAt: "2026-07-01T20:00:00.000Z",
      label: "",
      capacity: "0",
    });

    expect(errors).toEqual({
      endsAt: "ends_before_start",
      capacity: "invalid_capacity",
    });
  });

  describe("repeatShiftComposerRowAcrossDays", () => {
    const baseRow = {
      id: "src",
      startsAt: "2026-07-01T19:00:00.000Z",
      endsAt: "2026-07-01T21:00:00.000Z",
      label: "Setup",
      capacity: "4",
    };

    it("creates N copies shifted by 1..N days", () => {
      let counter = 0;
      const copies = repeatShiftComposerRowAcrossDays(baseRow, 3, () => {
        counter += 1;
        return `c-${counter}`;
      });

      expect(copies).toEqual([
        {
          id: "c-1",
          startsAt: "2026-07-02T19:00:00.000Z",
          endsAt: "2026-07-02T21:00:00.000Z",
          label: "Setup",
          capacity: "4",
        },
        {
          id: "c-2",
          startsAt: "2026-07-03T19:00:00.000Z",
          endsAt: "2026-07-03T21:00:00.000Z",
          label: "Setup",
          capacity: "4",
        },
        {
          id: "c-3",
          startsAt: "2026-07-04T19:00:00.000Z",
          endsAt: "2026-07-04T21:00:00.000Z",
          label: "Setup",
          capacity: "4",
        },
      ]);
    });

    it("returns empty when daysCount is 0 or negative", () => {
      expect(repeatShiftComposerRowAcrossDays(baseRow, 0)).toEqual([]);
      expect(repeatShiftComposerRowAcrossDays(baseRow, -2)).toEqual([]);
    });

    it("returns empty when source row has no valid start", () => {
      expect(
        repeatShiftComposerRowAcrossDays(
          { ...baseRow, startsAt: undefined },
          3,
        ),
      ).toEqual([]);
      expect(
        repeatShiftComposerRowAcrossDays(
          { ...baseRow, startsAt: "not-a-date" },
          3,
        ),
      ).toEqual([]);
    });

    it("preserves end-of-month boundaries via Date arithmetic", () => {
      const copies = repeatShiftComposerRowAcrossDays(
        {
          ...baseRow,
          startsAt: "2026-01-31T15:00:00.000Z",
          endsAt: "2026-01-31T17:00:00.000Z",
        },
        1,
        () => "c-1",
      );

      expect(copies).toEqual([
        {
          id: "c-1",
          startsAt: "2026-02-01T15:00:00.000Z",
          endsAt: "2026-02-01T17:00:00.000Z",
          label: "Setup",
          capacity: "4",
        },
      ]);
    });
  });

  it("normalizes a valid draft for createBatch", () => {
    const item = toCreateShiftBatchItem({
      id: "draft-1",
      startsAt: "2026-07-01T19:00:00.000Z",
      endsAt: "2026-07-01T21:00:00.000Z",
      label: "  Doors  ",
      capacity: "4",
    });

    expect(item).toEqual({
      label: "Doors",
      startsAt: new Date("2026-07-01T19:00:00.000Z"),
      endsAt: new Date("2026-07-01T21:00:00.000Z"),
      capacity: 4,
    });
  });
});
