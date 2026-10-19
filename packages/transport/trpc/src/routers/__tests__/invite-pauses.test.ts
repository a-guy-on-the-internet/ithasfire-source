import { describe, expect, it, vi } from "vitest";

import { createFakeEventInvitePauses } from "@th/test-utils/fakes/event-invite-pauses";

import type { Ctx } from "../../context";
import { appRouter } from "../../router";
import {
  MIDDLEWARE_STAFF_PROBE,
  buildBaseCtx,
  staffProbeAnswer,
} from "./test-helpers";

/**
 * Invite complaint auto-pause (W4), transport side: organiser status/review
 * under `invitePauses.*`, staff queue/decision under
 * `platform.invitePauses.*` (inside the wholesale staff 2FA gate). Authz is
 * the use cases'; these pin that it reaches the wire and maps to tRPC codes.
 */

const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";
const EVENT_A = "20000000-0000-4000-8000-00000000000a";
const EVENT_B = "20000000-0000-4000-8000-00000000000b";
const ORGANISER_A = "30000000-0000-4000-8000-00000000000a";
const ORGANISER_B = "30000000-0000-4000-8000-00000000000b";
const STAFF = "60000000-0000-4000-8000-000000000006";
const PERSON_WITH_PAGE = "70000000-0000-4000-8000-000000000007";
const PERSON_NO_PAGE = "70000000-0000-4000-8000-000000000008";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const event = (id: string, orgId: string) => ({
  id,
  orgId,
  humanId: null,
  stewardship: "OWNED",
  status: "PUBLISHED",
});

function setup(opts: { staff?: boolean; secondFactor?: boolean } = {}) {
  const pauses = createFakeEventInvitePauses();
  const pauseA = pauses.seedPause(
    { kind: "ORG", orgId: ORG_A },
    { reviewRequestedAt: NOW, reviewRequestNote: "please" },
  );
  const memberships = new Map([
    [`${ORG_A}:${ORGANISER_A}`, "ADMIN"],
    [`${ORG_B}:${ORGANISER_B}`, "ADMIN"],
  ]);
  const events = new Map([
    [EVENT_A, event(EVENT_A, ORG_A)],
    [EVENT_B, event(EVENT_B, ORG_B)],
  ]);
  const repos = {
    events: { getById: vi.fn(async (id: string) => events.get(id) ?? null) },
    authz: {
      getOrgMembership: vi.fn(async (i: { orgId: string; humanId: string }) => {
        const role = memberships.get(`${i.orgId}:${i.humanId}`);
        return role ? { role } : null;
      }),
      getHumanDelegation: vi.fn(async () => null),
    },
    humans: {
      getById: vi.fn(async () => null),
    },
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_A ? { id, name: "Org A", slug: "org-a" } : null,
      ),
      listMembers: vi.fn(async (i: { orgId: string }) =>
        i.orgId === ORG_A
          ? { items: [{ humanId: ORGANISER_A, role: "ADMIN" }], total: 1 }
          : { items: [], total: 0 },
      ),
    },
    notifications: {
      create: vi.fn(async () => ({ id: "n1", createdAt: NOW })),
    },
    entityPages: {
      // Public pages by owner TYPE. Org A's page slug deliberately differs
      // from `Organization.slug` ("org-a", the /admin key): /orgs/[slug]
      // resolves the PAGE slug.
      getByOwners: vi.fn(async (type: string, ids: string[]) => {
        if (type === "ORGANIZATION") {
          return ids.includes(ORG_A) ? [{ ownerId: ORG_A, slug: "org-a-page-9f8e" }] : [];
        }
        if (type === "HUMAN") {
          return ids.includes(PERSON_WITH_PAGE)
            ? [{ ownerId: PERSON_WITH_PAGE, slug: "jamie-rivera" }]
            : [];
        }
        return [];
      }),
    },
    eventInvitePauses: pauses.repo,
    audit: { log: vi.fn() },
    async tx<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(repos);
    },
  };
  // Answers as the authz port does: STAFF holds ADMIN (when `staff`), and
  // with no second factor enrolled the port refuses them with
  // `secondFactorRequired`.
  const authz = {
    hasStaffRole: vi.fn(
      async (i: {
        actorHumanId: string;
        requiredRoles: string[];
        allowWithoutSecondFactor?: boolean;
      }) =>
        staffProbeAnswer(
          {
            held: opts.staff && i.actorHumanId === STAFF ? ["ADMIN"] : [],
            enrolled: opts.secondFactor ?? true,
          },
          i,
        ),
    ),
  };
  const reportError = vi.fn();
  const callerAs = (actorHumanId: string) =>
    appRouter.createCaller(
      buildBaseCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: authz as unknown as Ctx["authz"],
        clock: { now: () => NOW } as unknown as Ctx["clock"],
        reportError: reportError as unknown as Ctx["reportError"],
        actorHumanId,
      }) as Ctx,
    ) as any;
  return { pauses, pauseA, callerAs, repos, reportError, authz };
}

describe("router contract", () => {
  const paths = Object.keys(appRouter._def.procedures);
  it("mounts staff procedures under platform.* (2FA gate) and organiser ones at invitePauses.*", () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        "platform.invitePauses.list",
        "platform.invitePauses.decide",
        "invitePauses.status",
        "invitePauses.requestReview",
      ]),
    );
    expect(paths.filter((p) => /^invitePauses\.(list|decide)$/.test(p))).toEqual([]);
  });
});

