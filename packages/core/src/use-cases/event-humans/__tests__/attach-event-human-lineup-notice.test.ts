import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { attachEventHuman, type AttachEventHumanDeps } from "../attach-event-human";
import {
  lineupNoticeOwedKey,
  makeLineupNoticeHooks,
} from "../notify-lineup-notices";

// Owner ruling "option A" (2026-09-30): attaching a REAL person keeps the
// unilateral attach, and tells them — now when PUBLISHED, else at publish.

const ACTOR = "30000000-0000-4000-8000-000000000003";
const PERSON = "40000000-0000-4000-8000-000000000004";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-30T12:00:00.000Z");

function makeHarness(options: {
  status?: "DRAFT" | "PUBLISHED";
  existingRow?: boolean;
  wireNotifier?: "real" | "throwing" | "none";
  rateLimit?: "allow" | "deny" | "throw" | "none";
} = {}) {
  const status = options.status ?? "PUBLISHED";
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Friday Night Sessions",
    status,
    stewardship: "OWNED",
    startsAt: new Date("2026-10-04T22:00:00.000Z"),
    endsAt: new Date("2026-10-05T02:00:00.000Z"),
    timezone: "America/Chicago",
  };
  const rows = new Map<string, any>();
  const existingId = randomUUID();
  if (options.existingRow) {
    rows.set(existingId, {
      id: existingId,
      eventId: EVENT_ID,
      humanId: PERSON,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      profileSlug: null,
      humanDisplayName: null,
    });
  }
  const eventHumans = {
    getByEventAndHuman: vi.fn(async ({ humanId }: { humanId: string }) =>
      [...rows.values()].find((r) => r.humanId === humanId) ?? null,
    ),
    attach: vi.fn(async (input: any) => {
      const existing = input.humanId
        ? [...rows.values()].find((r) => r.humanId === input.humanId)
        : null;
      if (existing) return existing;
      const created = {
        id: input.id ?? randomUUID(),
        eventId: input.eventId,
        humanId: input.humanId ?? null,
        externalName: input.externalName ?? null,
        externalUrl: input.externalUrl ?? null,
        role: input.role,
        customRoleLabel: input.customRoleLabel ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
        profileSlug: null,
        humanDisplayName: null,
      };
      rows.set(created.id, created);
      return created;
    }),
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
    listByEvent: vi.fn(async () => [...rows.values()]),
  };
  const tx = {
    events: { getById: vi.fn(async () => event), listTicketTypes: vi.fn(async () => []) },
    eventHumans,
    authz: {
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
        humanId === ACTOR ? { orgId: ORG_ID, humanId: ACTOR, role: "OWNER" } : null,
      ),
    },
    audit: { log: vi.fn(async () => undefined) },
    // The follower outbox a peer workstream may add inside the tx reads
    // these; inert here.
    entityPages: { getByOwner: vi.fn(async () => null) },
    entityEventNotices: { enqueue: vi.fn() },
  };
  const notify = vi.fn(async () => ({ ok: true, email: { status: "sent" } })) as any;
  const reportError = vi.fn();
  const idempotency = createFakeIdempotencyPort();
  const txState = { open: false, owedWrittenWhileOpen: false };
  const hooks = makeLineupNoticeHooks({
    repos: {
      events: tx.events,
      eventHumans,
      humans: {
        getById: vi.fn(async (id: string) => ({ id, name: "Sam Rivera" })),
        getByIdWithIdentity: vi.fn(),
        listAuthAccounts: vi.fn(),
        listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => [...ids]),
      },
      organizations: { getById: vi.fn(async () => ({ name: "Acme", slug: "acme" })) },
      entityPages: { getByOwner: vi.fn(async () => null) },
    } as any,
    idempotency,
    notify,
    publicAppUrl: "https://ithasfire.com",
    reportError,
  });
  const recordOwed = vi.fn(async (args: any) => {
    if (txState.open) txState.owedWrittenWhileOpen = true;
    return hooks.recordOwed(args);
  });
  const consume = vi.fn(async () => {
    if (options.rateLimit === "throw") throw new Error("redis down");
    return options.rateLimit === "deny"
      ? { allowed: false, remaining: 0, retryAfterSeconds: 42 }
      : { allowed: true, remaining: 10, retryAfterSeconds: 0 };
  });
  const hook =
    options.wireNotifier === "throwing"
      ? vi.fn(async () => {
          throw new Error("notifier exploded");
        })
      : vi.fn(hooks.dispatch);

  const deps: AttachEventHumanDeps = {
    repos: {
      eventHumans,
      events: tx.events,
      authz: tx.authz,
      tx: vi.fn(async (fn: any) => {
        txState.open = true;
        try {
          return await fn(tx);
        } finally {
          txState.open = false;
        }
      }),
    } as any,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) } as any,
    clock: { now: () => now },
    logger: createTestLogger(),
    ...(options.wireNotifier === "none"
      ? {}
      : { lineupNotices: { recordOwed, dispatch: hook, clearCooldown: vi.fn() } }),
    ...(options.rateLimit === "none" ? {} : { rateLimit: { consume } as any }),
    reportError,
  };
  return { deps, hook, recordOwed, notify, reportError, eventHumans, idempotency, txState, consume, tx };
}

