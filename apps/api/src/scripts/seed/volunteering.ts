import type { PrismaClient } from "@prisma/client";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createRoleTemplate } from "@th/core/use-cases/volunteering";
import { createFromTemplates } from "@th/core/use-cases/volunteering";
import { createVolunteerShiftBatch } from "@th/core/use-cases/volunteering";
import {
  submitVolunteerSignup,
  reviewVolunteerSignup,
  checkInVolunteer,
  withdrawVolunteerSignup,
} from "@th/core/use-cases/volunteering";
import {
  createVolunteerAsk,
  updateVolunteerAsk,
  addVolunteerAskRole,
  createVolunteerGroup,
  assignGroupCoordinator,
  assignSignupToGroup,
  setVolunteerReward,
  grantVolunteerReward,
} from "@th/core/use-cases/volunteering";
import type {
  NotifyInput,
  NotifyOutput,
} from "@th/core/use-cases/comms/notify";
import type { MailerPort } from "@th/ports/comms/mailer";

import { DEMO_IDS } from "./ids.js";
import { BUYER_FIXTURES } from "./fixtures.js";
import { createInMemoryIdempotency } from "./utils.js";

type SeedEvent = { id: string; slug: string; title: string; startsAt: string };

const noopNotify = async (_input: NotifyInput): Promise<NotifyOutput> =>
  ({}) as NotifyOutput;

const ROLE_TEMPLATES = [
  {
    name: "Bar Staff",
    description: "Serve drinks and manage bar area",
    defaultCapacity: 8,
  },
  {
    name: "Security",
    description: "Crowd safety and access control",
    defaultCapacity: 6,
  },
  {
    name: "Stage Hand",
    description: "Stage setup, equipment, and teardown",
    defaultCapacity: 4,
  },
  {
    name: "Door / Check-in",
    description: "Ticket scanning and guest check-in",
    defaultCapacity: 4,
  },
] as const;

const VOLUNTEER_EVENTS: Array<{
  titleMatch: string;
  autoApprove: boolean;
  introText: string;
  roleNames: string[];
  includesTeardown: boolean;
  seedSignups: boolean;
}> = [
  {
    titleMatch: "SOMA Warehouse Rave",
    autoApprove: true,
    introText:
      "Help us throw the best warehouse rave in SOMA! Volunteers get free entry, a drink token, and our eternal gratitude.",
    roleNames: ["Bar Staff", "Security", "Stage Hand", "Door / Check-in"],
    includesTeardown: true,
    seedSignups: true,
  },
  {
    titleMatch: "Greek Theatre Under the Stars",
    autoApprove: false,
    introText:
      "Join our volunteer crew for a magical night under the stars at the Greek Theatre. All volunteers receive complimentary admission and a meal voucher.",
    roleNames: ["Bar Staff", "Security", "Stage Hand"],
    includesTeardown: false,
    seedSignups: false,
  },
];

