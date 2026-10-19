/**
 * QA seed: the invite complaint auto-pause (W4) end to end, for a hand
 * click-through.
 *
 * Builds three organisers whose personal invites are paused:
 *   A. "Invite Pause QA Presents" (org): paused by COMPLAINT_COUNT, review
 *      NOT requested, so the owner can press "Ask for a review" themselves.
 *   B. "Invite Pause QA Waiting" (org): paused by COMPLAINT_COUNT, review
 *      requested with a note, so it shows under "Waiting for review".
 *   P. "Invite Pause QA Person" (person-owned event): paused by
 *      COMPLAINT_RATE, review not requested. The staff queue links people to
 *      /platform/humans?q=<name>.
 *
 * Each org's Organization.slug (the /admin key) DIFFERS from its ORGANIZATION
 * EntityPage.slug (the /orgs key), so a staff-queue link built from the wrong
 * one 404s visibly.
 *
 * Domain writes go through the REAL use cases:
 *   - complaints: core `recordInviteComplaint` (the Resend webhook's use case)
 *     with the same metadata the invite email carries, so the pause, the
 *     opt-out, the audit row and the in-app notice are what production makes;
 *   - org B's review request: core `requestInvitePauseReview`.
 * Fixture rows (humans, logins, orgs, pages, events, sent invites) are
 * written with Prisma, in the shapes the seed and the invite feature write.
 *
 * Why each org also has a "last month's show" with 200 sent invites: the trip
 * rule pauses when complaints*100 > recipients. With only the 5 guests of the
 * main event, the FIRST complaint would already pause by COMPLAINT_RATE.
 * COMPLAINT_COUNT (3 distinct complainants) is only reachable when the first
 * two complaints stay under 1%, i.e. 200+ recipients in the window.
 *
 * Idempotent: every row it owns has a fixed id. A re-run deletes ONLY this
 * scenario's pauses, complaints, opt-outs, invites, unlocks, notifications
 * and invite-pause audit rows (keyed by those ids), then rebuilds them. It
 * never touches anything else.
 *
 * LOCAL DEV ONLY. Before any write it checks (see `assertLocalDatabase` and
 * `assertSameClusterAsIpv6Loopback`):
 *   - DATABASE_URL's hostname, which is what getPrisma connects to, is
 *     localhost / 127.0.0.1 / ::1. getPrisma IGNORES a `?host=` param and an
 *     empty hostname makes pg fall back to PGHOST, so a `host` param is
 *     refused outright and a non-local PGHOST is refused too;
 *   - the cluster that connection reaches is the one listening on ::1, where
 *     the real dev DB lives. 127.0.0.1:5432 can be a lima CI Postgres, and
 *     `localhost` can reach either loopback. So before connecting, the script
 *     pins `localhost` to ::1 for every connection (IPv6 first, no
 *     IPv4 fallback); the check then confirms the pinned target.
 * It prints the host:port it connects to and the server address it reached.
 *
 * It does not load apps/api/.env (that is a remote DB). It reads only
 * BETTER_AUTH_SECRET, in the local API's order (apps/api/src/index.ts):
 * apps/api/.env.local, then the root .env.local. The invite token and
 * opt-out secrets are derived from it, so they match the running API.
 *
 * Run (pg can't connect to a bracketed `[::1]` hostname, so use localhost;
 * the cluster check above catches the wrong Postgres):
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public" \
 *     pnpm -F api run seed:invite-pause-qa
 */
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import pg from "pg";
import { hashPassword } from "better-auth/crypto";
import type { Prisma } from "@prisma/client";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { encodeGeohash } from "@th/core/lib/geo/geohash";
import { deriveShortIdFromUuid } from "@th/core/lib/slug-utils";
import { hashEventPassword } from "@th/core/lib/security/event-password";
import {
  deriveInviteTokenSecret,
  hashInviteToken,
  mintInviteToken,
} from "@th/core/lib/security/invite-token";
import { deriveInviteOptOutSecret } from "@th/core/lib/security/invite-optout-token";
import { inviteEmailMetadata } from "@th/core/use-cases/events/invites/invite-owner-tag";
import {
  recordInviteComplaint,
  requestInvitePauseReview,
} from "@th/core/use-cases/events/invites/invite-complaint-pause";

