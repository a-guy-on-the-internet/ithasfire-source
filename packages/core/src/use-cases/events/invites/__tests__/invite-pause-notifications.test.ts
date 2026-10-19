import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { createFakeEventInvitePauses } from "@th/test-utils/fakes/event-invite-pauses";
import { createFakeNotificationsRepo } from "@th/test-utils/fakes/notifications-repo";

import { renderStoredNotification } from "../../../comms/render-stored-notification";
import {
  decideInvitePause,
  recordInviteComplaint,
} from "../invite-complaint-pause";
import {
  INVITE_PAUSE_NOTE_PREVIEW_MAX,
  notifyInvitePauseOpened,
} from "../invite-pause-notifications";
import { inviteEmailMetadata } from "../invite-owner-tag";

/**
 * In-app notices for the invite complaint auto-pause (owner ruling
 * 2026-10-07: in-app only). Own minimal world, so these run without the
 * shared invite world's pause wiring.
 */

const NOW = new Date("2026-10-07T12:00:00.000Z");
const SECRET = "s".repeat(40);
const ORG_ID = "0a000000-0000-4000-8000-000000000001";
const HUMAN_OWNER = "0b000000-0000-4000-8000-000000000001";
const ORG_EVENT = "0c000000-0000-4000-8000-000000000001";
const HUMAN_EVENT = "0c000000-0000-4000-8000-000000000002";
const STAFF = "0d000000-0000-4000-8000-000000000001";
const OWNER = "0e000000-0000-4000-8000-000000000001";
const ADMIN = "0e000000-0000-4000-8000-000000000002";
const EDITOR = "0e000000-0000-4000-8000-000000000003";
const FINANCE = "0e000000-0000-4000-8000-000000000004";
const VIEWER = "0e000000-0000-4000-8000-000000000005";

function createWorld(opts: { recipients?: number } = {}) {
  const pauses = createFakeEventInvitePauses();
  pauses.state.recipients = opts.recipients ?? 500;
  const notifications = createFakeNotificationsRepo();
  const audit = { log: vi.fn(async () => undefined) };
  const optOuts = { add: vi.fn(async () => undefined) };
  const events = new Map([
    [ORG_EVENT, { id: ORG_EVENT, orgId: ORG_ID, humanId: null }],
    [HUMAN_EVENT, { id: HUMAN_EVENT, orgId: null, humanId: HUMAN_OWNER }],
  ]);
  const members = [
    { humanId: OWNER, role: "OWNER" },
    { humanId: ADMIN, role: "ADMIN" },
    { humanId: EDITOR, role: "EDITOR" },
    { humanId: FINANCE, role: "FINANCE" },
    { humanId: VIEWER, role: "VIEWER" },
  ];
  const txRepos = {
    eventInvitePauses: pauses.repo,
    eventInviteOptOuts: optOuts,
    audit,
  };
  const repos = {
    tx: async <T>(fn: (tx: typeof txRepos) => Promise<T>) => fn(txRepos),
    eventInvitePauses: pauses.repo,
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID ? { id, name: "Acme Presents", slug: "acme" } : null,
      ),
      listMembers: vi.fn(
        async (input: { limit: number; offset: number }) => ({
          items: members.slice(input.offset, input.offset + input.limit),
          total: members.length,
        }),
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === HUMAN_OWNER ? { id, name: "Jamie Rivera" } : null,
      ),
      getByIdWithIdentity: vi.fn(async (id: string) =>
        id === HUMAN_OWNER ? { id, identity: { username: "jamie" } } : null,
      ),
    },
    events: { getById: vi.fn(async (id: string) => events.get(id) ?? null) },
    entityPages: {
      getByOwner: vi.fn(async () => null),
      // Public pages, keyed by owner TYPE. The org's page slug deliberately
      // differs from `Organization.slug` ("acme", the /admin key) so a
      // regression to the admin slug fails the staff-queue assertions.
      getByOwners: vi.fn(async (type: string, ids: string[]) => {
        if (type === "ORGANIZATION") {
          return ids.includes(ORG_ID)
            ? [{ ownerId: ORG_ID, slug: "acme-presents-1a2b3c" }]
            : [];
        }
        if (type === "HUMAN") {
          return ids.includes(HUMAN_OWNER)
            ? [{ ownerId: HUMAN_OWNER, slug: "jamie-rivera" }]
            : [];
        }
        return [];
      }),
    },
    notifications,
  };
  return { repos, pauses, notifications, audit, events };
}

