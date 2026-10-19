import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  LINEUP_NOTICE_COOLDOWN_SEC,
  lineupNoticeOwedKey,
  lineupNoticeRecentKey,
  lineupNoticeSentKey,
  makeLineupNoticeHooks,
  notifyLineupNotices,
  recordLineupNoticeOwed,
  type NotifyLineupNoticesDeps,
} from "../notify-lineup-notices";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const EDITOR = "30000000-0000-4000-8000-000000000003";
const PERSON_A = "40000000-0000-4000-8000-000000000004";
const PERSON_B = "50000000-0000-4000-8000-000000000005";
const ROW_A = "a0000000-0000-4000-8000-00000000000a";
const ROW_B = "b0000000-0000-4000-8000-00000000000b";
const ROW_LEGACY = "c0000000-0000-4000-8000-00000000000c";
const LEGACY_PERSON = "60000000-0000-4000-8000-000000000006";

type Status = "DRAFT" | "PUBLISHED";

function row(id: string, humanId: string | null, role = "PERFORMER") {
  return {
    id,
    eventId: EVENT_ID,
    humanId,
    externalName: humanId ? null : "Free Text Act",
    externalUrl: null,
    role,
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    profileSlug: null,
    humanDisplayName: null,
  };
}

function makeHarness(options: {
  status?: Status;
  rows?: ReturnType<typeof row>[];
  adderName?: string | null;
  publicAppUrl?: string | null;
  mailer?: boolean;
  shadow?: boolean;
  visibility?: "PUBLIC" | "PRIVATE";
  ownerless?: boolean;
  paid?: boolean;
  now?: Date;
  limiter?: "counting" | "throw";
  /** B2 verified-email lookup: default every recipient verified; "throw" = read fails. */
  verified?: boolean | "throw";
  /** The event org's members (default: EDITOR owns it). "throw" = read fails. */
  members?: Array<{ humanId: string; role: string }> | "throw";
} = {}) {
  const state = {
    status: options.status ?? "PUBLISHED",
    rows: options.rows ?? [row(ROW_A, PERSON_A)],
  };
  const event = () => ({
    id: EVENT_ID,
    orgId: options.ownerless ? null : ORG_ID,
    humanId: null,
    title: "Friday Night Sessions",
    status: state.status,
    visibility: options.visibility ?? "PUBLIC",
    startsAt: new Date("2026-10-04T22:00:00.000Z"),
    endsAt: new Date("2026-10-05T02:00:00.000Z"),
    timezone: "America/Chicago",
  });
  const idempotency = createFakeIdempotencyPort();
  const notify = vi.fn(async (_input: any) => ({
    ok: true,
    email: { status: "sent" },
  })) as any;
  const mailer = {
    send: vi.fn(async (_input: any) => ({ result: { success: true } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };
  const reportError = vi.fn();
  // A real fixed-window counter per key (enough to exercise the caps).
  const buckets = new Map<string, number>();
  const rateLimit = {
    consume: vi.fn(async (key: string, max: number) => {
      if (options.limiter === "throw") throw new Error("redis down");
      const n = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, n);
      return { allowed: n <= max, remaining: Math.max(max - n, 0), retryAfterSeconds: n <= max ? 0 : 3600 };
    }),
  };
  const repos = {
    events: {
      getById: vi.fn(async () => event()),
      listTicketTypes: vi.fn(async () => [
        { priceCents: options.paid ? 1500 : 0, pricingMode: "FIXED" },
      ]),
    },
    eventHumans: {
      getById: vi.fn(async (id: string) => state.rows.find((r) => r.id === id) ?? null),
      listByEvent: vi.fn(async () => state.rows),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === EDITOR
          ? { id, name: options.adderName === undefined ? "Sam Rivera" : options.adderName }
          : { id, name: "Person" },
      ),
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Person" },
        identity: {
          email: "band@example.org",
          emailVerified: !options.shadow,
          username: id === PERSON_A ? "sundowners" : null,
        },
      })),
      listAuthAccounts: vi.fn(async () => (options.shadow ? [] : [{ id: "acc" }])),
      listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => {
        if (options.verified === "throw") throw new Error("auth read down");
        return options.verified === false ? [] : [...ids];
      }),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Acme Presents", slug: "acme" })),
      listMembers: vi.fn(async () => {
        if (options.members === "throw") throw new Error("members read down");
        const items = options.members ?? [{ humanId: EDITOR, role: "OWNER" }];
        return { items, total: items.length };
      }),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
  };
  const deps: NotifyLineupNoticesDeps = {
    repos: repos as any,
    idempotency,
    notify,
    mailer: options.mailer === false ? null : (mailer as any),
    publicAppUrl:
      options.publicAppUrl === undefined ? "https://ithasfire.com/" : options.publicAppUrl,
    clock: { now: () => options.now ?? new Date("2026-09-30T12:00:00.000Z") },
    ...(options.limiter ? { rateLimit: rateLimit as any } : {}),
    logger: createTestLogger(),
    reportError,
  };
  return { deps, state, idempotency, notify, mailer, reportError, repos, rateLimit };
}