const attachPerson = (humanId = PERSON) => ({
  actorHumanId: ACTOR,
  eventId: EVENT_ID,
  humanId,
  role: "PERFORMER",
});

describe("attachEventHuman — lineup notice", () => {
  it("PUBLISHED + a new linked row → the person is told once, post-commit", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    const out = await attachEventHuman(h.deps, attachPerson());

    expect(h.hook).toHaveBeenCalledTimes(1);
    expect(h.hook).toHaveBeenCalledWith({
      kind: "attached",
      eventId: EVENT_ID,
      eventHumanId: out.id,
      addedByHumanId: ACTOR,
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      humanId: PERSON,
      variant: "event.lineup-added",
      payload: { eventHumanId: out.id, addedByName: "Sam Rivera" },
    });
  });

  it("the OWED fact is written BEFORE the tx (no non-tx I/O inside it), keyed on the pre-generated row id", async () => {
    const h = makeHarness({ status: "DRAFT" });
    const out = await attachEventHuman(h.deps, attachPerson());
    expect(h.recordOwed).toHaveBeenCalledWith({
      eventHumanId: out.id,
      addedByHumanId: ACTOR,
      via: "attach",
    });
    expect(h.txState.owedWrittenWhileOpen).toBe(false);
    expect(h.recordOwed.mock.invocationCallOrder[0]).toBeLessThan(
      (h.deps.repos.tx as any).mock.invocationCallOrder[0],
    );
    expect(h.eventHumans.attach.mock.calls[0][0].id).toBe(out.id);
    // The existence probe runs outside the tx too.
    expect(h.eventHumans.getByEventAndHuman).toHaveBeenCalledTimes(1);
    expect(await h.idempotency.get(lineupNoticeOwedKey(out.id))).toEqual({
      addedByHumanId: ACTOR,
      via: "attach",
    });
  });

  it("the owed fact survives a notifier that dies after commit", async () => {
    const h = makeHarness({ status: "PUBLISHED", wireNotifier: "throwing" });
    const out = await attachEventHuman(h.deps, attachPerson());
    expect(await h.idempotency.get(lineupNoticeOwedKey(out.id))).not.toBeNull();
  });

  it("re-attaching someone already on the lineup tells no one", async () => {
    const h = makeHarness({ status: "PUBLISHED", existingRow: true });
    await attachEventHuman(h.deps, attachPerson());
    expect(h.recordOwed).not.toHaveBeenCalled();
    expect(h.hook).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("DRAFT → nothing is sent now (the publish sweep owes it)", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await attachEventHuman(h.deps, attachPerson());
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("the actor attaching themselves is never told", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await attachEventHuman(h.deps, attachPerson(ACTOR));
    expect(h.hook).not.toHaveBeenCalled();
    expect(h.recordOwed).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    // …and the existence probe is skipped entirely.
    expect(h.eventHumans.getByEventAndHuman).not.toHaveBeenCalled();
  });

  it("a free-text row has no one to tell", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await attachEventHuman(h.deps, {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      externalName: "The Sundowners",
      role: "PERFORMER",
    });
    expect(h.hook).not.toHaveBeenCalled();
  });

  it("a throwing notifier never changes the attach result — and is reported", async () => {
    const h = makeHarness({ status: "PUBLISHED", wireNotifier: "throwing" });
    const out = await attachEventHuman(h.deps, attachPerson());
    expect(out.humanId).toBe(PERSON);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1]).toMatchObject({
      tags: { useCase: "attachEventHuman", stage: "lineup_notice" },
      extra: { eventId: EVENT_ID, eventHumanId: out.id, addedByHumanId: ACTOR },
    });
  });

  it("a throwing reporter on top of a throwing notifier still never escapes", async () => {
    const h = makeHarness({ status: "PUBLISHED", wireNotifier: "throwing" });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(attachEventHuman(h.deps, attachPerson())).resolves.toMatchObject({
      humanId: PERSON,
    });
  });

  it("a concurrent attach that won the row: our upsert returns THEIR row, so we tell no one", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    // The pre-tx probe sees nothing, then another request creates the row.
    h.eventHumans.getByEventAndHuman.mockResolvedValueOnce(null);
    const theirs = await h.eventHumans.attach({ eventId: EVENT_ID, humanId: PERSON, role: "PERFORMER" });
    const out = await attachEventHuman(h.deps, attachPerson());
    expect(out.id).toBe(theirs.id);
    expect(h.hook).not.toHaveBeenCalled();
  });

  it("without the hooks or limiter wired (seeds, scripts) attach tells no one", async () => {
    const h = makeHarness({ status: "PUBLISHED", wireNotifier: "none", rateLimit: "none" });
    await attachEventHuman(h.deps, attachPerson());
    expect(h.notify).not.toHaveBeenCalled();
  });

  describe("per-actor budget (120/hour) — only attaches that can mail someone", () => {
    it("charges a new linked person", async () => {
      const h = makeHarness({ status: "DRAFT" });
      await attachEventHuman(h.deps, attachPerson());
      expect(h.consume).toHaveBeenCalledWith(`eventHumans:attach:actor:${ACTOR}`, 120, 3600);
    });

    it("never charges a free-text row, self-attach, or a re-attach", async () => {
      const h = makeHarness({ status: "DRAFT", existingRow: true });
      await attachEventHuman(h.deps, {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        externalName: "The Sundowners",
        role: "PERFORMER",
      });
      await attachEventHuman(h.deps, attachPerson(ACTOR));
      await attachEventHuman(h.deps, attachPerson()); // PERSON already on it
      expect(h.consume).not.toHaveBeenCalled();
    });

    it("refuses with RATE_LIMITED when spent — before any write", async () => {
      const h = makeHarness({ status: "DRAFT", rateLimit: "deny" });
      await expect(attachEventHuman(h.deps, attachPerson())).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
      expect(h.eventHumans.attach).not.toHaveBeenCalled();
      expect(h.recordOwed).not.toHaveBeenCalled();
    });

    it("fails OPEN on a limiter error (reported)", async () => {
      const h = makeHarness({ status: "DRAFT", rateLimit: "throw" });
      await expect(attachEventHuman(h.deps, attachPerson())).resolves.toMatchObject({
        humanId: PERSON,
      });
      expect(h.reportError.mock.calls[0][1].tags).toMatchObject({ stage: "rate_limit" });
    });
  });

  describe("authorization comes BEFORE the probe, the budget and OWED (no lineup-membership oracle)", () => {
    const STRANGER = "99999999-0000-4000-8000-000000000009";
    const asStranger = (humanId = PERSON) => ({
      actorHumanId: STRANGER,
      eventId: EVENT_ID,
      humanId,
      role: "PERFORMER",
    });

    it("a non-editor gets the SAME refusal whether or not the person is on the lineup, is never charged, and writes no OWED", async () => {
      const on = makeHarness({ status: "PUBLISHED", existingRow: true, rateLimit: "deny" });
      const off = makeHarness({ status: "PUBLISHED", existingRow: false, rateLimit: "deny" });

      const errOn = await attachEventHuman(on.deps, asStranger()).catch((e) => e);
      const errOff = await attachEventHuman(off.deps, asStranger()).catch((e) => e);

      expect(errOn.code).toBe("INSUFFICIENT_ROLE");
      expect(errOff.code).toBe(errOn.code);
      for (const h of [on, off]) {
        expect(h.eventHumans.getByEventAndHuman).not.toHaveBeenCalled();
        expect(h.consume).not.toHaveBeenCalled();
        expect(h.recordOwed).not.toHaveBeenCalled();
        expect(h.eventHumans.attach).not.toHaveBeenCalled();
      }
    });

    it("a missing event answers EVENT_NOT_FOUND before any probe", async () => {
      const h = makeHarness({ status: "PUBLISHED" });
      (h.deps.repos.events.getById as any).mockResolvedValue(null);
      const err = await attachEventHuman(h.deps, attachPerson()).catch((e) => e);
      expect(err.code).toBe("EVENT_NOT_FOUND");
      expect(h.eventHumans.getByEventAndHuman).not.toHaveBeenCalled();
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.recordOwed).not.toHaveBeenCalled();
    });
  });
});
