import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventDateStatus } from "@th/types";

import { callOffRemainingDates } from "../_shared/call-off-remaining-dates";

const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-01T12:00:00.000Z");
/** The adapter's `listByEvent` ceiling. */
const ADAPTER_MAX = 500;

/** A keyset-paged id list (cursor = last id), like the saves/RSVP adapters. */
function pagedIds(ids: string[]) {
  return vi.fn(
    async (input: { cursor?: string | null; limit?: number }) => {
      const start = input.cursor ? ids.indexOf(input.cursor) + 1 : 0;
      const items = ids.slice(start, start + (input.limit ?? 50));
      const nextCursor =
        start + items.length < ids.length ? items[items.length - 1]! : null;
      return { items, nextCursor };
    },
  );
}

function fakeTx(
  count: number,
  losesCas: Set<string> = new Set(),
  rsvpsByDate: (dateId: string) => string[] = (id) => [`human-for-${id}`],
  audience: { savers?: string[]; eventRsvpers?: string[] } = {},
) {
  const store = Array.from({ length: count }, (_, i) => ({
    id: `date-${i}`,
    eventId: EVENT_ID,
    startsAt: new Date(NOW.getTime() + (i + 1) * 86_400_000),
    status: "SCHEDULED" as EventDateStatus,
  }));
  const listByEvent = vi.fn(
    async (input: { from?: Date; statuses?: EventDateStatus[]; limit?: number }) =>
      store
        .filter((d) => !input.from || d.startsAt >= input.from)
        .filter((d) => !input.statuses || input.statuses.includes(d.status))
        .slice(0, Math.min(input.limit ?? 100, ADAPTER_MAX))
        .map((d) => ({ ...d })),
  );
  const markStatusIf = vi.fn(
    async (input: { id: string; expectStatus: EventDateStatus; status: EventDateStatus }) => {
      if (losesCas.has(input.id)) return { updated: false };
      const row = store.find((d) => d.id === input.id);
      if (!row || row.status !== input.expectStatus) return { updated: false };
      row.status = input.status;
      return { updated: true };
    },
  );
  const createDateCancelled = vi.fn(
    async (input: { humanIds: string[] }) => input.humanIds.length,
  );
  const tx = {
    eventDates: { listByEvent, markStatusIf },
    eventDateRsvps: {
      listHumanIdsForDate: vi.fn(async (id: string) => rsvpsByDate(id)),
    },
    rsvpNotices: { createDateCancelled },
    eventSaves: { listHumanIdsForEvent: pagedIds(audience.savers ?? []) },
    eventRsvps: { listHumanIdsForEvent: pagedIds(audience.eventRsvpers ?? []) },
  } as unknown as TxRepos;
  return { tx, store, listByEvent, createDateCancelled };
}