import { DEV_LOGIN_USER } from "../seed/ids.js";

// ── Safety: local dev DB only ─────────────────────────────────────────────

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type LocalTarget = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/**
 * Validates what getPrisma (packages/db/src/index.ts) actually connects to:
 * `host: url.hostname`, `port: url.port` (else pg's PGPORT, else 5432). It
 * ignores any `?host=` param, and pg falls back to PGHOST when the hostname
 * is empty, so both are refused here rather than trusted.
 */
function assertLocalDatabase(): LocalTarget {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Pass the LOCAL dev URL explicitly (see the header).",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Refusing to run: DATABASE_URL is not a URL.");
  }
  if (!url.hostname) {
    throw new Error(
      "Refusing to run: DATABASE_URL has no hostname, so pg would fall back to PGHOST. Use postgresql://…@localhost:5432/dev.",
    );
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL hostname is "${url.hostname}", not localhost, 127.0.0.1 or ::1.`,
    );
  }
  if (url.searchParams.has("host")) {
    throw new Error(
      `Refusing to run: DATABASE_URL has a host= param ("${url.searchParams.get("host")}"). getPrisma ignores it and connects to the hostname; remove it.`,
    );
  }
  const pgHost = process.env.PGHOST;
  if (pgHost && !LOCAL_HOSTNAMES.has(pgHost)) {
    throw new Error(
      `Refusing to run: PGHOST is "${pgHost}", not local. Unset it (pg falls back to it).`,
    );
  }
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : Number.parseInt(process.env.PGPORT ?? "5432", 10);
  const database = url.pathname.replace(/^\//, "") || process.env.PGDATABASE || "";
  return {
    host: url.hostname,
    port,
    database,
    user: decodeURIComponent(url.username) || process.env.PGUSER || "",
    password: decodeURIComponent(url.password),
  };
}

/**
 * The real dev DB listens on ::1; 127.0.0.1:5432 can be a lima CI Postgres
 * (and `localhost` resolves to 127.0.0.1 for pg here). Read-only: compares
 * the cluster getPrisma reached with the one on ::1, and refuses on a
 * mismatch or when ::1 can't be reached.
 */
async function assertSameClusterAsIpv6Loopback(
  prisma: ReturnType<typeof getPrisma>,
  target: LocalTarget,
): Promise<void> {
  const [reached] = await prisma.$queryRaw<
    { addr: string | null; port: number | null; sys: string }[]
  >`SELECT inet_server_addr()::text AS addr, inet_server_port() AS port, system_identifier::text AS sys FROM pg_control_system()`;
  if (!reached) throw new Error("Refusing to run: could not identify the database server.");
  console.log(
    `  getPrisma reached server ${reached.addr ?? "(unix socket)"}:${reached.port ?? "?"}, cluster ${reached.sys}`,
  );

  // pg takes an unbracketed IPv6 literal as `host` (a bracketed one is
  // ENOTFOUND), so connect to "::1" directly.
  const client = new pg.Client({
    host: "::1",
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
  });
  let ipv6Sys: string;
  try {
    await client.connect();
    const res = await client.query<{ sys: string }>(
      "SELECT system_identifier::text AS sys FROM pg_control_system()",
    );
    ipv6Sys = res.rows[0]!.sys;
  } catch (err) {
    throw new Error(
      `Refusing to run: could not reach the dev DB on [::1]:${target.port} to confirm the target (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
  if (ipv6Sys !== reached.sys) {
    throw new Error(
      `Refusing to run: ${target.host}:${target.port} reached cluster ${reached.sys}, but the dev DB on [::1]:${target.port} is cluster ${ipv6Sys}. ${target.host} is probably another Postgres (lima CI).`,
    );
  }
  console.log(`  same cluster as [::1]:${target.port}: OK`);
}

/**
 * BETTER_AUTH_SECRET as the local API loads it (apps/api/src/index.ts):
 * apps/api/.env.local first, then the root .env.local for a missing key.
 * scripts/human-dev.cjs pins only STRIPE_WEBHOOK_SECRET (DEV_ENV_PINS), so
 * nothing overrides this one.
 */
function readLocalAuthSecret(): { secret: string; source: string } {
  const candidates = [
    fileURLToPath(new URL("../../../.env.local", import.meta.url)),
    fileURLToPath(new URL("../../../../../.env.local", import.meta.url)),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const secret = dotenv.parse(fs.readFileSync(file)).BETTER_AUTH_SECRET;
    if (secret) return { secret, source: file };
  }
  throw new Error(
    `No BETTER_AUTH_SECRET in ${candidates.join(" or ")}: needed for invite secrets.`,
  );
}

// ── Fixed ids (prefix a11e9a5e, unused elsewhere) ─────────────────────────

const id = (group: string, n: number) =>
  `a11e9a5e-0000-4000-8${group}-${n.toString(16).padStart(12, "0")}`;

const PASSWORD = "Invite-Pause-QA-2026!";
const EVENT_PASSWORD = "letmein";
const DAY_MS = 86_400_000;
const PADDING_INVITES = 200;
const MAIN_GUESTS = 5;

type OrgScenario = {
  key: "a" | "b";
  orgId: string;
  orgName: string;
  orgSlug: string;
  pageSlug: string;
  owner: { humanId: string; email: string; name: string };
  mainEventId: string;
  mainEventTitle: string;
  mainEventSlug: string;
  pastEventId: string;
  pastEventTitle: string;
  pastEventSlug: string;
  reviewNote: string | null;
};

const ORG_A: OrgScenario = {
  key: "a",
  orgId: id("001", 1),
  orgName: "Invite Pause QA Presents",
  orgSlug: "invite-pause-qa",
  pageSlug: "invite-pause-qa-presents",
  owner: {
    humanId: id("002", 1),
    email: "invitepause-owner@example.com",
    name: "Ivy Pause (QA owner)",
  },
  mainEventId: id("003", 1),
  mainEventTitle: "Invite Pause QA: Garden Party",
  mainEventSlug: "invite-pause-qa-garden-party",
  pastEventId: id("003", 2),
  pastEventTitle: "Invite Pause QA: Last Month's Show",
  pastEventSlug: "invite-pause-qa-last-months-show",
  reviewNote: null,
};

const ORG_B: OrgScenario = {
  key: "b",
  orgId: id("001", 2),
  orgName: "Invite Pause QA Waiting",
  orgSlug: "invite-pause-qa-b",
  pageSlug: "invite-pause-qa-waiting",
  owner: {
    humanId: id("002", 2),
    email: "invitepause-waiting@example.com",
    name: "Walt Waiting (QA owner)",
  },
  mainEventId: id("003", 3),
  mainEventTitle: "Invite Pause QA: Rooftop Night",
  mainEventSlug: "invite-pause-qa-rooftop-night",
  pastEventId: id("003", 4),
  pastEventTitle: "Invite Pause QA: Last Month's Rooftop",
  pastEventSlug: "invite-pause-qa-last-months-rooftop",
  reviewNote: "These are people who bought tickets to our last show.",
};

const PERSON = {
  humanId: id("002", 3),
  email: "invitepause-person@example.com",
  name: "Penny Person (QA)",
  pageSlug: "invite-pause-qa-penny",
  eventId: id("003", 5),
  eventTitle: "Invite Pause QA: Penny's House Show",
  eventSlug: "invite-pause-qa-pennys-house-show",
};

const ORG_IDS = [ORG_A.orgId, ORG_B.orgId];
const HUMAN_IDS = [ORG_A.owner.humanId, ORG_B.owner.humanId, PERSON.humanId];
const EVENT_IDS = [
  ORG_A.mainEventId,
  ORG_A.pastEventId,
  ORG_B.mainEventId,
  ORG_B.pastEventId,
  PERSON.eventId,
];

// Invite id groups: one per event so ids never collide.
const INVITE_GROUP: Record<string, string> = {
  [ORG_A.mainEventId]: "a01",
  [ORG_A.pastEventId]: "a02",
  [ORG_B.mainEventId]: "b01",
  [ORG_B.pastEventId]: "b02",
  [PERSON.eventId]: "c01",
};

const GUEST_NAMES = ["Ada", "Bo", "Cy", "Dee", "Eli"];

type Ctx = {
  prisma: ReturnType<typeof getPrisma>;
  repos: ReturnType<typeof createPrismaRepos>;
  clock: ReturnType<typeof createSystemClock>;
  inviteTokenSecret: string;
  inviteOptOutSecret: string;
  passwordHash: string;
  /** Start of today (UTC), so event times are stable across same-day runs. */
  today: Date;
};

// ── Reset: only this scenario's rows ─────────────────────────────────────

async function resetScenario(ctx: Ctx): Promise<void> {
  const { prisma } = ctx;
  const ownerOr = [
    { orgId: { in: ORG_IDS } },
    { humanOwnerId: PERSON.humanId },
  ];
  await prisma.$transaction([
    prisma.eventInvitePause.deleteMany({ where: { OR: ownerOr } }),
    prisma.eventInviteComplaint.deleteMany({ where: { OR: ownerOr } }),
    prisma.eventInviteOptOut.deleteMany({ where: { OR: ownerOr } }),
    prisma.eventUnlock.deleteMany({ where: { eventId: { in: EVENT_IDS } } }),
    prisma.eventInvite.deleteMany({ where: { eventId: { in: EVENT_IDS } } }),
    prisma.notification.deleteMany({ where: { humanId: { in: HUMAN_IDS } } }),
    prisma.auditLog.deleteMany({
      where: {
        entityId: { in: [...ORG_IDS, PERSON.humanId] },
        action: { startsWith: "event_invite" },
      },
    }),
  ]);
}

// ── Fixtures ──────────────────────────────────────────────────────────────

async function ensureLogin(
  ctx: Ctx,
  person: { humanId: string; email: string; name: string },
  page: { slug: string } | null,
): Promise<void> {
  const { prisma } = ctx;
  const email = person.email.toLowerCase();
  await prisma.human.upsert({
    where: { id: person.humanId },
    update: { name: person.name, status: "ACTIVE" },
    create: {
      id: person.humanId,
      name: person.name,
      status: "ACTIVE",
      locale: "en",
    },
  });
  if (page) {
    await prisma.entityPage.upsert({
      where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: person.humanId } },
      update: { displayName: person.name, slug: page.slug, visibility: "PUBLIC" },
      create: {
        ownerType: "HUMAN",
        ownerId: person.humanId,
        displayName: person.name,
        slug: page.slug,
        visibility: "PUBLIC",
      },
    });
  }
  // Same shape as seed/identity.ts ensureDevLoginUser: auth_user id = human
  // id, a "credential" account holding the better-auth password hash.
  const authUser = await prisma.authUser.upsert({
    where: { id: person.humanId },
    // No username on purpose: with one, the person's /admin slug becomes
    // @<username> instead of @<page slug>. A re-run clears one set by hand.
    update: {
      email,
      name: person.name,
      emailVerified: true,
      humanId: person.humanId,
      username: null,
      displayUsername: null,
    },
    create: {
      id: person.humanId,
      email,
      name: person.name,
      emailVerified: true,
      humanId: person.humanId,
    },
  });
  await prisma.authAccount.upsert({
    where: {
      providerId_accountId: { providerId: "credential", accountId: authUser.id },
    },
    update: { password: ctx.passwordHash, userId: authUser.id },
    create: {
      providerId: "credential",
      accountId: authUser.id,
      userId: authUser.id,
      password: ctx.passwordHash,
    },
  });
}

