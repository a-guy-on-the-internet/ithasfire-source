import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_MIGRATION_NOTIFY_ORDER_IDS,
  sendMigrationNotification,
  type SendMigrationNotificationDeps,
} from "../send-migration-notification";

const ACTOR_ID = randomUUID();
const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const SOURCE_ID = randomUUID();
const TARGET_ID = randomUUID();
const FOREIGN_TARGET_ID = randomUUID();
const STARTS = new Date("2026-10-01T20:00:00.000Z");

type Order = { id: string; eventId: string | null; buyerHumanId: string };

function makeDeps(orders: Order[]) {
  const events = new Map([
    [SOURCE_ID, { id: SOURCE_ID, orgId: ORG_ID, humanId: null, title: "Old", startsAt: STARTS }],
    [TARGET_ID, { id: TARGET_ID, orgId: ORG_ID, humanId: null, title: "New", startsAt: STARTS }],
    [
      FOREIGN_TARGET_ID,
      { id: FOREIGN_TARGET_ID, orgId: OTHER_ORG_ID, humanId: null, title: "Theirs", startsAt: STARTS },
    ],
  ]);
  const byId = new Map(orders.map((o) => [o.id, o]));

  const mailer = {
    send: vi.fn(async () => ({ result: { success: true, id: "m" } })),
  };
  const repos = {
    events: { getById: vi.fn(async (id: string) => events.get(id) ?? null) },
    orders: { getById: vi.fn(async (id: string) => byId.get(id) ?? null) },
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id },
        identity: { email: `${id}@example.com` },
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async ({ orgId }: { orgId: string }) =>
        orgId === ORG_ID ? { role: "ADMIN" } : null,
      ),
    },
  };
  const reportError = vi.fn();
  const deps = {
    repos,
    mailer,
    reportError,
  } as unknown as SendMigrationNotificationDeps;
  return { deps, mailer, repos, reportError };
}

const base = {
  actorHumanId: ACTOR_ID,
  sourceEventId: SOURCE_ID,
  targetEventId: TARGET_ID,
  publicAppUrl: "https://ithasfire.test/",
};

describe("sendMigrationNotification", () => {
  it("emails each buyer of an order that now lives on the target event", async () => {
    const buyer = randomUUID();
    const order = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: buyer };
    const { deps, mailer } = makeDeps([order]);

    const out = await sendMigrationNotification(deps, {
      ...base,
      migratedOrderIds: [order.id],
    });

    expect(out).toEqual({ ok: true, sentCount: 1, failedCount: 0 });
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: `${buyer}@example.com` },
        template: expect.objectContaining({
          variables: expect.objectContaining({
            manageUrl: `https://ithasfire.test/orders/${order.id}`,
          }),
        }),
      }),
    );
  });

  // Security review F15 (2026-09-29): the order ids were never checked
  // against the migration, and the target was never owner-checked.
  it("skips orders that are not on the target event, without mailing their buyers", async () => {
    const mine = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: randomUUID() };
    const someoneElses = { id: randomUUID(), eventId: randomUUID(), buyerHumanId: randomUUID() };
    const stillOnSource = { id: randomUUID(), eventId: SOURCE_ID, buyerHumanId: randomUUID() };
    const { deps, mailer, repos } = makeDeps([mine, someoneElses, stillOnSource]);

    const out = await sendMigrationNotification(deps, {
      ...base,
      migratedOrderIds: [mine.id, someoneElses.id, stillOnSource.id, randomUUID()],
    });

    expect(out).toEqual({ ok: true, sentCount: 1, failedCount: 3 });
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(repos.humans.getByIdWithIdentity).toHaveBeenCalledTimes(1);
    expect(repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(mine.buyerHumanId);
  });

  it("refuses a target owned by someone else, before reading any order", async () => {
    const { deps, mailer, repos } = makeDeps([]);

    await expect(
      sendMigrationNotification(deps, {
        ...base,
        targetEventId: FOREIGN_TARGET_ID,
        migratedOrderIds: [randomUUID()],
      }),
    ).rejects.toMatchObject({ code: "EVENTS_DIFFERENT_ORG" });
    expect(repos.orders.getById).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it(`caps migratedOrderIds at ${MAX_MIGRATION_NOTIFY_ORDER_IDS}`, async () => {
    const { deps, repos } = makeDeps([]);

    await expect(
      sendMigrationNotification(deps, {
        ...base,
        migratedOrderIds: Array.from(
          { length: MAX_MIGRATION_NOTIFY_ORDER_IDS + 1 },
          () => randomUUID(),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(repos.events.getById).not.toHaveBeenCalled();
  });

  it("reads a repeated order id once", async () => {
    const order = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: randomUUID() };
    const { deps, repos } = makeDeps([order]);

    await sendMigrationNotification(deps, {
      ...base,
      migratedOrderIds: [order.id, order.id, order.id],
    });
    expect(repos.orders.getById).toHaveBeenCalledTimes(1);
  });

  it("reports a swallowed send failure and keeps going; a throwing reporter changes nothing", async () => {
    const a = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: randomUUID() };
    const b = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: randomUUID() };
    const { deps, mailer, reportError } = makeDeps([a, b]);
    mailer.send.mockRejectedValueOnce(new Error("smtp down"));
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const out = await sendMigrationNotification(deps, {
      ...base,
      migratedOrderIds: [a.id, b.id],
    });

    expect(out).toEqual({ ok: true, sentCount: 1, failedCount: 1 });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "smtp down" }),
      expect.objectContaining({
        tags: { useCase: "sendMigrationNotification" },
      }),
    );
  });
});

// The template renders each date in its event's zone; without the zones a
// UTC server mailed a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("sendMigrationNotification passes each event's timezone", () => {
  it("sends the source and target zones beside their dates", async () => {
    const buyer = randomUUID();
    const order = { id: randomUUID(), eventId: TARGET_ID, buyerHumanId: buyer };
    const { deps, mailer, repos } = makeDeps([order]);
    const zones: Record<string, string> = {
      [SOURCE_ID]: "America/Chicago",
      [TARGET_ID]: "America/Los_Angeles",
    };
    const original = repos.events.getById.getMockImplementation()!;
    repos.events.getById.mockImplementation(async (id: string) => {
      const event = await original(id);
      return event ? { ...event, timezone: zones[id] } : null;
    });

    await sendMigrationNotification(deps, {
      ...base,
      migratedOrderIds: [order.id],
    });

    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          key: "event.rescheduled",
          variables: expect.objectContaining({
            sourceEventTimezone: "America/Chicago",
            targetEventTimezone: "America/Los_Angeles",
          }),
        }),
      }),
    );
  });
});