type World = ReturnType<typeof createWorld>;

function recordDeps(world: World) {
  return {
    repos: world.repos as unknown as Repos,
    clock: { now: () => NOW },
    inviteOptOutSecret: SECRET,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
  };
}

function staffDeps(world: World) {
  return {
    repos: world.repos as unknown as Repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) },
    clock: { now: () => NOW },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
  };
}

let seq = 0;
function complaint(
  email: string,
  event: { id: string; orgId: string | null; humanId: string | null },
) {
  seq += 1;
  return {
    providerEventId: `evt_${seq}`,
    email,
    occurredAt: NOW,
    metadata: inviteEmailMetadata(event, new Date(NOW.getTime() - 3_600_000))!,
  };
}

const orgEvent = { id: ORG_EVENT, orgId: ORG_ID, humanId: null };
const humanEvent = { id: HUMAN_EVENT, orgId: null, humanId: HUMAN_OWNER };

function rows(world: World) {
  return [...world.notifications.__records.values()];
}

describe("recordInviteComplaint: in-app notice when a pause opens", () => {
  it("count trip, org-owned: tells every OWNER/ADMIN/EDITOR (not FINANCE/VIEWER), once, linking the event's invite settings", async () => {
    const world = createWorld({ recipients: 1000 });
    const deps = recordDeps(world);
    for (const email of ["a@example.com", "b@example.com"]) {
      await recordInviteComplaint(deps, complaint(email, orgEvent));
    }
    expect(rows(world)).toHaveLength(0);

    const third = await recordInviteComplaint(deps, complaint("c@example.com", orgEvent));
    expect(third).toMatchObject({ outcome: "RECORDED", paused: "COMPLAINT_COUNT" });

    const sent = rows(world);
    expect(sent.map((r) => r.humanId).sort()).toEqual([ADMIN, EDITOR, OWNER].sort());
    const row = sent[0]!;
    expect(row.title).toBe("Invites from Acme Presents are paused");
    expect(row.body).toBe(
      "3 people marked your invite emails as spam in the last 30 days. Invite emails are on hold until a review lifts the pause. Your shared invite link still works.",
    );
    expect(row.kind).toBe("WARNING");
    expect(row.action).toEqual({
      label: "Ask for a review",
      route: `/admin/acme/events/${ORG_EVENT}/edit?section=settings`,
    });
    expect(row.templateKey).toBe("invite-pause.opened");
    expect(row.metadata?.variant).toBe("invite-pause.opened");
    expect(deps.reportError).not.toHaveBeenCalled();

    // The stored row re-renders in Spanish for a Spanish reader.
    const es = renderStoredNotification({}, row, "es");
    expect(es.title).toBe("Las invitaciones de Acme Presents están en pausa");
    expect(es.action?.label).toBe("Pedir una revisión");
  });

  it("rate trip, person-owned: tells the owner, with the rate sentence", async () => {
    const world = createWorld({ recipients: 40 });
    const deps = recordDeps(world);
    const result = await recordInviteComplaint(deps, complaint("a@example.com", humanEvent));
    expect(result).toMatchObject({ paused: "COMPLAINT_RATE" });

    const sent = rows(world);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.humanId).toBe(HUMAN_OWNER);
    expect(sent[0]!.title).toBe("Your invites are paused");
    expect(sent[0]!.body).toMatch(
      /^1 of the 40 people you invited in the last 30 days marked the email as spam\./,
    );
    expect(sent[0]!.action?.route).toBe(
      `/admin/@jamie/events/${HUMAN_EVENT}/edit?section=settings`,
    );
  });

  it("does not notify on a webhook replay, or on a complaint while already paused", async () => {
    const world = createWorld({ recipients: 40 });
    const deps = recordDeps(world);
    const first = complaint("a@example.com", humanEvent);
    await recordInviteComplaint(deps, first);
    expect(rows(world)).toHaveLength(1);

    const replay = await recordInviteComplaint(deps, first);
    expect(replay).toMatchObject({ created: false, paused: null, alreadyPaused: true });
    await recordInviteComplaint(deps, complaint("b@example.com", humanEvent));
    expect(rows(world)).toHaveLength(1);
  });

  it("does not notify when the complaint opens no pause", async () => {
    const world = createWorld({ recipients: 1000 });
    const deps = recordDeps(world);
    const result = await recordInviteComplaint(deps, complaint("a@example.com", orgEvent));
    expect(result).toMatchObject({ paused: null, alreadyPaused: false });
    expect(rows(world)).toHaveLength(0);
  });

  const gone = { id: "0c000000-0000-4000-8000-0000000000ff", orgId: ORG_ID, humanId: null };

  it("tagged event gone: deep-links the event of the owner's latest complaint that still exists", async () => {
    const world = createWorld({ recipients: 1000 });
    const deps = recordDeps(world);
    await recordInviteComplaint(deps, complaint("a@example.com", orgEvent));
    await recordInviteComplaint(deps, complaint("b@example.com", orgEvent));
    // The third trips the count; its own event no longer exists.
    await recordInviteComplaint(deps, complaint("c@example.com", gone));
    expect(rows(world)[0]!.action).toEqual({
      label: "Ask for a review",
      route: `/admin/acme/events/${ORG_EVENT}/edit?section=settings`,
    });
  });

  it("no usable event at all: links the events list with the honest label", async () => {
    const world = createWorld({ recipients: 40 });
    const deps = recordDeps(world);
    await recordInviteComplaint(deps, complaint("a@example.com", gone));
    expect(rows(world)[0]!.action).toEqual({
      label: "Open your events",
      route: "/admin/acme/events",
    });
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("a throwing logger stops nothing: every editor still gets a create attempt, and Sentry hears", async () => {
    const world = createWorld({ recipients: 40 });
    world.notifications.__mocks.create.mockRejectedValue(new Error("inbox down"));
    const deps = recordDeps(world);
    deps.logger.error.mockImplementation(() => {
      throw new Error("logger down");
    });
    deps.logger.info.mockImplementation(() => {
      throw new Error("logger down");
    });
    // The notifier on its own, with every row failing (the end-to-end
    // broken-logger path is the next test).
    const sent = await notifyInvitePauseOpened(deps, {
      pauseId: "p1",
      owner: { kind: "ORG", orgId: ORG_ID },
      eventId: ORG_EVENT,
      reason: "COMPLAINT_COUNT",
      complaintCount: 3,
      recipientCount: 100,
      windowDays: 30,
    });
    expect(sent).toBe(0);
    expect(world.notifications.__mocks.create).toHaveBeenCalledTimes(3);
    expect(deps.reportError).toHaveBeenCalledTimes(3);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "inbox down" }),
      expect.objectContaining({ tags: expect.objectContaining({ channel: "create_failed" }) }),
    );
  });

  it("end to end, a throwing logger drops nothing: the pause opens, every editor is told, nothing throws", async () => {
    const world = createWorld({ recipients: 40 });
    const deps = recordDeps(world);
    for (const level of ["info", "warn", "error"] as const) {
      deps.logger[level].mockImplementation(() => {
        throw new Error("logger down");
      });
    }
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com", orgEvent)),
    ).resolves.toEqual({
      outcome: "RECORDED",
      created: true,
      paused: "COMPLAINT_RATE",
      alreadyPaused: false,
    });
    expect(rows(world).map((r) => r.humanId).sort()).toEqual([ADMIN, EDITOR, OWNER].sort());
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("a swallowed failure is reported even when the logger throws, and still answers (no webhook retry)", async () => {
    const world = createWorld();
    const deps = recordDeps(world);
    deps.logger.error.mockImplementation(() => {
      throw new Error("logger down");
    });
    await expect(
      recordInviteComplaint(deps, {
        ...complaint("a@example.com", orgEvent),
        metadata: { inviteOwner: "org-not-a-uuid" },
      }),
    ).resolves.toEqual({ outcome: "UNATTRIBUTABLE" });
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "malformed_owner_tag" }),
      }),
    );
  });

  it("an unexpected throw outside deliver's own guards is reported, not silent", async () => {
    const world = createWorld({ recipients: 40 });
    const deps = recordDeps(world);
    // A `notifications` getter that throws: only the outer guard catches it.
    const repos = Object.defineProperty({ ...world.repos }, "notifications", {
      get() {
        throw new Error("boom");
      },
    });
    const sent = await notifyInvitePauseOpened(
      { ...deps, repos: repos as unknown as Repos },
      {
        pauseId: "p1",
        owner: { kind: "ORG", orgId: ORG_ID },
        eventId: null,
        reason: "COMPLAINT_COUNT",
        complaintCount: 3,
        recipientCount: 100,
        windowDays: 30,
      },
    );
    expect(sent).toBe(0);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({
        tags: expect.objectContaining({ notice: "opened", channel: "unexpected" }),
        extra: { pauseId: "p1" },
      }),
    );
  });

  it("person owner with no username and no page: links under @<humanId>", async () => {
    const world = createWorld({ recipients: 40 });
    world.repos.humans.getByIdWithIdentity.mockResolvedValue(null);
    const deps = recordDeps(world);
    await recordInviteComplaint(deps, complaint("a@example.com", humanEvent));
    expect(rows(world)[0]!.action?.route).toBe(
      `/admin/@${HUMAN_OWNER}/events/${HUMAN_EVENT}/edit?section=settings`,
    );
  });

  it("a throwing notifications repo is reported (guarded) and changes nothing: the pause stands, the result is the same", async () => {
    const world = createWorld({ recipients: 40 });
    world.notifications.__mocks.create.mockRejectedValue(new Error("inbox down"));
    const deps = recordDeps(world);
    deps.reportError.mockImplementation(() => {
      throw new Error("reporter down too");
    });
    const result = await recordInviteComplaint(deps, complaint("a@example.com", orgEvent));
    expect(result).toEqual({
      outcome: "RECORDED",
      created: true,
      paused: "COMPLAINT_RATE",
      alreadyPaused: false,
    });
    expect(world.pauses.pauses.filter((p) => !p.liftedAt)).toHaveLength(1);
    // One report per recipient whose row failed.
    expect(deps.reportError).toHaveBeenCalledTimes(3);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "inbox down" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "events.invitePauseNotifications",
          notice: "opened",
          channel: "create_failed",
        }),
      }),
    );
  });

  it("a failed member lookup is reported and the pause stands", async () => {
    const world = createWorld({ recipients: 40 });
    world.repos.organizations.listMembers.mockRejectedValue(new Error("members down"));
    const deps = recordDeps(world);
    const result = await recordInviteComplaint(deps, complaint("a@example.com", orgEvent));
    expect(result).toMatchObject({ outcome: "RECORDED", paused: "COMPLAINT_RATE" });
    expect(rows(world)).toHaveLength(0);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "members down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "prepare_failed" }),
      }),
    );
  });
});

