import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeVolunteeringRepo } from "../volunteering";

// volunteer-ask-reminders: the event-start and ask-start candidate reads.
// Real Postgres, because the rules are relation filters (signup → event,
// signup → ask) plus the withheld-owner set.

const BANNED = "10000000-0000-4000-8000-000000000001";
const OWNER = "10000000-0000-4000-8000-000000000002";
const BANNED_ORG = "11000000-0000-4000-8000-000000000001";
const LIVE_ORG = "11000000-0000-4000-8000-000000000002";
const PLACE = "12000000-0000-4000-8000-000000000001";

const START = new Date("2026-10-20T18:00:00.000Z");
const WINDOW = {
  kind: "REMINDER_24H" as const,
  windowStart: new Date("2026-10-20T17:30:00.000Z"),
  windowEnd: new Date("2026-10-20T18:30:00.000Z"),
};

const EVENTS = {
  live: "30000000-0000-4000-8000-000000000001",
  cancelled: "30000000-0000-4000-8000-000000000002",
  banned: "30000000-0000-4000-8000-000000000003",
  later: "30000000-0000-4000-8000-000000000004",
} as const;

type AskSeed = {
  id: string;
  subjectType: "PLACE" | "ORG" | "HUMAN" | "EVENT";
  subjectId: string;
  status?: "DRAFT" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED";
  cadence?: "ONE_TIME" | "ONGOING" | "RECURRING";
  startsAt?: Date | null;
  timezone?: string | null;
};

const ASKS = {
  open: {
    id: "40000000-0000-4000-8000-000000000001",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    timezone: "America/New_York",
  },
  paused: {
    id: "40000000-0000-4000-8000-000000000002",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    status: "PAUSED",
  },
  closed: {
    id: "40000000-0000-4000-8000-000000000003",
    subjectType: "HUMAN",
    subjectId: OWNER,
    status: "CLOSED",
  },
  placeNoZone: {
    id: "40000000-0000-4000-8000-000000000004",
    subjectType: "PLACE",
    subjectId: PLACE,
    timezone: null,
  },
  draft: {
    id: "40000000-0000-4000-8000-000000000011",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    status: "DRAFT",
  },
  archived: {
    id: "40000000-0000-4000-8000-000000000012",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    status: "ARCHIVED",
  },
  ongoing: {
    id: "40000000-0000-4000-8000-000000000013",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    cadence: "ONGOING",
  },
  recurring: {
    id: "40000000-0000-4000-8000-000000000014",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    cadence: "RECURRING",
  },
  noStart: {
    id: "40000000-0000-4000-8000-000000000015",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    startsAt: null,
  },
  eventSubject: {
    id: "40000000-0000-4000-8000-000000000016",
    subjectType: "EVENT",
    subjectId: EVENTS.live,
  },
  bannedOrg: {
    id: "40000000-0000-4000-8000-000000000017",
    subjectType: "ORG",
    subjectId: BANNED_ORG,
  },
  bannedHuman: {
    id: "40000000-0000-4000-8000-000000000018",
    subjectType: "HUMAN",
    subjectId: BANNED,
  },
  outOfWindow: {
    id: "40000000-0000-4000-8000-000000000019",
    subjectType: "ORG",
    subjectId: LIVE_ORG,
    startsAt: new Date("2026-10-21T18:00:00.000Z"),
  },
} satisfies Record<string, AskSeed>;

const REMINDABLE = [ASKS.open, ASKS.paused, ASKS.closed, ASKS.placeNoZone];