export const seedVolunteering = async (
  prisma: PrismaClient,
  seededEvents: SeedEvent[],
) => {
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const baseDeps = { repos, clock };
  // Seed runs as a trusted local script — stub hasStaffRole to always allow.
  const stubAuthz = { hasStaffRole: async () => ({ allowed: true }) };
  const signupDeps = {
    repos,
    authz: stubAuthz,
    clock,
    notify: noopNotify,
    appBaseUrl: "http://localhost:3000",
  };

  const actorHumanId = DEMO_IDS.human3; // Jamie Chen, owner of org3

  // ── 1. Org-level role templates for org3 ─────────────────────────────────
  console.log("  Creating volunteer role templates for org3...");

  const templates: Array<{ id: string; name: string }> = [];
  for (const [i, tpl] of ROLE_TEMPLATES.entries()) {
    const existing = await prisma.volunteerRoleTemplate.findUnique({
      where: { orgId_name: { orgId: DEMO_IDS.org3, name: tpl.name } },
      select: { id: true },
    });
    if (existing) {
      templates.push({ id: existing.id, name: tpl.name });
      continue;
    }
    const record = await createRoleTemplate(baseDeps, {
      actorHumanId,
      orgId: DEMO_IDS.org3,
      name: tpl.name,
      description: tpl.description,
      defaultCapacity: tpl.defaultCapacity,
    });
    templates.push({ id: record.id, name: record.name });
  }
  console.log(`    ${templates.length} templates ready`);

  // ── 2. Enable volunteering + create roles/shifts per event ───────────────
  for (const config of VOLUNTEER_EVENTS) {
    const event = seededEvents.find((e) => e.title.includes(config.titleMatch));
    if (!event) {
      console.warn(
        `    Skipping "${config.titleMatch}" — not found in seeded events`,
      );
      continue;
    }

    console.log(`  Enabling volunteering on "${event.title}"...`);

    // Flip the event-level volunteering flags
    await prisma.event.update({
      where: { id: event.id },
      data: {
        volunteeringEnabled: true,
        volunteerAutoApprove: config.autoApprove,
        volunteerIntroText: config.introText,
      },
    });

    // Pull roles from templates
    const templateIds = config.roleNames
      .map((name) => templates.find((t) => t.name === name)?.id)
      .filter((id): id is string => !!id);

    const result = await createFromTemplates(baseDeps, {
      actorHumanId,
      eventId: event.id,
      templateIds,
    });
    const roles = result.roles;
    console.log(`    ${roles.length} roles created`);

    // Create shifts per role based on event timing
    const eventStart = new Date(event.startsAt);
    const eventEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000); // ~4h events

    for (const role of roles) {
      const shifts: Array<{
        label: string;
        startsAt: Date;
        endsAt: Date;
        capacity: number;
        notes?: string;
      }> = [
        {
          label: "Setup",
          startsAt: new Date(eventStart.getTime() - 2 * 60 * 60 * 1000),
          endsAt: eventStart,
          capacity: Math.ceil((role.capacity ?? 4) / 2),
          notes: "Meet at loading dock. Wear closed-toe shoes.",
        },
        {
          label: "During Event",
          startsAt: eventStart,
          endsAt: eventEnd,
          capacity: role.capacity ?? 4,
        },
      ];

      if (config.includesTeardown) {
        shifts.push({
          label: "Teardown",
          startsAt: eventEnd,
          endsAt: new Date(eventEnd.getTime() + 2 * 60 * 60 * 1000),
          capacity: Math.ceil((role.capacity ?? 4) / 2),
          notes: "Help break down and clean up. Pizza provided!",
        });
      }

      await createVolunteerShiftBatch(baseDeps, {
        actorHumanId,
        roleId: role.id,
        shifts,
      });
    }
    console.log(`    Shifts created for all roles`);

    // ── 3. Demo signups ───────────────────────────────────────────────────
    const duringShifts = await prisma.eventVolunteerShift.findMany({
      where: { role: { eventId: event.id }, label: "During Event" },
      select: { id: true, roleId: true },
    });

    const signupScenarios: Array<{
      buyerIdx: number;
      shiftIdx: number;
      action: "pending" | "approved" | "rejected" | "withdrawn" | "checked-in";
    }> = [
      { buyerIdx: 0, shiftIdx: 0, action: "approved" },
      { buyerIdx: 1, shiftIdx: 0, action: "checked-in" },
      { buyerIdx: 2, shiftIdx: 1 % duringShifts.length, action: "pending" },
      { buyerIdx: 3, shiftIdx: 1 % duringShifts.length, action: "approved" },
      { buyerIdx: 4, shiftIdx: 2 % duringShifts.length, action: "rejected" },
      { buyerIdx: 5, shiftIdx: 2 % duringShifts.length, action: "pending" },
      { buyerIdx: 6, shiftIdx: 0, action: "withdrawn" },
    ];

    // Only seed signups for events that opt in
    if (!config.seedSignups) continue;

    let signupCount = 0;
    for (const scenario of signupScenarios) {
      const buyer = BUYER_FIXTURES[scenario.buyerIdx];
      if (!buyer) continue;
      const shift = duringShifts[scenario.shiftIdx];
      if (!shift) continue;

      // Check for existing signup (idempotent re-runs)
      const existing = await prisma.volunteerSignup.findUnique({
        where: {
          eventId_roleId_contactEmail: {
            eventId: event.id,
            roleId: shift.roleId,
            contactEmail: buyer.email,
          },
        },
      });
      if (existing) {
        signupCount++;
        continue;
      }

      const signup = await submitVolunteerSignup(signupDeps, {
        eventId: event.id,
        roleId: shift.roleId,
        shiftId: shift.id,
        contactEmail: buyer.email,
        contactName: buyer.name,
      });

      // When autoApprove is on, submitVolunteerSignup already sets status to APPROVED.
      // Only call reviewVolunteerSignup when the signup is still PENDING.
      const alreadyApproved = signup.status === "APPROVED";

      if (scenario.action === "approved" || scenario.action === "checked-in") {
        if (!alreadyApproved) {
          await reviewVolunteerSignup(signupDeps, {
            actorHumanId,
            signupId: signup.id,
            decision: "APPROVED",
          });
        }
        if (scenario.action === "checked-in") {
          await checkInVolunteer(signupDeps, {
            actorHumanId,
            signupId: signup.id,
          });
        }
      } else if (scenario.action === "rejected") {
        if (!alreadyApproved) {
          await reviewVolunteerSignup(signupDeps, {
            actorHumanId,
            signupId: signup.id,
            decision: "REJECTED",
            notes: "Sorry, this shift is fully staffed.",
          });
        }
      }
      // "pending" = no further action, "withdrawn" handled below

      signupCount++;
    }

    // Handle withdrawn signup separately (submit then withdraw)
    const withdrawnBuyer = BUYER_FIXTURES[6];
    if (withdrawnBuyer && duringShifts[0]) {
      const ws = await prisma.volunteerSignup.findUnique({
        where: {
          eventId_roleId_contactEmail: {
            eventId: event.id,
            roleId: duringShifts[0].roleId,
            contactEmail: withdrawnBuyer.email,
          },
        },
        select: { id: true, status: true, humanId: true },
      });
      if (
        ws &&
        (ws.status === "PENDING" || ws.status === "APPROVED") &&
        ws.humanId
      ) {
        await withdrawVolunteerSignup(signupDeps, {
          actorHumanId: ws.humanId,
          signupId: ws.id,
        });
      }
    }

    console.log(`    ${signupCount} demo signups created`);
  }

  // ── 4. Generic volunteer asks + comp reward ────────────────────────────────
  // Exercises the NEW ask/group/coordinator/reward surfaces (b53f1b86):
  // a standing ORG-subject ask with roles, a group + non-admin coordinator,
  // a mix of signups (pool + grouped + pending), and an EVENT comp reward.
  await seedVolunteerAsksAndComp({
    prisma,
    repos,
    baseDeps,
    signupDeps,
    seededEvents,
    actorHumanId,
  });
};