const attached = (eventHumanId = ROW_A) =>
  ({ kind: "attached", eventId: EVENT_ID, eventHumanId, addedByHumanId: EDITOR }) as const;
const published = { kind: "published", eventId: EVENT_ID } as const;

describe("notifyLineupNotices — attach to a PUBLISHED event", () => {
  it("tells the person right away, once, with the owner's payload", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await notifyLineupNotices(h.deps, attached());

    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith({
      humanId: PERSON_A,
      variant: "event.lineup-added",
      idempotencyKey: `lineup-added:${ROW_A}`,
      scope: { kind: "EVENT", eventId: EVENT_ID },
      payload: {
        eventId: EVENT_ID,
        eventHumanId: ROW_A,
        eventTitle: "Friday Night Sessions",
        startsAtIso: "2026-10-04T22:00:00.000Z",
        timezone: "America/Chicago",
        roleLabel: "Performer",
        addedByName: "Sam Rivera",
        lineupsUrl: "https://ithasfire.com/my-lineups",
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
      channels: { sms: { enabled: false } },
    });
    // Durable ledger: owed + sent, both long-lived; recent for 7 days.
    expect(await h.idempotency.get(lineupNoticeOwedKey(ROW_A))).toEqual({
      addedByHumanId: EDITOR,
      via: "attach",
    });
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toMatchObject({
      humanId: PERSON_A,
    });
    const keeps = new Map(
      h.idempotency.__mocks.commit.mock.calls.map((c) => [c[0], c[2]]),
    );
    expect(keeps.get(lineupNoticeOwedKey(ROW_A))).toBeGreaterThanOrEqual(5 * 365 * 24 * 3600);
    expect(keeps.get(lineupNoticeSentKey(ROW_A))).toBeGreaterThanOrEqual(5 * 365 * 24 * 3600);
    expect(keeps.get(lineupNoticeRecentKey(EVENT_ID, PERSON_A))).toBe(
      LINEUP_NOTICE_COOLDOWN_SEC,
    );

    // A later (re)publish never tells them again.
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("only promises what is true: private event / volunteer role / ownerless listing", async () => {
    const priv = makeHarness({ visibility: "PRIVATE" });
    await notifyLineupNotices(priv.deps, attached());
    expect(priv.notify.mock.calls[0][0].payload.publiclyListed).toBe(false);

    const vol = makeHarness({ rows: [row(ROW_A, PERSON_A, "VOLUNTEER")] });
    await notifyLineupNotices(vol.deps, attached());
    expect(vol.notify.mock.calls[0][0].payload.publiclyListed).toBe(false);

    const community = makeHarness({ ownerless: true });
    await notifyLineupNotices(community.deps, attached());
    expect(community.notify.mock.calls[0][0].payload.organiserWillBeTold).toBe(false);

    // Started (startsAt 22:00Z Oct 4) but not yet over: already off the
    // profile's upcoming list (`startsAt > now`), so no "upcoming shows".
    const started = makeHarness({ now: new Date("2026-10-04T23:00:00.000Z") });
    await notifyLineupNotices(started.deps, attached());
    expect(started.notify.mock.calls[0][0].payload.eventEnded).toBe(true);

    const ended = makeHarness({ now: new Date("2026-10-06T00:00:00.000Z") });
    await notifyLineupNotices(ended.deps, attached());
    expect(ended.notify.mock.calls[0][0].payload).toMatchObject({
      publiclyListed: true,
      eventEnded: true,
    });
  });

  it("falls back to the organiser's name when the adder has no usable name", async () => {
    const h = makeHarness({ adderName: "sam@example.org" });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify.mock.calls[0][0].payload.addedByName).toBe("Acme Presents");
  });

  it("never tells the actor about their own name", async () => {
    const h = makeHarness({ rows: [row(ROW_A, EDITOR)] });
    await notifyLineupNotices(h.deps, attached());
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("claims once under a race: two senders, one notice", async () => {
    const h = makeHarness();
    await Promise.all([
      notifyLineupNotices(h.deps, attached()),
      notifyLineupNotices(h.deps, published),
    ]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe("notifyLineupNotices — 7-day re-add cooldown (owner ruling)", () => {
  it("attach → detach → re-attach within 7 days sends ONE notice, and the new row is settled", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await notifyLineupNotices(h.deps, attached(ROW_A));
    h.state.rows = [row(ROW_B, PERSON_A)]; // removed, re-added: a new row
    await notifyLineupNotices(h.deps, attached(ROW_B));
    expect(h.notify).toHaveBeenCalledTimes(1);
    // SENT is committed as suppressed, so the sweep never retries ROW_B.
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_B))).toMatchObject({
      suppressed: "recent",
    });
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("after the 7-day record lapses, a re-add is told again", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await notifyLineupNotices(h.deps, attached(ROW_A));
    // The adapters expire the key after LINEUP_NOTICE_COOLDOWN_SEC; the fake
    // does not model time, so drop it the way expiry would.
    h.idempotency.__store.delete(lineupNoticeRecentKey(EVENT_ID, PERSON_A));
    h.state.rows = [row(ROW_B, PERSON_A)];
    await notifyLineupNotices(h.deps, attached(ROW_B));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a SELF-leave clears the cooldown: add → told, leave, re-add within 7 days → told again", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    const hooks = makeLineupNoticeHooks(h.deps);
    await hooks.dispatch(attached(ROW_A));
    expect(h.notify).toHaveBeenCalledTimes(1);
    // What leaveEventLineup does after its commit.
    await hooks.clearCooldown({ eventId: EVENT_ID, humanId: PERSON_A });
    h.state.rows = [row(ROW_B, PERSON_A)];
    await hooks.dispatch(attached(ROW_B));
    expect(h.notify).toHaveBeenCalledTimes(2);
    // …and that new notice re-opens the window: an editor loop is suppressed again.
    h.state.rows = [row(ROW_LEGACY, PERSON_A)];
    await hooks.dispatch(attached(ROW_LEGACY));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("clearCooldown never throws — it reports", async () => {
    const h = makeHarness();
    h.idempotency.__mocks.commit.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      makeLineupNoticeHooks(h.deps).clearCooldown({ eventId: EVENT_ID, humanId: PERSON_A }),
    ).resolves.toBeUndefined();
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("cooldown_clear_failed");
  });

  it("the cooldown is per event and person: someone else on the same event is still told", async () => {
    const h = makeHarness({
      rows: [row(ROW_A, PERSON_A), row(ROW_B, PERSON_B)],
    });
    await notifyLineupNotices(h.deps, attached(ROW_A));
    await notifyLineupNotices(h.deps, attached(ROW_B));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });
});

describe("notifyLineupNotices — attach to a DRAFT, told at publish", () => {
  it("records the row as owed, then tells them on publish, exactly once across republish", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.idempotency.get(lineupNoticeOwedKey(ROW_A))).not.toBeNull();

    h.state.status = "PUBLISHED";
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].humanId).toBe(PERSON_A);

    // Unpublish → add B while un-published → republish: only B is told.
    h.state.status = "DRAFT";
    h.state.rows = [row(ROW_A, PERSON_A), row(ROW_B, PERSON_B, "DJ")];
    await notifyLineupNotices(h.deps, attached(ROW_B));
    expect(h.notify).toHaveBeenCalledTimes(1);

    h.state.status = "PUBLISHED";
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1][0]).toMatchObject({
      humanId: PERSON_B,
      payload: { eventHumanId: ROW_B, roleLabel: "DJ" },
    });

    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a pre-commit OWED record alone is enough: a crash before dispatch is caught by the next publish", async () => {
    const h = makeHarness({ status: "DRAFT" });
    // What the attach tx does before it commits — then the process "dies"
    // before its post-commit dispatch.
    await recordLineupNoticeOwed(h.deps, {
      eventHumanId: ROW_A,
      addedByHumanId: EDITOR,
      via: "attach",
    });
    h.state.status = "PUBLISHED";
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("recordOwed never throws — it reports", async () => {
    const h = makeHarness();
    h.idempotency.__mocks.commit.mockRejectedValueOnce(new Error("redis down"));
    const hooks = makeLineupNoticeHooks(h.deps);
    await expect(
      hooks.recordOwed({ eventHumanId: ROW_A, addedByHumanId: EDITOR, via: "attach" }),
    ).resolves.toBeUndefined();
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("owed_write_failed");
  });

  it("does not sweep rows this feature never owed (legacy, volunteer-signup, booking-minted, free-text)", async () => {
    const h = makeHarness({
      status: "PUBLISHED",
      rows: [
        row(ROW_LEGACY, LEGACY_PERSON),
        row(ROW_B, PERSON_B, "VOLUNTEER"),
        row(ROW_A, null),
      ],
    });
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a spent time budget stops STARTING sends, lets in-flight ones finish, reports the rest (they stay owed)", async () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `d1000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const people = ids.map((_, i) => `e1000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const h = makeHarness({ status: "PUBLISHED", rows: ids.map((id, i) => row(id, people[i]!)) });
    for (const id of ids) {
      await recordLineupNoticeOwed(h.deps, { eventHumanId: id, addedByHumanId: EDITOR, via: "attach" });
    }
    h.notify.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true, email: { status: "sent" } };
    });
    await notifyLineupNotices(h.deps, { ...published, budgetMs: 20 });

    // The first wave (4) started inside the budget and completed; nothing else started.
    expect(h.notify).toHaveBeenCalledTimes(4);
    const sent = await Promise.all(ids.map((id) => h.idempotency.get(lineupNoticeSentKey(id))));
    expect(sent.filter(Boolean)).toHaveLength(4);
    const budget = h.reportError.mock.calls.find((c) => c[1].tags.reason === "sweep_budget_exhausted");
    expect(budget?.[1].extra).toMatchObject({ rowsNotReached: 6, rowsTotal: 10 });

    // The rest are still owed: the next publish tells them.
    h.notify.mockImplementation(async () => ({ ok: true, email: { status: "sent" } }));
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(10);
  });

  it("sweeps a big lineup with at most 4 sends in flight", async () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const people = ids.map((_, i) => `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const h = makeHarness({
      status: "PUBLISHED",
      rows: ids.map((id, i) => row(id, people[i]!)),
    });
    for (const id of ids) {
      await recordLineupNoticeOwed(h.deps, { eventHumanId: id, addedByHumanId: EDITOR, via: "attach" });
    }
    let inFlight = 0;
    let peak = 0;
    h.notify.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, email: { status: "sent" } };
    });
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("notifyLineupNotices — failures are reported, never thrown, and retried", () => {
  it("a failed send frees the claim and reports; the next publish retries", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    h.notify.mockRejectedValueOnce(new Error("notify down"));

    await expect(notifyLineupNotices(h.deps, attached())).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1]).toMatchObject({
      tags: { useCase: "notifyLineupNotices", reason: "lineup_added_failed" },
    });
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toBeNull();

    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).not.toBeNull();
  });

  it("an email leg that comes back failed is reported but the row stays told", async () => {
    const h = makeHarness();
    h.notify.mockResolvedValueOnce({
      ok: true,
      email: { status: "failed", reason: "port_error" },
    });
    await notifyLineupNotices(h.deps, attached());
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("email_failed");
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("no web origin → reported, nothing sent, but the row stays owed", async () => {
    const h = makeHarness({ publicAppUrl: null });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(await h.idempotency.get(lineupNoticeOwedKey(ROW_A))).not.toBeNull();
  });

  it("a throwing reporter never escapes", async () => {
    const h = makeHarness();
    h.notify.mockRejectedValueOnce(new Error("notify down"));
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(notifyLineupNotices(h.deps, attached())).resolves.toBeUndefined();
  });
});

describe("notifyLineupNotices — 'the organiser will be told' is exact", () => {
  const invitedA = {
    kind: "invited",
    eventId: EVENT_ID,
    eventHumanId: ROW_A,
    addedByHumanId: EDITOR,
    humanId: PERSON_A,
    email: "band@example.org",
  } as const;

  it("an org whose ONLY editor is the person tells nobody → false (added + invite)", async () => {
    // PERSON_A is the org's sole OWNER; the VIEWER is not a leave recipient.
    const members = [
      { humanId: PERSON_A, role: "OWNER" },
      { humanId: PERSON_B, role: "VIEWER" },
    ];
    const added = makeHarness({ members });
    await notifyLineupNotices(added.deps, attached());
    expect(added.notify.mock.calls[0][0].payload.organiserWillBeTold).toBe(false);

    const invite = makeHarness({ members, status: "DRAFT" });
    await notifyLineupNotices(invite.deps, invitedA);
    expect(
      invite.mailer.send.mock.calls[0][0].template.variables.organiserWillBeTold,
    ).toBe(false);
    expect(added.reportError).not.toHaveBeenCalled();
    expect(invite.reportError).not.toHaveBeenCalled();
  });

  it("another editor besides the person → true", async () => {
    const h = makeHarness({
      members: [
        { humanId: PERSON_A, role: "OWNER" },
        { humanId: PERSON_B, role: "EDITOR" },
      ],
    });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify.mock.calls[0][0].payload.organiserWillBeTold).toBe(true);
  });

  it("the publish sweep reads the org's members ONCE per event, not once per row", async () => {
    const h = makeHarness({ rows: [row(ROW_A, PERSON_A), row(ROW_B, PERSON_B)] });
    for (const eventHumanId of [ROW_A, ROW_B]) {
      await recordLineupNoticeOwed(h.deps, { eventHumanId, addedByHumanId: EDITOR, via: "attach" });
    }
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls.every((c: any) => c[0].payload.organiserWillBeTold === true)).toBe(true);
    expect(h.repos.organizations.listMembers).toHaveBeenCalledTimes(1);
  });

  it("a failed read during the sweep is reported once per event, every row still told (flag false)", async () => {
    const h = makeHarness({ members: "throw", rows: [row(ROW_A, PERSON_A), row(ROW_B, PERSON_B)] });
    for (const eventHumanId of [ROW_A, ROW_B]) {
      await recordLineupNoticeOwed(h.deps, { eventHumanId, addedByHumanId: EDITOR, via: "attach" });
    }
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls.every((c: any) => c[0].payload.organiserWillBeTold === false)).toBe(true);
    expect(
      h.reportError.mock.calls.filter((c: any) => c[1].tags.reason === "organiser_told_probe_failed"),
    ).toHaveLength(1);
  });

  it("a failed membership read answers false, is reported, and the notice still goes out", async () => {
    const h = makeHarness({ members: "throw" });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].payload.organiserWillBeTold).toBe(false);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1]).toMatchObject({
      tags: { useCase: "notifyLineupNotices", reason: "organiser_told_probe_failed" },
    });
  });
});

describe("notifyLineupNotices — invited (free-text row linked by email)", () => {
  const invited = {
    kind: "invited",
    eventId: EVENT_ID,
    eventHumanId: ROW_A,
    addedByHumanId: EDITOR,
    humanId: PERSON_A,
    email: "band@example.org",
  } as const;

  it("mails the payout invite once and sends the lineup notice in-app only (published)", async () => {
    const h = makeHarness({ status: "PUBLISHED", shadow: true, paid: true });
    await notifyLineupNotices(h.deps, invited);

    expect(h.mailer.send).toHaveBeenCalledTimes(1);
    expect(h.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "band@example.org" },
        idempotencyKey: `lineup-payout-invite:${ROW_A}`,
        template: {
          key: "event.lineup_payout_invite",
          variables: {
            inviterName: "Sam Rivera",
            eventTitle: "Friday Night Sessions",
            whenLabel: "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
            payoutsUrl: "https://ithasfire.com/admin/@sundowners/payouts",
            accountCompletionUrl:
              "https://ithasfire.com/auth/complete?email=band%40example.org&src=lineup-invite",
            lineupsUrl: "https://ithasfire.com/my-lineups",
            paidEvent: true,
            organiserWillBeTold: true,
          },
        },
      }),
    );
    // One email per person per event: the lineup notice's email leg is off.
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].channels).toEqual({
      sms: { enabled: false },
      email: { enabled: false },
    });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("a free event's invite does not promise 'a share of ticket sales'", async () => {
    const h = makeHarness({ status: "DRAFT", paid: false });
    await notifyLineupNotices(h.deps, invited);
    expect(h.mailer.send.mock.calls[0][0].template.variables.paidEvent).toBe(false);
  });

  it("two concurrent invites on one row mail once (per-row INVITE claim)", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await Promise.all([
      notifyLineupNotices(h.deps, invited),
      notifyLineupNotices(h.deps, invited),
    ]);
    expect(h.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("an invite whose link lost a race to another invite mails nobody and reports", async () => {
    const h = makeHarness({ status: "PUBLISHED", rows: [row(ROW_A, PERSON_B)] });
    await notifyLineupNotices(h.deps, invited);
    expect(h.mailer.send).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("invite_link_lost_race");
  });

  it("on a DRAFT: invite now, lineup notice (still email-off) at publish", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await notifyLineupNotices(h.deps, invited);
    expect(h.mailer.send).toHaveBeenCalledTimes(1);
    expect(h.mailer.send.mock.calls[0][0].template.variables.accountCompletionUrl).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();

    h.state.status = "PUBLISHED";
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].channels.email).toEqual({ enabled: false });
    expect(h.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("reports when no mailer is bound (the builder said 'Invite sent')", async () => {
    const h = makeHarness({ mailer: false, status: "DRAFT" });
    await notifyLineupNotices(h.deps, invited);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe(
      "invite_mailer_unavailable",
    );
  });

  it("reports a mailer that refuses without throwing, and frees the claim for a retry", async () => {
    const h = makeHarness({ status: "DRAFT" });
    h.mailer.send.mockResolvedValueOnce({
      result: { success: false, errorCode: "invalid_input" },
    } as any);
    await notifyLineupNotices(h.deps, invited);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe(
      "payout_invite_refused",
    );
    await notifyLineupNotices(h.deps, invited);
    expect(h.mailer.send).toHaveBeenCalledTimes(2);
  });

  describe("per-recipient caps (security review)", () => {
    const inviteFor = (eventHumanId: string, humanId: string, email = "Band@Example.org ") =>
      ({
        kind: "invited",
        eventId: EVENT_ID,
        eventHumanId,
        addedByHumanId: EDITOR,
        humanId,
        email,
      }) as const;

    it("the 4th payout invite to one address within 24h sends nothing, settles quietly, and reports", async () => {
      const ids = [1, 2, 3, 4].map((i) => `f${i}000000-0000-4000-8000-00000000000${i}`);
      const h = makeHarness({ status: "DRAFT", limiter: "counting", rows: ids.map((id) => row(id, PERSON_A)) });
      for (const id of ids) {
        // Case/whitespace variants of one address share one bucket.
        await notifyLineupNotices(h.deps, inviteFor(id, PERSON_A, id.endsWith("4") ? "band@example.org" : "Band@Example.org "));
      }
      expect(h.mailer.send).toHaveBeenCalledTimes(3);
      expect(await h.idempotency.get(`lineup-notice:invite:${ids[3]}`)).toMatchObject({
        suppressed: "recipient_cap",
      });
      expect(h.reportError.mock.calls.map((c) => c[1].tags.reason)).toContain("invite_recipient_capped");
      const keys = h.rateLimit.consume.mock.calls.map((c) => c[0]);
      expect(new Set(keys.filter((k) => k.startsWith("lineup-notice:invite-recipient:"))).size).toBe(1);
      expect(keys.some((k) => k.includes("example"))).toBe(false); // hashed, never the address
    });

    it("a limiter error fails OPEN for the invite (reported)", async () => {
      const h = makeHarness({ status: "DRAFT", limiter: "throw" });
      await notifyLineupNotices(h.deps, inviteFor(ROW_A, PERSON_A));
      expect(h.mailer.send).toHaveBeenCalledTimes(1);
      expect(h.reportError.mock.calls[0][1].tags.reason).toBe("recipient_cap_failed_open");
    });

    it("past 10 lineup-added notices a day the person is still told in-app, but without email or push", async () => {
      const ids = Array.from({ length: 11 }, (_, i) => `a1000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      const h = makeHarness({ status: "PUBLISHED", limiter: "counting", rows: ids.map((id) => row(id, PERSON_A)) });
      for (const id of ids) {
        // Distinct events in reality; the 7-day cooldown is per event, so
        // clear it between sends to isolate the cross-event cap.
        await notifyLineupNotices(h.deps, attached(id));
        await makeLineupNoticeHooks(h.deps).clearCooldown({ eventId: EVENT_ID, humanId: PERSON_A });
      }
      expect(h.notify).toHaveBeenCalledTimes(11);
      for (const call of h.notify.mock.calls.slice(0, 10)) {
        expect(call[0].channels).toEqual({ sms: { enabled: false } });
      }
      expect(h.notify.mock.calls[10][0].channels).toEqual({
        sms: { enabled: false },
        email: { enabled: false },
        push: { enabled: false },
      });
      expect(h.reportError.mock.calls.map((c) => c[1].tags.reason)).toContain("lineup_recipient_capped");
    });

    it("a limiter error fails OPEN for the lineup notice (full channels)", async () => {
      const h = makeHarness({ status: "PUBLISHED", limiter: "throw" });
      await notifyLineupNotices(h.deps, attached());
      expect(h.notify.mock.calls[0][0].channels).toEqual({ sms: { enabled: false } });
      expect(h.reportError.mock.calls[0][1].tags.reason).toBe("recipient_cap_failed_open");
    });
  });
});