async function ensureOrg(ctx: Ctx, s: OrgScenario): Promise<void> {
  const { prisma } = ctx;
  await prisma.organization.upsert({
    where: { id: s.orgId },
    update: { name: s.orgName, slug: s.orgSlug, status: "ACTIVE" },
    create: {
      id: s.orgId,
      name: s.orgName,
      slug: s.orgSlug,
      status: "ACTIVE",
      defaultLocale: "en",
    },
  });
  await prisma.entityPage.upsert({
    where: { ownerType_ownerId: { ownerType: "ORGANIZATION", ownerId: s.orgId } },
    update: { displayName: s.orgName, slug: s.pageSlug, visibility: "PUBLIC" },
    create: {
      ownerType: "ORGANIZATION",
      ownerId: s.orgId,
      displayName: s.orgName,
      slug: s.pageSlug,
      visibility: "PUBLIC",
    },
  });
  await ensureLogin(ctx, s.owner, null);
  await prisma.orgMember.upsert({
    where: { orgId_humanId: { orgId: s.orgId, humanId: s.owner.humanId } },
    update: { role: "OWNER" },
    create: { orgId: s.orgId, humanId: s.owner.humanId, role: "OWNER" },
  });
}

async function ensureEvent(
  ctx: Ctx,
  ev: {
    id: string;
    title: string;
    slug: string;
    owner: { orgId: string } | { humanId: string };
    startsAt: Date;
  },
): Promise<void> {
  const data = {
    orgId: "orgId" in ev.owner ? ev.owner.orgId : null,
    humanId: "humanId" in ev.owner ? ev.owner.humanId : null,
    title: ev.title,
    slug: ev.slug,
    startsAt: ev.startsAt,
    endsAt: new Date(ev.startsAt.getTime() + 4 * 60 * 60 * 1000),
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    publishedAt: new Date(ctx.today.getTime() - 30 * DAY_MS),
    // Free attendance: no ticket types, tax or money paths to set up.
    attendanceMode: "RSVP" as const,
    stewardship: "OWNED" as const,
    gateType: "PASSWORD" as const,
    passwordHash: hashEventPassword(EVENT_PASSWORD),
    passwordUpdatedAt: ctx.today,
    addressText: "2400 Hennepin Ave, Minneapolis, MN 55405",
    locality: "Minneapolis",
    region: "MN",
    postalCode: "55405",
    countryCode: "US",
    regionCode: "MN",
    lat: 44.9606,
    lng: -93.2911,
    // As the events adapter stamps them: geohash6 from lat/lng, no geohash8
    // (nobody writes it), shortId derived from the event id.
    geohash6: encodeGeohash(44.9606, -93.2911, 6),
    geohash8: null,
    shortId: deriveShortIdFromUuid(ev.id),
    timezone: "America/Chicago",
    defaultLocale: "en",
  };
  await ctx.prisma.event.upsert({
    where: { id: ev.id },
    update: data,
    create: { id: ev.id, ...data },
  });
}