describe("volunteer start-reminder candidates (real Postgres)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    await prisma.human.create({
      data: { id: BANNED, name: "Banned", status: "BANNED" },
    });
    await prisma.human.create({ data: { id: OWNER, name: "Owner" } });
    await prisma.organization.create({
      data: { id: BANNED_ORG, name: "Banned org", slug: "banned-org" },
    });
    await prisma.organization.create({
      data: { id: LIVE_ORG, name: "Live org", slug: "live-org" },
    });
    // The banned org's sole OWNER is banned: the org is withheld.
    await prisma.orgMember.create({
      data: { orgId: BANNED_ORG, humanId: BANNED, role: "OWNER" },
    });
    await prisma.orgMember.create({
      data: { orgId: LIVE_ORG, humanId: OWNER, role: "OWNER" },
    });
    await prisma.place.create({
      data: {
        id: PLACE,
        name: "The Hall",
        address: "1 Main St",
        timezone: "America/Denver",
      },
    });

    // ── Events: on each, a role WITH a shift (a shift signup and a
    // role-level signup without one) and a role with NO shifts (one
    // shiftless signup, the only kind the event's start anchors) ─────────
    const eventSeeds = [
      { id: EVENTS.live, status: "PUBLISHED", startsAt: START },
      { id: EVENTS.cancelled, status: "CANCELLED", startsAt: START },
      {
        id: EVENTS.banned,
        status: "PUBLISHED",
        startsAt: START,
        humanId: BANNED,
      },
      {
        id: EVENTS.later,
        status: "PUBLISHED",
        startsAt: new Date("2026-10-21T18:00:00.000Z"),
      },
    ] as const;
    for (const ev of eventSeeds) {
      await prisma.event.create({
        data: {
          id: ev.id,
          title: `Event ${ev.id.slice(-1)}`,
          status: ev.status,
          publishedAt: new Date(),
          visibility: "PUBLIC",
          countryCode: "US",
          startsAt: ev.startsAt,
          endsAt: new Date(ev.startsAt.getTime() + 3600_000),
          timezone: "America/Chicago",
          ...("humanId" in ev ? { humanId: ev.humanId } : {}),
        },
      });
      const role = await prisma.eventVolunteerRole.create({
        data: { eventId: ev.id, name: "Door" },
      });
      const shift = await prisma.eventVolunteerShift.create({
        data: {
          roleId: role.id,
          startsAt: ev.startsAt,
          endsAt: new Date(ev.startsAt.getTime() + 3600_000),
        },
      });
      // Role-level signup on a role that has shifts: no anchor.
      const roleLevel = await prisma.volunteerSignup.create({
        data: {
          eventId: ev.id,
          roleId: role.id,
          contactEmail: `role-level-${ev.id}@test.dev`,
          status: "APPROVED",
        },
      });
      ids[`role-level:${ev.id}`] = roleLevel.id;
      const shiftlessRole = await prisma.eventVolunteerRole.create({
        data: { eventId: ev.id, name: "Bar" },
      });
      const shiftless = await prisma.volunteerSignup.create({
        data: {
          eventId: ev.id,
          roleId: shiftlessRole.id,
          contactEmail: `shiftless-${ev.id}@test.dev`,
          status: "APPROVED",
        },
      });
      ids[`shiftless:${ev.id}`] = shiftless.id;
      await prisma.volunteerSignup.create({
        data: {
          eventId: ev.id,
          roleId: role.id,
          shiftId: shift.id,
          contactEmail: `shift-${ev.id}@test.dev`,
          status: "APPROVED",
        },
      });
      if (ev.id === EVENTS.live) {
        await prisma.volunteerSignup.create({
          data: {
            eventId: ev.id,
            roleId: shiftlessRole.id,
            contactEmail: `pending-${ev.id}@test.dev`,
            status: "PENDING",
          },
        });

        // A deleted shift on a role that keeps another: `shiftId` is SET
        // NULL, and the role still has shifts, so no anchor.
        const setup = await prisma.eventVolunteerRole.create({
          data: { eventId: ev.id, name: "Setup" },
        });
        const [gone] = await Promise.all(
          [0, 1].map((h) =>
            prisma.eventVolunteerShift.create({
              data: {
                roleId: setup.id,
                startsAt: new Date(ev.startsAt.getTime() - (h + 1) * 3600_000),
                endsAt: ev.startsAt,
              },
            }),
          ),
        );
        const orphaned = await prisma.volunteerSignup.create({
          data: {
            eventId: ev.id,
            roleId: setup.id,
            shiftId: gone!.id,
            contactEmail: `deleted-shift-${ev.id}@test.dev`,
            status: "APPROVED",
          },
        });
        ids["deleted-shift"] = orphaned.id;
        await prisma.eventVolunteerShift.delete({ where: { id: gone!.id } });

        // The role's ONLY shift deleted: the role now has no shifts at all.
        const teardown = await prisma.eventVolunteerRole.create({
          data: { eventId: ev.id, name: "Teardown" },
        });
        const only = await prisma.eventVolunteerShift.create({
          data: {
            roleId: teardown.id,
            startsAt: ev.startsAt,
            endsAt: new Date(ev.startsAt.getTime() + 3600_000),
          },
        });
        const lastShift = await prisma.volunteerSignup.create({
          data: {
            eventId: ev.id,
            roleId: teardown.id,
            shiftId: only.id,
            contactEmail: `only-shift-deleted-${ev.id}@test.dev`,
            status: "APPROVED",
          },
        });
        ids["only-shift-deleted"] = lastShift.id;
        await prisma.eventVolunteerShift.delete({ where: { id: only.id } });
      }
    }

    // ── Asks: one APPROVED signup each on an ask-owned role ──────────────
    for (const [name, ask] of Object.entries(ASKS) as [string, AskSeed][]) {
      await prisma.volunteerAsk.create({
        data: {
          id: ask.id,
          subjectType: ask.subjectType,
          subjectId: ask.subjectId,
          title: `Ask ${name}`,
          status: ask.status ?? "OPEN",
          cadence: ask.cadence ?? "ONE_TIME",
          startsAt: ask.startsAt === undefined ? START : ask.startsAt,
          endsAt: null,
          timezone:
            ask.timezone === undefined ? "America/Chicago" : ask.timezone,
        },
      });
      const role = await prisma.eventVolunteerRole.create({
        data: { askId: ask.id, name: "Helper" },
      });
      const signup = await prisma.volunteerSignup.create({
        data: {
          askId: ask.id,
          roleId: role.id,
          contactEmail: `${name}@test.dev`,
          contactPhone: "+16155550100",
          smsOptIn: true,
          status: "APPROVED",
        },
      });
      ids[`ask:${ask.id}`] = signup.id;
    }
    // A PENDING signup on a remindable ask is never a candidate.
    const openRole = await prisma.eventVolunteerRole.findFirstOrThrow({
      where: { askId: ASKS.open.id },
    });
    await prisma.volunteerSignup.create({
      data: {
        askId: ASKS.open.id,
        roleId: openRole.id,
        contactEmail: "pending-ask@test.dev",
        status: "PENDING",
      },
    });
    // One ledger row already written for the open ask's signup.
    await prisma.volunteerShiftNotification.create({
      data: {
        signupId: ids[`ask:${ASKS.open.id}`]!,
        kind: "REMINDER_24H",
        channel: "email",
      },
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("event start: only APPROVED signups on a role with no shifts, of a live, un-withheld event starting in the window", async () => {
    const rows =
      await makeVolunteeringRepo(prisma).findEventStartReminderCandidates(
        WINDOW,
      );
    const got = rows.map((r) => r.signupId);
    // Not: the shift signup (its shift is its anchor), the PENDING one, the
    // cancelled event, the banned owner's event, the event starting later.
    expect(got).toContain(ids[`shiftless:${EVENTS.live}`]);
    expect(
      rows.find((r) => r.signupId === ids[`shiftless:${EVENTS.live}`]),
    ).toMatchObject({
      eventId: EVENTS.live,
      eventStartsAt: START,
      eventTimezone: "America/Chicago",
      roleName: "Bar",
      alreadySent: [],
    });
    expect(rows.every((r) => r.eventId === EVENTS.live)).toBe(true);
  });

  it("a role-level signup on a role WITH shifts gets no event-start reminder", async () => {
    const rows =
      await makeVolunteeringRepo(prisma).findEventStartReminderCandidates(
        WINDOW,
      );
    expect(rows.map((r) => r.signupId)).not.toContain(
      ids[`role-level:${EVENTS.live}`],
    );
  });

  it("a signup whose shift was deleted, on a role that keeps a shift, gets nothing", async () => {
    const repo = makeVolunteeringRepo(prisma);
    const orphan = await prisma.volunteerSignup.findUniqueOrThrow({
      where: { id: ids["deleted-shift"]! },
    });
    expect(orphan.shiftId).toBeNull();
    expect(
      (await repo.findEventStartReminderCandidates(WINDOW)).map(
        (r) => r.signupId,
      ),
    ).not.toContain(ids["deleted-shift"]);
    expect(
      (await repo.findShiftsNeedingReminder(WINDOW)).map((r) => r.signupId),
    ).not.toContain(ids["deleted-shift"]);
  });

  it("PINNED EDGE: a role whose ONLY shift was deleted is a role with no shifts, so its signup is reminded by the event's start", async () => {
    // No column records that the signup once had a shift; the role now
    // reads exactly like a shiftless role (R7).
    const rows =
      await makeVolunteeringRepo(prisma).findEventStartReminderCandidates(
        WINDOW,
      );
    expect(rows.map((r) => r.signupId).sort()).toEqual(
      [ids[`shiftless:${EVENTS.live}`], ids["only-shift-deleted"]].sort(),
    );
  });

  it("ask start: ONE_TIME non-EVENT asks that are OPEN, PAUSED or CLOSED, owner not withheld, starting in the window", async () => {
    const rows =
      await makeVolunteeringRepo(prisma).findAskStartReminderCandidates(WINDOW);

    expect(rows.map((r) => r.askId).sort()).toEqual(
      REMINDABLE.map((a) => a.id).sort(),
    );
    const open = rows.find((r) => r.askId === ASKS.open.id)!;
    expect(open).toMatchObject({
      signupId: ids[`ask:${ASKS.open.id}`],
      askTitle: "Ask open",
      askSubjectType: "ORG",
      askCadence: "ONE_TIME",
      askStartsAt: START,
      askEndsAt: null,
      askTimezone: "America/New_York",
      contactPhone: "+16155550100",
      smsOptIn: true,
      roleName: "Helper",
      alreadySent: ["email"],
    });
  });

  it("an ask with no zone of its own renders in its place's zone", async () => {
    const rows =
      await makeVolunteeringRepo(prisma).findAskStartReminderCandidates(WINDOW);
    expect(rows.find((r) => r.askId === ASKS.placeNoZone.id)?.askTimezone).toBe(
      "America/Denver",
    );
  });

  it("findAskIdsStillRemindable keeps only the remindable asks", async () => {
    const repo = makeVolunteeringRepo(prisma);
    const all = Object.values(ASKS).map((a) => a.id);
    expect((await repo.findAskIdsStillRemindable(all)).sort()).toEqual(
      // The out-of-window ask is still remindable; the window is the read's.
      [...REMINDABLE.map((a) => a.id), ASKS.outOfWindow.id].sort(),
    );
    expect(await repo.findAskIdsStillRemindable([])).toEqual([]);
  });

  it("the shift read still returns only shift signups", async () => {
    const rows =
      await makeVolunteeringRepo(prisma).findShiftsNeedingReminder(WINDOW);
    expect(rows.map((r) => r.eventId)).toEqual([EVENTS.live]);
  });
});