describe("invitePauses.status / requestReview", () => {
  it("the organiser sees their pause (no addresses)", async () => {
    const { callerAs } = setup();
    const out = await callerAs(ORGANISER_A).invitePauses.status({ eventId: EVENT_A });
    expect(out).toMatchObject({
      paused: true,
      pause: { reason: "COMPLAINT_COUNT", canRequestReview: false },
    });
  });

  it("an organiser of ANOTHER org can't read this event's status", async () => {
    const { callerAs } = setup();
    await expect(
      callerAs(ORGANISER_B).invitePauses.status({ eventId: EVENT_A }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("org B's own status says not paused (scoped to the owner)", async () => {
    const { callerAs } = setup();
    await expect(
      callerAs(ORGANISER_B).invitePauses.status({ eventId: EVENT_B }),
    ).resolves.toEqual({ paused: false, pause: null, lastDecision: null });
  });

  it("asking twice is CONFLICT; strict input", async () => {
    const { callerAs } = setup();
    await expect(
      callerAs(ORGANISER_A).invitePauses.requestReview({ eventId: EVENT_A }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      callerAs(ORGANISER_A).invitePauses.requestReview({
        eventId: EVENT_A,
        actorHumanId: ORGANISER_B,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("platform.invitePauses.*", () => {
  it("a non-staff caller can't list or decide", async () => {
    const { callerAs, pauseA } = setup();
    await expect(
      callerAs(ORGANISER_A).platform.invitePauses.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerAs(ORGANISER_A).platform.invitePauses.decide({
        pauseId: pauseA.id,
        decision: "LIFTED",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("staff without a second factor are stopped by the platform.* gate", async () => {
    const { callerAs, authz, pauses } = setup({ staff: true, secondFactor: false });
    const listSpy = vi.spyOn(pauses.repo, "list");
    await expect(
      callerAs(STAFF).platform.invitePauses.list({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "SECOND_FACTOR_REQUIRED" },
    });
    // The middleware's default probe refused; the use case never asked.
    expect(authz.hasStaffRole).toHaveBeenCalledTimes(1);
    expect(authz.hasStaffRole).toHaveBeenCalledWith(MIDDLEWARE_STAFF_PROBE(STAFF));
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("staff list the queue and lift; the organiser is told, then sees LIFTED", async () => {
    const { callerAs, pauseA, repos, reportError } = setup({ staff: true });
    const listed = await callerAs(STAFF).platform.invitePauses.list({});
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual([pauseA.id]);

    const decided = await callerAs(STAFF).platform.invitePauses.decide({
      pauseId: pauseA.id,
      decision: "LIFTED",
      note: "Looks like a real mailing list.",
    });
    expect(decided.pause).toMatchObject({
      decision: "LIFTED",
      liftedAt: NOW,
      ownerName: "Org A",
      ownerSlug: "org-a-page-9f8e",
    });
    // The in-app notice reached the org's editor, cleanly.
    expect(repos.notifications.create).toHaveBeenCalledTimes(1);
    expect(repos.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ORGANISER_A,
        title: "Invites from Org A are back on",
        template: expect.objectContaining({ key: "invite-pause.decided" }),
      }),
    );
    expect(reportError).not.toHaveBeenCalled();

    await expect(
      callerAs(ORGANISER_A).invitePauses.status({ eventId: EVENT_A }),
    ).resolves.toMatchObject({
      paused: false,
      lastDecision: { decision: "LIFTED", note: "Looks like a real mailing list." },
    });
  });

  it("list carries ownerSlug: the org's page slug, the person's page slug, else null; batched", async () => {
    const { callerAs, pauses, repos, reportError } = setup({ staff: true });
    const withPage = pauses.seedPause(
      { kind: "HUMAN", humanId: PERSON_WITH_PAGE },
      { reviewRequestedAt: NOW },
    );
    const noPage = pauses.seedPause(
      { kind: "HUMAN", humanId: PERSON_NO_PAGE },
      { reviewRequestedAt: NOW },
    );
    const listed = await callerAs(STAFF).platform.invitePauses.list({ status: "OPEN" });
    const slugById = new Map(
      listed.items.map((i: { id: string; ownerSlug: string | null }) => [i.id, i.ownerSlug]),
    );
    expect(slugById.size).toBe(3);
    expect([...slugById.values()].sort()).toEqual(["jamie-rivera", "org-a-page-9f8e", null].sort());
    expect(slugById.get(withPage.id)).toBe("jamie-rivera");
    expect(slugById.get(noPage.id)).toBeNull();
    // One batched call per owner kind for the whole page.
    expect(repos.entityPages.getByOwners).toHaveBeenCalledTimes(2);
    expect(repos.entityPages.getByOwners).toHaveBeenCalledWith("ORGANIZATION", [ORG_A]);
    expect(repos.entityPages.getByOwners).toHaveBeenCalledWith(
      "HUMAN",
      expect.arrayContaining([PERSON_WITH_PAGE, PERSON_NO_PAGE]),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed slug lookup degrades to null and is reported; the queue still answers", async () => {
    const { callerAs, repos, reportError } = setup({ staff: true });
    repos.entityPages.getByOwners.mockRejectedValue(new Error("pages down"));
    const listed = await callerAs(STAFF).platform.invitePauses.list({});
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].ownerSlug).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "pages down" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "listInvitePauses",
          channel: "owner_slug_lookup_failed",
        }),
      }),
    );
  });

  it("KEEP without a note is BAD_REQUEST", async () => {
    const { callerAs, pauseA } = setup({ staff: true });
    await expect(
      callerAs(STAFF).platform.invitePauses.decide({
        pauseId: pauseA.id,
        decision: "KEPT",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