type SentInvite = { id: string; email: string; sentAt: Date };

/**
 * PERSONAL invites already sent, as `createEventGuestInvites` leaves them
 * after a successful send: lowercase email, token hash of the minted token,
 * creator = the organiser, `sentAt` stamped.
 */
async function sendInvites(
  ctx: Ctx,
  ev: { id: string; createdByHumanId: string },
  guests: { name: string; email: string }[],
  sentAt: Date,
): Promise<SentInvite[]> {
  const group = INVITE_GROUP[ev.id]!;
  const rows: Prisma.EventInviteCreateManyInput[] = guests.map((g, i) => {
    const inviteId = id(group, i + 1);
    return {
      id: inviteId,
      eventId: ev.id,
      kind: "PERSONAL",
      inviteeName: g.name,
      inviteeEmail: g.email.toLowerCase(),
      tokenHash: hashInviteToken(mintInviteToken(inviteId, ctx.inviteTokenSecret)),
      createdByHumanId: ev.createdByHumanId,
      inviteListEntryId: null,
      sentAt,
    };
  });
  await ctx.prisma.eventInvite.createMany({ data: rows });
  return rows.map((r) => ({ id: r.id!, email: r.inviteeEmail!, sentAt }));
}

/** A guest marks the invite as spam: the Resend webhook's use case. */
async function complain(
  ctx: Ctx,
  ev: { id: string; orgId: string | null; humanId: string | null },
  invite: SentInvite,
  providerEventId: string,
  occurredAt: Date,
) {
  const result = await recordInviteComplaint(
    {
      repos: ctx.repos,
      clock: ctx.clock,
      inviteOptOutSecret: ctx.inviteOptOutSecret,
      reportError: (err) => {
        console.error("  ! reportError:", err);
      },
    },
    {
      providerEventId,
      email: invite.email,
      occurredAt,
      // Exactly what the invite email carries (Resend echoes it back).
      metadata: inviteEmailMetadata(ev, invite.sentAt) ?? null,
    },
  );
  if (result.outcome !== "RECORDED" || !result.created) {
    throw new Error(
      `complaint ${providerEventId} was not recorded: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function buildOrgScenario(ctx: Ctx, s: OrgScenario) {
  await ensureOrg(ctx, s);
  await ensureEvent(ctx, {
    id: s.mainEventId,
    title: s.mainEventTitle,
    slug: s.mainEventSlug,
    owner: { orgId: s.orgId },
    startsAt: new Date(ctx.today.getTime() + 21 * DAY_MS + 19 * 60 * 60 * 1000),
  });
  await ensureEvent(ctx, {
    id: s.pastEventId,
    title: s.pastEventTitle,
    slug: s.pastEventSlug,
    owner: { orgId: s.orgId },
    startsAt: new Date(ctx.today.getTime() - 10 * DAY_MS + 19 * 60 * 60 * 1000),
  });

  const now = ctx.clock.now();
  // 200 guests of last month's show, invited 20 days ago (inside the 30-day
  // window): keeps the first two complaints under the 1% rate.
  await sendInvites(
    ctx,
    { id: s.pastEventId, createdByHumanId: s.owner.humanId },
    Array.from({ length: PADDING_INVITES }, (_, i) => ({
      name: `Past Guest ${i + 1}`,
      email: `past-guest-${i + 1}.invitepause-${s.key}@example.com`,
    })),
    new Date(now.getTime() - 20 * DAY_MS),
  );
  // The 5 guests of the upcoming event, invited 2 days ago.
  const guests = await sendInvites(
    ctx,
    { id: s.mainEventId, createdByHumanId: s.owner.humanId },
    GUEST_NAMES.slice(0, MAIN_GUESTS).map((name) => ({
      name: `${name} Guest`,
      email: `${name.toLowerCase()}.invitepause-${s.key}@example.com`,
    })),
    new Date(now.getTime() - 2 * DAY_MS),
  );

  // Three distinct guests mark it as spam; the third trips the pause.
  const ev = { id: s.mainEventId, orgId: s.orgId, humanId: null };
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(
      await complain(
        ctx,
        ev,
        guests[i]!,
        `qa-invite-pause-${s.key}-complaint-${i + 1}`,
        new Date(now.getTime() - (3 - i) * 60 * 60 * 1000),
      ),
    );
  }
  const trippedBy = results.map((r) => (r.outcome === "RECORDED" ? r.paused : null));
  if (trippedBy[0] !== null || trippedBy[1] !== null || trippedBy[2] !== "COMPLAINT_COUNT") {
    throw new Error(
      `org ${s.key}: expected the 3rd complaint to pause by COMPLAINT_COUNT, got ${JSON.stringify(trippedBy)}`,
    );
  }

  if (s.reviewNote) {
    await requestInvitePauseReview(
      { repos: ctx.repos, clock: ctx.clock },
      {
        eventId: s.mainEventId,
        actorHumanId: s.owner.humanId,
        note: s.reviewNote,
      },
    );
  }
}

async function buildPersonScenario(ctx: Ctx) {
  await ensureLogin(ctx, PERSON, { slug: PERSON.pageSlug });
  await ensureEvent(ctx, {
    id: PERSON.eventId,
    title: PERSON.eventTitle,
    slug: PERSON.eventSlug,
    owner: { humanId: PERSON.humanId },
    startsAt: new Date(ctx.today.getTime() + 14 * DAY_MS + 20 * 60 * 60 * 1000),
  });
  const now = ctx.clock.now();
  const guests = await sendInvites(
    ctx,
    { id: PERSON.eventId, createdByHumanId: PERSON.humanId },
    GUEST_NAMES.slice(0, MAIN_GUESTS).map((name) => ({
      name: `${name} Guest`,
      email: `${name.toLowerCase()}.invitepause-p@example.com`,
    })),
    new Date(now.getTime() - 2 * DAY_MS),
  );
  // One complaint among 5 recipients: 1*100 > 5, so it pauses by rate.
  const result = await complain(
    ctx,
    { id: PERSON.eventId, orgId: null, humanId: PERSON.humanId },
    guests[0]!,
    "qa-invite-pause-p-complaint-1",
    new Date(now.getTime() - 60 * 60 * 1000),
  );
  if (result.outcome !== "RECORDED" || result.paused !== "COMPLAINT_RATE") {
    throw new Error(`person: expected COMPLAINT_RATE, got ${JSON.stringify(result)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const target = assertLocalDatabase();
  console.log(
    `▶ Target: ${target.host}:${target.port}/${target.database} (from DATABASE_URL hostname)`,
  );
  const { secret: authSecret, source: secretSource } = readLocalAuthSecret();
  console.log(`  BETTER_AUTH_SECRET from ${secretSource}`);
  const inviteTokenSecret = deriveInviteTokenSecret(authSecret);
  const inviteOptOutSecret = deriveInviteOptOutSecret(authSecret);
  if (!inviteTokenSecret || !inviteOptOutSecret) {
    throw new Error("BETTER_AUTH_SECRET is too short to derive invite secrets.");
  }

  // Every pool connection resolves `localhost` again; without this pin one
  // could fall back to 127.0.0.1 (lima CI) after the check passed on ::1.
  dns.setDefaultResultOrder("ipv6first");
  net.setDefaultAutoSelectFamily(false);

  const prisma = getPrisma();
  try {
    await assertSameClusterAsIpv6Loopback(prisma, target);
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const now = clock.now();
  const ctx: Ctx = {
    prisma,
    repos,
    clock,
    inviteTokenSecret,
    inviteOptOutSecret,
    passwordHash: await hashPassword(PASSWORD),
    today: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  };

  try {
    console.log("▶ Resetting this scenario's rows…");
    await resetScenario(ctx);
    console.log("▶ Org A (paused, review not requested)…");
    await buildOrgScenario(ctx, ORG_A);
    console.log("▶ Org B (paused, review requested)…");
    await buildOrgScenario(ctx, ORG_B);
    console.log("▶ Person-owned (paused by rate)…");
    await buildPersonScenario(ctx);
  } finally {
    await prisma.$disconnect();
  }

  const web = "http://localhost:3000";
  const builder = (adminSlug: string, eventId: string) =>
    `${web}/admin/${adminSlug}/events/${eventId}/edit?section=settings`;
  const line = "─".repeat(70);
  console.log(`\n${line}\nInvite pause QA: run sheet\n${line}`);
  console.log(`Password for all three logins: ${PASSWORD}`);
  console.log(`Event password (gate):          ${EVENT_PASSWORD}\n`);
  console.log(`A. ${ORG_A.orgName}  (paused: COMPLAINT_COUNT, review NOT requested)`);
  console.log(`   login   ${ORG_A.owner.email}`);
  console.log(`   builder ${builder(ORG_A.orgSlug, ORG_A.mainEventId)}`);
  console.log(`           → Access & privacy → Invited guests: notice + "Ask for a review"`);
  console.log(`   /orgs   ${web}/orgs/${ORG_A.pageSlug}   (NOT /orgs/${ORG_A.orgSlug})\n`);
  console.log(`B. ${ORG_B.orgName}  (paused: COMPLAINT_COUNT, review REQUESTED)`);
  console.log(`   login   ${ORG_B.owner.email}`);
  console.log(`   builder ${builder(ORG_B.orgSlug, ORG_B.mainEventId)}`);
  console.log(`   note    "${ORG_B.reviewNote}"`);
  console.log(`   /orgs   ${web}/orgs/${ORG_B.pageSlug}   (NOT /orgs/${ORG_B.orgSlug})\n`);
  console.log(`P. ${PERSON.name}  (person-owned; paused: COMPLAINT_RATE, review NOT requested)`);
  console.log(`   login   ${PERSON.email}`);
  console.log(`   builder ${builder(`@${PERSON.pageSlug}`, PERSON.eventId)}`);
  console.log(
    `           (no username is set; setting one changes the slug to @<username>)`,
  );
  console.log(
    `   staff   ${web}/platform/humans?q=${encodeURIComponent(PERSON.name)}\n`,
  );
  console.log(`Staff queue: ${web}/platform/invite-pauses`);
  console.log(`   login   ${DEV_LOGIN_USER.email} / ${DEV_LOGIN_USER.password}`);
  console.log(
    `   "Waiting for review" → B; "All open" → A, B, P; "Lifted" → none of these three`,
  );
  console.log(`   (pauses not made by this script show alongside them)`);
  console.log(`\nRe-run any time to reset these three back to this state.\n${line}`);
}

main().catch((err) => {
  console.error("seed-invite-pause-qa failed:", err);
  process.exit(1);
});