describe("notifyLineupNotices — B2: in-app and push only to a verified account", () => {
  const invited = {
    kind: "invited",
    eventId: EVENT_ID,
    eventHumanId: ROW_A,
    addedByHumanId: EDITOR,
    humanId: PERSON_A,
    email: "band@example.org",
  } as const;

  function flatLogger() {
    const logger = createTestLogger();
    (logger.child as any).mockImplementation(() => logger);
    return logger;
  }

  it("a verified recipient keeps the normal channels", async () => {
    const h = makeHarness({ status: "PUBLISHED", verified: true });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify.mock.calls[0][0].channels).toEqual({ sms: { enabled: false } });
    expect(h.repos.humans.listEmailVerifiedIds).toHaveBeenCalledWith([PERSON_A]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("an unverified recipient: no notify, settled as suppressed, no 7-day window", async () => {
    const h = makeHarness({ status: "PUBLISHED", verified: false });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toMatchObject({
      suppressed: "unverified",
      humanId: PERSON_A,
    });
    expect(await h.idempotency.get(lineupNoticeRecentKey(EVENT_ID, PERSON_A))).toBeNull();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("a failed lookup with email already off (invite): released as failed, not told", async () => {
    const h = makeHarness({ status: "PUBLISHED", shadow: true, verified: "throw" });
    await notifyLineupNotices(h.deps, invited);
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toBeNull();
    expect(await h.idempotency.get(lineupNoticeRecentKey(EVENT_ID, PERSON_A))).toBeNull();
    const reasons = h.reportError.mock.calls.map((c: any[]) => c[1].tags.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(["verified-lookup-failed", "lineup_added_failed"]),
    );
  });

  it("unverified with email already off (invite): no notify, settled, no 7-day window", async () => {
    const h = makeHarness({ status: "PUBLISHED", shadow: true, verified: false });
    await notifyLineupNotices(h.deps, invited);
    expect(h.mailer.send).toHaveBeenCalledTimes(1); // the invite still mails
    expect(h.notify).not.toHaveBeenCalled();
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toMatchObject({
      suppressed: "unverified",
      humanId: PERSON_A,
    });
    expect(await h.idempotency.get(lineupNoticeRecentKey(EVENT_ID, PERSON_A))).toBeNull();
    // A later publish does not try again.
    await notifyLineupNotices(h.deps, published);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("a failed lookup is email only, ERROR-logged and reported", async () => {
    const h = makeHarness({ status: "PUBLISHED", verified: "throw" });
    const logger = flatLogger();
    h.deps.logger = logger;
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify.mock.calls[0][0].channels).toEqual({
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "event_humans.lineup_notice.failed",
      expect.objectContaining({ reason: "verified-lookup-failed", humanId: PERSON_A }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "notifyLineupNotices", reason: "verified-lookup-failed" },
      }),
    );
  });

  it("a failed lookup whose email did not go out: released as failed, not told", async () => {
    const h = makeHarness({ status: "PUBLISHED", verified: "throw" });
    h.notify.mockImplementationOnce(async () => ({
      ok: true,
      email: { status: "skipped", reason: "unverified" },
    }));
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toBeNull();
    expect(await h.idempotency.get(lineupNoticeRecentKey(EVENT_ID, PERSON_A))).toBeNull();
    const reasons = h.reportError.mock.calls.map((c: any[]) => c[1].tags.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(["verified-lookup-failed", "lineup_added_failed"]),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const h = makeHarness({ status: "PUBLISHED", verified: "throw" });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await notifyLineupNotices(h.deps, attached());
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].channels.inApp).toEqual({ enabled: false });
    expect(await h.idempotency.get(lineupNoticeSentKey(ROW_A))).toMatchObject({
      sentAt: expect.any(String),
    });
  });
});