describe("decideInvitePause: in-app notice of the decision", () => {
  type Owner = { kind: "ORG"; orgId: string } | { kind: "HUMAN"; humanId: string };
  async function seedComplaint(
    world: World,
    owner: Owner,
    eventId: string | null,
    occurredAt = NOW,
  ) {
    seq += 1;
    await world.pauses.repo.recordComplaint({
      providerEventId: `seed_${seq}`,
      owner,
      eventId,
      emailHash: `h${seq}`,
      sentAt: null,
      occurredAt,
    });
  }

  it("LIFTED: tells the org's editors invites are back on, deep-linking the latest complaint's event", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "ORG", orgId: ORG_ID });
    await seedComplaint(world, { kind: "ORG", orgId: ORG_ID }, ORG_EVENT);
    const deps = staffDeps(world);
    const out = await decideInvitePause(deps, {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "LIFTED",
    });
    // The org's PUBLIC page slug (for /orgs/<slug>), not the admin `acme`.
    expect(out.pause).toMatchObject({
      ownerName: "Acme Presents",
      ownerSlug: "acme-presents-1a2b3c",
    });
    expect(world.repos.entityPages.getByOwners).toHaveBeenCalledWith("ORGANIZATION", [
      ORG_ID,
    ]);
    const sent = rows(world);
    expect(sent.map((r) => r.humanId).sort()).toEqual([ADMIN, EDITOR, OWNER].sort());
    expect(sent[0]!.title).toBe("Invites from Acme Presents are back on");
    expect(sent[0]!.body).toBe(
      "Our team reviewed the pause and lifted it. You can send invite emails again.",
    );
    expect(sent[0]!.kind).toBe("SUCCESS");
    expect(sent[0]!.action).toEqual({
      label: "Send invites",
      route: `/admin/acme/events/${ORG_EVENT}/edit?section=settings`,
    });
    expect(sent[0]!.templateKey).toBe("invite-pause.decided");
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("KEPT: tells the person-owner it stays paused, quoting the note clipped", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "HUMAN", humanId: HUMAN_OWNER });
    await seedComplaint(world, { kind: "HUMAN", humanId: HUMAN_OWNER }, HUMAN_EVENT);
    const deps = staffDeps(world);
    const longNote = `Complaints kept coming. ${"x".repeat(600)}`;
    const out = await decideInvitePause(deps, {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "KEPT",
      note: longNote,
    });
    // The PUBLIC page slug (for /humans/<slug>), not the admin `@jamie`.
    expect(out.pause.ownerSlug).toBe("jamie-rivera");
    const sent = rows(world);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.humanId).toBe(HUMAN_OWNER);
    expect(sent[0]!.title).toBe("Your invites stay paused");
    expect(sent[0]!.body).toMatch(
      /^Our team reviewed the pause and kept it for now\. Note from our team: Complaints kept coming\. x+… You can ask for another review\.$/,
    );
    const quoted = (sent[0]!.templateVariables as { note: string }).note;
    expect(quoted.length).toBe(INVITE_PAUSE_NOTE_PREVIEW_MAX);
    expect(sent[0]!.action).toEqual({
      label: "See what to do",
      route: `/admin/@jamie/events/${HUMAN_EVENT}/edit?section=settings`,
    });
    // The full note still lands on the pause row.
    expect(world.pauses.pauses[0]!.decisionNote).toBe(longNote);
  });

  it("a throwing notifier is reported and the decision stands", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "HUMAN", humanId: HUMAN_OWNER });
    world.notifications.__mocks.create.mockRejectedValue(new Error("inbox down"));
    const deps = staffDeps(world);
    const out = await decideInvitePause(deps, {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "LIFTED",
    });
    expect(out.pause.decision).toBe("LIFTED");
    expect(world.pauses.pauses[0]!.liftedAt).toEqual(NOW);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "inbox down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ notice: "decided", channel: "create_failed" }),
      }),
    );
  });

  it("complaint event now owned by someone else: events list, honest label", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "ORG", orgId: ORG_ID });
    await seedComplaint(world, { kind: "ORG", orgId: ORG_ID }, HUMAN_EVENT);
    const deps = staffDeps(world);
    await decideInvitePause(deps, {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "KEPT",
      note: "Not yet",
    });
    expect(rows(world)[0]!.action).toEqual({
      label: "Open your events",
      route: "/admin/acme/events",
    });
    expect(rows(world)[0]!.body).toContain("Note from our team: Not yet. You can ask");
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("the latest complaint WITH an event wins; a failed lookup is reported and falls back", async () => {
    const owner = { kind: "ORG", orgId: ORG_ID } as const;
    const world = createWorld();
    const pause = world.pauses.seedPause(owner);
    await seedComplaint(world, owner, ORG_EVENT, new Date(NOW.getTime() - 5_000));
    await seedComplaint(world, owner, null, NOW);
    await decideInvitePause(staffDeps(world), {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "KEPT",
      note: "a",
    });
    expect(rows(world)[0]!.action?.route).toBe(
      `/admin/acme/events/${ORG_EVENT}/edit?section=settings`,
    );

    const failing = createWorld();
    const p2 = failing.pauses.seedPause(owner);
    await seedComplaint(failing, owner, ORG_EVENT);
    failing.repos.events.getById.mockRejectedValue(new Error("events down"));
    const d2 = staffDeps(failing);
    await decideInvitePause(d2, { actorHumanId: STAFF, pauseId: p2.id, decision: "LIFTED" });
    expect(rows(failing)).toHaveLength(3);
    expect(rows(failing)[0]!.action).toEqual({
      label: "Open your events",
      route: "/admin/acme/events",
    });
    expect(d2.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "events down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "link_lookup_failed" }),
      }),
    );
  });

  it("a repeated KEEP with the same note is idempotent: no audit row, no second notice", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "HUMAN", humanId: HUMAN_OWNER });
    const deps = staffDeps(world);
    const keep = {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "KEPT" as const,
      note: "Same note.",
    };
    const first = await decideInvitePause(deps, keep);
    const second = await decideInvitePause(deps, keep);
    expect(second.pause).toEqual(first.pause);
    expect(rows(world)).toHaveLength(1);
    expect(world.audit.log).toHaveBeenCalledTimes(1);

    // A different note is a real decision.
    await decideInvitePause(deps, { ...keep, note: "Different note." });
    expect(rows(world)).toHaveLength(2);
    // So is the same note after a new review request.
    world.pauses.pauses[0]!.reviewRequestedAt = NOW;
    await decideInvitePause(deps, { ...keep, note: "Different note." });
    expect(rows(world)).toHaveLength(3);
    expect(world.audit.log).toHaveBeenCalledTimes(3);
  });

  it("another reviewer's identical KEEP is a real decision: recorded, audited, told", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "HUMAN", humanId: HUMAN_OWNER });
    const deps = staffDeps(world);
    const keep = { pauseId: pause.id, decision: "KEPT" as const, note: "Same note." };
    await decideInvitePause(deps, { ...keep, actorHumanId: STAFF });
    const OTHER_STAFF = "0d000000-0000-4000-8000-000000000002";
    const second = await decideInvitePause(deps, { ...keep, actorHumanId: OTHER_STAFF });
    expect(second.pause.decidedByHumanId).toBe(OTHER_STAFF);
    expect(rows(world)).toHaveLength(2);
    expect(world.audit.log).toHaveBeenCalledTimes(2);
  });

  it("a failed owner-name read after the commit degrades to null (reported); the decision still returns", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause({ kind: "HUMAN", humanId: HUMAN_OWNER });
    world.repos.humans.getById.mockRejectedValue(new Error("humans down"));
    const deps = staffDeps(world);
    const out = await decideInvitePause(deps, {
      actorHumanId: STAFF,
      pauseId: pause.id,
      decision: "LIFTED",
    });
    expect(out.pause).toMatchObject({ decision: "LIFTED", ownerName: null });
    expect(world.pauses.pauses[0]!.liftedAt).toEqual(NOW);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "humans down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "owner_name_lookup_failed" }),
      }),
    );
  });

  it("a refused decision (already lifted) sends nothing", async () => {
    const world = createWorld();
    const pause = world.pauses.seedPause(
      { kind: "HUMAN", humanId: HUMAN_OWNER },
      { liftedAt: NOW, decision: "LIFTED", decidedAt: NOW },
    );
    const deps = staffDeps(world);
    await expect(
      decideInvitePause(deps, { actorHumanId: STAFF, pauseId: pause.id, decision: "LIFTED" }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(rows(world)).toHaveLength(0);
  });
});