describe("callOffRemainingDates", () => {
  it("calls off every remaining night, not just the adapter's first page", async () => {
    const { tx, store, createDateCancelled } = fakeTx(ADAPTER_MAX + 7);

    const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

    expect(result).toEqual({
      datesCalledOff: ADAPTER_MAX + 7,
      notifiedCount: ADAPTER_MAX + 7,
    });
    expect(store.every((d) => d.status === "CANCELLED")).toBe(true);
    expect(createDateCancelled).toHaveBeenCalledTimes(ADAPTER_MAX + 7);
  });

  it("ends when a lost CAS leaves a night readable as SCHEDULED, and writes it no notice", async () => {
    const { tx, listByEvent, createDateCancelled } = fakeTx(
      3,
      new Set(["date-1"]),
    );

    const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

    expect(result).toEqual({ datesCalledOff: 2, notifiedCount: 2 });
    expect(createDateCancelled).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventDateId: "date-1" }),
    );
    // One read that found the nights, one that found nothing new.
    expect(listByEvent).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a listing with no remaining nights", async () => {
    const { tx, createDateCancelled } = fakeTx(0);

    const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

    expect(result).toEqual({ datesCalledOff: 0, notifiedCount: 0 });
    expect(createDateCancelled).not.toHaveBeenCalled();
  });

  it("gives a person ONE notice, on their earliest night, however many nights they held", async () => {
    // ana: nights 0, 1, 2. ben: nights 1, 2. cy: night 2 only. nobody: 3.
    const rsvps: Record<string, string[]> = {
      "date-0": ["ana"],
      "date-1": ["ana", "ben"],
      "date-2": ["ben", "ana", "cy"],
      "date-3": [],
    };
    const { tx, store, createDateCancelled } = fakeTx(
      4,
      new Set(),
      (id) => rsvps[id] ?? [],
    );

    const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

    // Every night still flips; the notice count is distinct people.
    expect(store.every((d) => d.status === "CANCELLED")).toBe(true);
    expect(result).toEqual({ datesCalledOff: 4, notifiedCount: 3 });
    expect(createDateCancelled.mock.calls.map(([input]) => input)).toEqual([
      { eventId: EVENT_ID, eventDateId: "date-0", humanIds: ["ana"] },
      { eventId: EVENT_ID, eventDateId: "date-1", humanIds: ["ben"] },
      { eventId: EVENT_ID, eventDateId: "date-2", humanIds: ["cy"] },
    ]);
  });

  it("dedupes across the adapter's pages too", async () => {
    const { tx, createDateCancelled } = fakeTx(
      ADAPTER_MAX + 3,
      new Set(),
      () => ["regular"],
    );

    const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

    expect(result).toEqual({ datesCalledOff: ADAPTER_MAX + 3, notifiedCount: 1 });
    expect(createDateCancelled).toHaveBeenCalledTimes(1);
    expect(createDateCancelled).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      eventDateId: "date-0",
      humanIds: ["regular"],
    });
  });

  describe("skipHumansInEventAudience (cancel)", () => {
    const rsvps: Record<string, string[]> = {
      "date-0": ["saver", "rsvper"],
      "date-1": ["saver", "night-only"],
    };

    it("writes no notice for a saver or event-level RSVPer: event.cancelled reaches them", async () => {
      const { tx, store, createDateCancelled } = fakeTx(
        2,
        new Set(),
        (id) => rsvps[id] ?? [],
        { savers: ["saver", "someone-else"], eventRsvpers: ["rsvper"] },
      );

      const result = await callOffRemainingDates(tx, {
        eventId: EVENT_ID,
        now: NOW,
        skipHumansInEventAudience: true,
      });

      // Every night still flips.
      expect(store.every((d) => d.status === "CANCELLED")).toBe(true);
      expect(result).toEqual({ datesCalledOff: 2, notifiedCount: 1 });
      expect(createDateCancelled.mock.calls.map(([input]) => input)).toEqual([
        { eventId: EVENT_ID, eventDateId: "date-1", humanIds: ["night-only"] },
      ]);
    });

    it("reads the whole audience, past the first page", async () => {
      const savers = Array.from({ length: 1203 }, (_, i) => `saver-${i}`);
      const { tx, createDateCancelled } = fakeTx(
        1,
        new Set(),
        () => ["saver-1202", "night-only"],
        { savers },
      );

      await callOffRemainingDates(tx, {
        eventId: EVENT_ID,
        now: NOW,
        skipHumansInEventAudience: true,
      });

      expect(createDateCancelled).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        eventDateId: "date-0",
        humanIds: ["night-only"],
      });
    });

    it("without the option (archive), savers and event-level RSVPers are told too", async () => {
      const { tx, createDateCancelled } = fakeTx(
        2,
        new Set(),
        (id) => rsvps[id] ?? [],
        { savers: ["saver"], eventRsvpers: ["rsvper"] },
      );

      const result = await callOffRemainingDates(tx, { eventId: EVENT_ID, now: NOW });

      expect(result).toEqual({ datesCalledOff: 2, notifiedCount: 3 });
      expect(
        (tx.eventSaves.listHumanIdsForEvent as ReturnType<typeof vi.fn>),
      ).not.toHaveBeenCalled();
      expect(createDateCancelled.mock.calls.map(([input]) => input)).toEqual([
        { eventId: EVENT_ID, eventDateId: "date-0", humanIds: ["saver", "rsvper"] },
        { eventId: EVENT_ID, eventDateId: "date-1", humanIds: ["night-only"] },
      ]);
    });

    it("never reads the audience when no night has RSVPers", async () => {
      const { tx, createDateCancelled } = fakeTx(3, new Set(), () => []);

      await callOffRemainingDates(tx, {
        eventId: EVENT_ID,
        now: NOW,
        skipHumansInEventAudience: true,
      });

      expect(
        (tx.eventSaves.listHumanIdsForEvent as ReturnType<typeof vi.fn>),
      ).not.toHaveBeenCalled();
      expect(createDateCancelled).not.toHaveBeenCalled();
    });
  });
});
