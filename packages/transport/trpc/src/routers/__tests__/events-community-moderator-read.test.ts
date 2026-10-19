import { beforeEach, describe, expect, it, vi } from "vitest";

import * as eventsUseCases from "@th/core/use-cases/events";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * A hidden COMMUNITY listing (a draft nobody owns) is readable by a community
 * moderator, and that read is a staff grant: the use cases ask the authz port
 * (`hasStaffRole`), which counts a staff role only with a second factor
 * enrolled. Each `events.*` procedure has to hand `ctx.authz` to its use
 * case for that to work; one that forgets gives the moderator the stranger's
 * answer. These tests run the real procedures, so a procedure listed here
 * that drops the probe fails its "enrolled moderator" row.
 */

const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const SLUG = "hidden-community-listing";
const ENROLLED_MODERATOR = "11111111-1111-4111-8111-111111111111";
const UNENROLLED_MODERATOR = "22222222-2222-4222-8222-222222222222";
const STRANGER = "44444444-4444-4444-8444-444444444444";

const hiddenListing = {
  id: EVENT_ID,
  slug: SLUG,
  orgId: null,
  humanId: null,
  stewardship: "COMMUNITY",
  status: "DRAFT",
  publishedAt: null,
  gateType: "NONE",
  visibility: "PUBLIC",
  passwordHash: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
};

function buildRepos(): Ctx["repos"] {
  return {
    events: {
      resolveBySlug: vi.fn(async (slug: string) =>
        slug === SLUG
          ? { eventId: EVENT_ID, currentSlug: SLUG, redirect: false }
          : null,
      ),
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID ? hiddenListing : null,
      ),
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.includes(EVENT_ID) ? [hiddenListing] : [],
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () => null),
      getHumanDelegation: vi.fn(async () => null),
      // The raw role read says "moderator" for everyone: a procedure that
      // decided the read from it would let the un-enrolled moderator and the
      // stranger in.
      getStaffRolesForHumanId: vi.fn(async () => ["COMMUNITY_MODERATOR"]),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => false) },
    eventApplications: {},
    eventInvites: { getById: vi.fn(async () => null) },
    seriesOccurrences: {
      getCalendarInfoForEventIds: vi.fn(async (ids: string[]) =>
        ids.map((eventId) => ({
          eventId,
          seriesId: "55555555-5555-4555-8555-555555555555",
          seriesName: "Tuesday sessions",
          occurrenceId: "66666666-6666-4666-8666-666666666666",
        })),
      ),
    },
  } as unknown as Ctx["repos"];
}

/**
 * The staff probe as the authz adapter answers it: a held role counts only
 * with a second factor enrolled, unless the caller opts out.
 */
function buildAuthzPort(): Ctx["authz"] {
  const staff: Record<string, { roles: string[]; enrolled: boolean }> = {
    [ENROLLED_MODERATOR]: { roles: ["COMMUNITY_MODERATOR"], enrolled: true },
    [UNENROLLED_MODERATOR]: { roles: ["COMMUNITY_MODERATOR"], enrolled: false },
  };
  return {
    hasOrgRole: vi.fn(),
    requireOrgRole: vi.fn(),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(
      async (input: {
        actorHumanId: string;
        requiredRoles: string[];
        allowWithoutSecondFactor?: boolean;
      }) => {
        const actor = staff[input.actorHumanId];
        const held = actor
          ? input.requiredRoles.filter((role) => actor.roles.includes(role))
          : [];
        if (held.length === 0) return { allowed: false };
        if (input.allowWithoutSecondFactor || actor!.enrolled) {
          return { allowed: true };
        }
        return { allowed: false, secondFactorRequired: true as const };
      },
    ),
  } as unknown as Ctx["authz"];
}

function callerFor(actorHumanId: string) {
  return createCaller(eventsRouter, {
    repos: buildRepos(),
    authz: buildAuthzPort(),
    actorHumanId,
  });
}

/** What the wire carries for a refusal: enough to tell two answers apart. */
async function refusal(run: Promise<unknown>) {
  const err = (await run.then(
    () => {
      throw new Error("expected the read to be refused");
    },
    (e: unknown) => e,
  )) as { code?: string; message?: string };
  return { code: err.code, message: err.message };
}

type Caller = ReturnType<typeof callerFor>["caller"];