// ── Generic asks + comp reward slice ─────────────────────────────────────────
// Kept as a dedicated function (invoked from seedVolunteering above) so the
// new-surface seed is easy to find and idempotent-guarded independently of the
// legacy event-role/shift/signup flow. All writes go through the real use cases
// exactly like the rest of this module.

type BaseDeps = { repos: ReturnType<typeof createPrismaRepos>; clock: ReturnType<typeof createSystemClock> };

const seedVolunteerAsksAndComp = async (args: {
  prisma: PrismaClient;
  repos: ReturnType<typeof createPrismaRepos>;
  baseDeps: BaseDeps;
  // Reused from seedVolunteering — carries repos/authz/clock/notify/appBaseUrl.
  signupDeps: {
    repos: ReturnType<typeof createPrismaRepos>;
    authz: { hasStaffRole: () => Promise<{ allowed: boolean }> };
    clock: ReturnType<typeof createSystemClock>;
    notify: (input: NotifyInput) => Promise<NotifyOutput>;
    appBaseUrl: string;
  };
  seededEvents: SeedEvent[];
  actorHumanId: string;
}) => {
  const { prisma, repos, baseDeps, signupDeps, seededEvents, actorHumanId } =
    args;

  // The org owner (Jamie Chen / org3) acts as ask owner AND finance actor for
  // the comp reward — OWNER satisfies both resolveAskOwnership and
  // ORG_FINANCE_ROLES. The coordinator is a plain org member (NOT an admin),
  // so the coordinator console is exercisable without org-wide rights.
  const ORG_ID = DEMO_IDS.org3;
  const COORDINATOR_HUMAN_ID = DEMO_IDS.human4; // Sam Okonkwo — member, not admin

  console.log("  Seeding generic volunteer ask (ORG street team)...");

  // ── 1. Standing ORG-subject ask (idempotent: ORG asks have no unique) ──────
  const ORG_ASK_TITLE = "Venue street team";
  const existingOrgAsks = await repos.volunteering.listAsksBySubject(
    "ORG",
    ORG_ID,
  );
  const existingOrgAsk = existingOrgAsks.find((a) => a.title === ORG_ASK_TITLE);

  let orgAskId: string;
  if (existingOrgAsk) {
    orgAskId = existingOrgAsk.id;
  } else {
    const created = await createVolunteerAsk(baseDeps, {
      actorHumanId,
      subjectType: "ORG",
      subjectId: ORG_ID,
      title: ORG_ASK_TITLE,
      description:
        "Ongoing street-team crew for our shows — flyering, postering, and door help across the season. Sign up once, help when you can.",
      cadence: "ONGOING",
    });
    orgAskId = created.askId;
  }

  // Publish it (DRAFT → OPEN). Idempotent: updateVolunteerAsk is a no-op
  // transition-wise when already OPEN.
  await updateVolunteerAsk(baseDeps, {
    actorHumanId,
    askId: orgAskId,
    status: "OPEN",
  });

  // ── 2. Roles (check-then-create to tolerate re-runs) ───────────────────────
  const ORG_ASK_ROLES: Array<{
    name: string;
    description: string;
    defaultHours?: number;
  }> = [
    {
      name: "Flyering",
      description: "Hand out flyers at partner venues and busy corners.",
      defaultHours: 2,
    },
    {
      name: "Door greeter",
      description: "Welcome guests and point them to will-call.",
    },
  ];

  const existingRoles = await prisma.eventVolunteerRole.findMany({
    where: { askId: orgAskId },
    select: { id: true, name: true },
  });
  const roleIdByName = new Map(existingRoles.map((r) => [r.name, r.id]));

  for (const roleDef of ORG_ASK_ROLES) {
    if (roleIdByName.has(roleDef.name)) continue;
    const role = await addVolunteerAskRole(baseDeps, {
      actorHumanId,
      askId: orgAskId,
      name: roleDef.name,
      description: roleDef.description,
      ...(roleDef.defaultHours !== undefined
        ? { defaultHours: roleDef.defaultHours }
        : {}),
    });
    roleIdByName.set(role.name, role.id);
  }

  const flyeringRoleId = roleIdByName.get("Flyering");
  const doorRoleId = roleIdByName.get("Door greeter");
  console.log(`    ORG ask OPEN with ${roleIdByName.size} roles`);

  // ── 3. Group + non-admin coordinator (idempotent) ──────────────────────────
  const GROUP_NAME = "Saturday crew";
  let groupId: string;
  const existingGroup = await prisma.volunteerGroup.findFirst({
    where: { askId: orgAskId, name: GROUP_NAME },
    select: { id: true },
  });
  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    const group = await createVolunteerGroup(baseDeps, {
      actorHumanId,
      askId: orgAskId,
      name: GROUP_NAME,
      description: "Weekend regulars who cover Saturday shows.",
    });
    groupId = group.groupId;
  }

  // assignGroupCoordinator is idempotent (same coordinator = no-op, no re-send).
  await assignGroupCoordinator(signupDeps, {
    actorHumanId,
    groupId,
    coordinatorHumanId: COORDINATOR_HUMAN_ID,
  });
  console.log(`    Group "${GROUP_NAME}" + coordinator assigned`);

  // ── 4. Signups: pool + grouped + pending ───────────────────────────────────
  // submitVolunteerSignup (ask-path) is idempotent on (askId, roleId, email):
  // a re-run returns the existing signup, so we only review PENDING ones.
  const signupPlan: Array<{
    buyerIdx: number;
    roleId: string | undefined;
    approve: boolean;
    toGroup: boolean;
  }> = [
    { buyerIdx: 0, roleId: flyeringRoleId, approve: true, toGroup: true },
    { buyerIdx: 1, roleId: flyeringRoleId, approve: true, toGroup: false }, // stays in pool
    { buyerIdx: 2, roleId: doorRoleId, approve: true, toGroup: true },
    { buyerIdx: 3, roleId: doorRoleId, approve: false, toGroup: false }, // stays pending
  ];

  let askSignupCount = 0;
  for (const plan of signupPlan) {
    const buyer = BUYER_FIXTURES[plan.buyerIdx];
    if (!buyer || !plan.roleId) continue;

    const signup = await submitVolunteerSignup(signupDeps, {
      askId: orgAskId,
      roleId: plan.roleId,
      contactEmail: buyer.email,
      contactName: buyer.name,
    });
    askSignupCount++;

    if (plan.approve && signup.status === "PENDING") {
      await reviewVolunteerSignup(signupDeps, {
        actorHumanId,
        signupId: signup.id,
        decision: "APPROVED",
      });
    }

    // Owner assigns approved signups into the Saturday crew; assignSignupToGroup
    // is an idempotent no-op when already in the target group.
    if (plan.toGroup) {
      await assignSignupToGroup(signupDeps, {
        actorHumanId,
        signupId: signup.id,
        groupId,
      });
    }
  }
  console.log(
    `    ${askSignupCount} ask signups (1 pending, 1 pool, 2 grouped)`,
  );

  // ── 5. Event comp reward (ON_CHECK_IN) ─────────────────────────────────────
  // SOMA Warehouse Rave has volunteering enabled + ticket types + checked-in
  // volunteers (seeded above), so its EVENT-subject ask exists lazily and an
  // ON_CHECK_IN comp will actually grant, populating the reward ledger.
  const rewardEvent = seededEvents.find((e) =>
    e.title.includes("SOMA Warehouse Rave"),
  );
  if (!rewardEvent) {
    console.warn("    Skipping comp reward — SOMA event not found");
    return;
  }

  const eventAsks = await repos.volunteering.listAsksBySubject(
    "EVENT",
    rewardEvent.id,
  );
  const eventAsk = eventAsks[0];
  if (!eventAsk) {
    console.warn(
      "    Skipping comp reward — SOMA has no EVENT ask (no volunteer signups?)",
    );
    return;
  }

  const ticketTypes = await repos.events.listTicketTypes(rewardEvent.id);
  const compTicketType = ticketTypes[0];
  if (!compTicketType) {
    console.warn("    Skipping comp reward — SOMA has no ticket types");
    return;
  }

  const reward = await setVolunteerReward(baseDeps, {
    actorHumanId,
    askId: eventAsk.id,
    ticketTypeId: compTicketType.id,
    trigger: "ON_CHECK_IN",
    maxGrants: 20,
  });
  console.log(
    `    Comp reward set on SOMA (ON_CHECK_IN → "${compTicketType.name}", max 20)`,
  );

  // ── 6. Issue exactly ONE granted comp so the ledger + "Void comp" button ───
  // are exercisable locally. Grant against a SOMA event volunteer that already
  // reached the ON_CHECK_IN trigger (a CHECKED_IN signup on the same EVENT ask).
  // We fire the real `grantVolunteerReward` use case with a NO-OP mailer so no
  // comp email is sent during seeding, and an in-memory idempotency adapter.
  // Left GRANTED (never voided) so the Void button has a live target →
  // ledger reads granted=1, used=0, voided=0, remaining=19.
  const checkedInSignup = await prisma.volunteerSignup.findFirst({
    where: { askId: eventAsk.id, status: "CHECKED_IN" },
    orderBy: { createdAt: "asc" },
    select: { id: true, humanId: true, contactEmail: true },
  });

  if (!checkedInSignup) {
    console.warn(
      "    Skipping comp grant — no CHECKED_IN SOMA volunteer signup found",
    );
    return;
  }

  // No-op mailer — mirrors `noopMailer` in transport/trpc volunteer router so
  // the comp mint proceeds without firing a real email. grantVolunteerReward's
  // send is post-commit and error-swallowed, so this never blocks the grant.
  const seedNoopMailer: MailerPort = {
    async send() {
      return {
        result: {
          success: false,
          errorCode: "dependency_failed",
          errorMessage: "seed_noop_mailer",
        },
      };
    },
    async sendBatch() {
      return { results: [], okCount: 0, errorCount: 0 };
    },
    async health() {
      return { ok: false, message: "seed_noop_mailer" };
    },
  };

  const grantResult = await grantVolunteerReward(
    {
      repos,
      clock: baseDeps.clock,
      idempotency: createInMemoryIdempotency(),
      mailer: seedNoopMailer,
      publicAppUrl: signupDeps.appBaseUrl,
      supportUrl: `${signupDeps.appBaseUrl}/support`,
    },
    {
      signupId: checkedInSignup.id,
      rewardId: reward.rewardId,
      trigger: "ON_CHECK_IN",
    },
  );

  const recipient =
    checkedInSignup.humanId ?? checkedInSignup.contactEmail ?? "unknown";
  console.log(
    `    Comp GRANTED to ${recipient} (grantId=${grantResult.grantId ?? "—"}${
      grantResult.skipped ? `, ${grantResult.skipped}` : ""
    })`,
  );
};