/** Procedures that answer a hidden event with NOT_FOUND. */
const NOT_FOUND_READS: Array<{
  name: string;
  run: (caller: Caller) => Promise<unknown>;
  /** What the enrolled moderator gets. */
  moderatorAnswer: (run: Promise<unknown>) => Promise<void>;
}> = [
  {
    name: "resolveEventBySlug",
    run: (caller) => caller.resolveEventBySlug({ slug: SLUG }),
    moderatorAnswer: async (run) => {
      await expect(run).resolves.toEqual({
        eventId: EVENT_ID,
        currentSlug: SLUG,
        redirect: false,
      });
    },
  },
  {
    name: "getGateState",
    run: (caller) => caller.getGateState({ eventId: EVENT_ID }),
    moderatorAnswer: async (run) => {
      await expect(run).resolves.toMatchObject({
        eventId: EVENT_ID,
        gateType: "NONE",
      });
    },
  },
  {
    // The listing has no password gate, so a viewer who may read it is told
    // so; one who may not is told the event does not exist.
    name: "validatePassword",
    run: (caller) =>
      caller.validatePassword({ eventId: EVENT_ID, password: "anything" }),
    moderatorAnswer: async (run) => {
      const answer = await refusal(run);
      expect(answer.code).not.toBe("NOT_FOUND");
    },
  },
];

describe("events.* — a community moderator's read of a hidden COMMUNITY listing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(NOT_FOUND_READS)("$name", ({ run, moderatorAnswer }) => {
    it("answers a moderator with a second factor enrolled", async () => {
      const { caller, ctx } = callerFor(ENROLLED_MODERATOR);

      await moderatorAnswer(run(caller));
      // The default probe: no opt-out, so the port applies the second-factor rule.
      expect(ctx.authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ENROLLED_MODERATOR,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      });
    });

    it("gives a moderator with no second factor the stranger's not-found", async () => {
      const stranger = await refusal(run(callerFor(STRANGER).caller));
      const unenrolled = await refusal(
        run(callerFor(UNENROLLED_MODERATOR).caller),
      );

      expect(stranger.code).toBe("NOT_FOUND");
      expect(unenrolled).toEqual(stranger);
    });
  });

  // `getEventSeo` and `getPublicEventBody` check readability twice: the
  // procedure's own N3 check and gate check run for real here, and the use
  // case is stubbed, so what is asserted is that the procedure passes it the
  // probe as well.
  describe.each([
    {
      name: "getEventSeo" as const,
      stub: {
        id: EVENT_ID,
        slug: SLUG,
        title: "Hidden listing",
        startsAt: "2026-01-01T00:00:00.000Z",
        status: "DRAFT",
        attendanceMode: "RSVP",
        stewardship: "COMMUNITY",
        visibility: "PUBLIC",
        performers: [],
      },
    },
    {
      name: "getPublicEventBody" as const,
      stub: { eventId: EVENT_ID, body: null, imageMap: {} },
    },
  ])("$name", ({ name, stub }) => {
    it("answers a moderator with a second factor enrolled, and hands the use case the probe", async () => {
      const useCase = vi
        .spyOn(eventsUseCases, name)
        .mockResolvedValue(stub as never);
      const { caller, ctx } = callerFor(ENROLLED_MODERATOR);

      await expect(caller[name]({ slug: SLUG })).resolves.toBeDefined();
      expect(useCase).toHaveBeenCalledTimes(1);
      expect(useCase.mock.calls[0]![0]).toMatchObject({ authz: ctx.authz });
    });

    it("gives a moderator with no second factor the stranger's not-found, before the use case runs", async () => {
      const useCase = vi
        .spyOn(eventsUseCases, name)
        .mockResolvedValue(stub as never);

      const stranger = await refusal(
        callerFor(STRANGER).caller[name]({ slug: SLUG }),
      );
      const unenrolled = await refusal(
        callerFor(UNENROLLED_MODERATOR).caller[name]({ slug: SLUG }),
      );

      expect(stranger.code).toBe("NOT_FOUND");
      expect(unenrolled).toEqual(stranger);
      expect(useCase).not.toHaveBeenCalled();
    });
  });

  // An id the actor cannot read is left out, never refused, so the answer
  // cannot tell a hidden listing from an id that does not exist.
  describe("getCalendarInfo", () => {
    it("includes the listing for a moderator with a second factor enrolled", async () => {
      const { caller } = callerFor(ENROLLED_MODERATOR);

      await expect(
        caller.getCalendarInfo({ eventIds: [EVENT_ID] }),
      ).resolves.toMatchObject({ items: [{ eventId: EVENT_ID }] });
    });

    it.each([
      ["a moderator with no second factor", UNENROLLED_MODERATOR],
      ["a stranger", STRANGER],
    ])("leaves it out for %s", async (_label, actorHumanId) => {
      const { caller } = callerFor(actorHumanId);

      await expect(
        caller.getCalendarInfo({ eventIds: [EVENT_ID] }),
      ).resolves.toEqual({ items: [] });
    });
  });
});
