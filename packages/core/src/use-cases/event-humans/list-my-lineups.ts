import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { HumanLineupRow } from "@th/ports/repos/event-humans";
import { fail } from "@th/errors";
import { eventStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import {
  leaveNoticeReachesSomeoneElse,
  lineupRoleLabel,
  listLineupEditorHumanIds,
} from "./_shared/lineup-notice-support";
import { listEventsWhereLeavePassesAct } from "./_shared/lineup-leave-booking";
import { isWithdrawableSignupStatus } from "./leave-event-lineup";

// ─────────────────────────────────────────────────────────────────────────────
// `/my-lineups` (owner ruling "option A", 2026-09-30): every lineup the
// signed-in person is on, so they can see where their name appears and take
// themselves off (`leaveEventLineup`). The person's OWN view — drafts,
// private and cancelled events included (they cannot open a draft's event
// page, so this is the only place they can see it). Never exposes anyone
// else's rows.
//
// ORDER: upcoming first (not yet ended, soonest first), then past (most
// recent first) — one cursor walks both. The cursor is opaque base64url JSON:
// the phase, the last row's (startsAt, eventHumanId) keyset, and the FIRST
// page's `now` — every page splits upcoming/past at the same instant, so an
// event that ends between two page loads cannot appear in both phases.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** At most this many org membership reads in flight for one page. */
const ORG_READ_CONCURRENCY = 5;

export const listMyLineupsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    cursor: z.string().min(1).max(512).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

const eventHumanRoleSchema = z.enum([
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
]);

export const myLineupItemSchema = z
  .object({
    eventHumanId: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string(),
    startsAt: z.date(),
    endsAt: z.date(),
    timezone: z.string(),
    status: eventStatusSchema,
    visibility: z.enum(["PUBLIC", "PRIVATE"]),
    role: eventHumanRoleSchema,
    customRoleLabel: z.string().nullable(),
    /** "Performer", "DJ", … or the custom label for OTHER. */
    roleLabel: z.string(),
    /**
     * Org name, else the owning human's name. Null for a community listing —
     * but ALSO for a personal event whose owner has no name, so do not use it
     * to decide the "will be told" copy: that is `organiserWillBeTold`.
     */
    organiserName: z.string().nullable(),
    /**
     * Someone other than the caller hears if they leave — exactly the leave
     * notice's recipients minus the caller (`leaveNoticeReachesSomeoneElse`):
     * an org event with an edit-role member who is not the caller, or a
     * personal event owned by someone else. False for an ownerless community
     * listing, the caller's own personal event, and an org whose ONLY
     * editor is the caller.
     */
    organiserWillBeTold: z.boolean(),
    /**
     * A VOLUNTEER row with a live (PENDING / APPROVED) volunteer signup for
     * this event: leaving also withdraws that signup.
     */
    hasVolunteerSignup: z.boolean(),
    /**
     * Leaving would also give up the caller's spot on the booking this show
     * came from (owner ruling 2026-10-01): an upcoming, live show, and the
     * caller is a tagged act on its bill that has not passed — the same rule
     * `leaveEventLineup` applies (`_shared/lineup-leave-booking.ts`).
     */
    passesBookingAct: z.boolean(),
    /** Public slug — set ONLY while the event is PUBLISHED. */
    slug: z.string().nullable(),
    /** The event has ended. */
    isPast: z.boolean(),
  })
  .strict();

export const listMyLineupsOutputSchema = z
  .object({
    items: z.array(myLineupItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListMyLineupsInput = z.infer<typeof listMyLineupsInputSchema>;
export type ListMyLineupsOutput = z.infer<typeof listMyLineupsOutputSchema>;
export type MyLineupItem = z.infer<typeof myLineupItemSchema>;

export type ListMyLineupsDeps = {
  repos: Pick<
    Repos,
    | "eventHumans"
    | "volunteering"
    | "organizations"
    // `passesBookingAct`: event → agreement → request → bill, batched.
    | "agreements"
    | "bookingRequests"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

type Phase = "upcoming" | "past";

type DecodedCursor = {
  phase: Phase;
  after: { startsAt: Date; eventHumanId: string } | null;
  /** The split instant pinned by the first page; null on the first page. */
  now: Date | null;
};

const cursorPayloadSchema = z
  .object({
    w: z.enum(["u", "p"]),
    n: z.string().datetime(),
    s: z.string().datetime().optional(),
    i: z.uuid().optional(),
  })
  .strict();

function encodeCursor(
  phase: Phase,
  last: HumanLineupRow | null,
  now: Date,
): string {
  const payload: z.infer<typeof cursorPayloadSchema> = {
    w: phase === "upcoming" ? "u" : "p",
    n: now.toISOString(),
    ...(last
      ? { s: last.startsAt.toISOString(), i: last.eventHumanId }
      : {}),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor {
  if (!cursor) return { phase: "upcoming", after: null, now: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw fail("INVALID_INPUT", { message: "invalid_cursor" });
  }
  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success || Boolean(result.data.s) !== Boolean(result.data.i)) {
    throw fail("INVALID_INPUT", { message: "invalid_cursor" });
  }
  const { w, n, s, i } = result.data;
  return {
    phase: w === "u" ? "upcoming" : "past",
    after: s && i ? { startsAt: new Date(s), eventHumanId: i } : null,
    now: new Date(n),
  };
}

function toItem(
  row: HumanLineupRow,
  now: Date,
  actorHumanId: string,
  volunteerEventIds: ReadonlySet<string>,
  orgEditorIds: ReadonlyMap<string, readonly string[]>,
  bookingActEventIds: ReadonlySet<string>,
): MyLineupItem {
  return {
    eventHumanId: row.eventHumanId,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    status: row.status,
    visibility: row.visibility,
    role: row.role,
    customRoleLabel: row.customRoleLabel,
    roleLabel: lineupRoleLabel(row.role, row.customRoleLabel),
    organiserName: row.orgName ?? row.ownerHumanName ?? null,
    organiserWillBeTold: leaveNoticeReachesSomeoneElse(
      { orgId: row.ownerOrgId, humanId: row.ownerHumanId },
      actorHumanId,
      (row.ownerOrgId && orgEditorIds.get(row.ownerOrgId)) || [],
    ),
    hasVolunteerSignup:
      row.role === "VOLUNTEER" && volunteerEventIds.has(row.eventId),
    passesBookingAct: bookingActEventIds.has(row.eventId),
    // A draft/cancelled/archived event's slug leads nowhere public.
    slug: row.status === "PUBLISHED" ? row.slug : null,
    isPast: row.endsAt.getTime() <= now.getTime(),
  };
}

export async function listMyLineups(
  deps: ListMyLineupsDeps,
  rawInput: unknown,
): Promise<ListMyLineupsOutput> {
  const input = parseInput(listMyLineupsInputSchema, rawInput);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const cursor = decodeCursor(input.cursor);
  const now = cursor.now ?? deps.clock.now();

  const fetch = (
    when: Phase,
    after: DecodedCursor["after"],
    take: number,
  ) =>
    deps.repos.eventHumans.listLineupsByHuman({
      humanId: input.actorHumanId,
      when,
      now,
      after,
      limit: take,
    });

  const rows: HumanLineupRow[] = [];
  let nextCursor: string | null = null;

  if (cursor.phase === "upcoming") {
    // One extra row tells whether the upcoming phase continues.
    const upcoming = await fetch("upcoming", cursor.after, limit + 1);
    if (upcoming.length > limit) {
      rows.push(...upcoming.slice(0, limit));
      nextCursor = encodeCursor("upcoming", rows[rows.length - 1] ?? null, now);
    } else {
      rows.push(...upcoming);
      const room = limit - rows.length;
      // Fill the rest of the page from the past phase; with no room left,
      // one row is enough to know whether there is a next page.
      const past = await fetch("past", null, Math.max(room, 0) + 1);
      if (past.length > room) {
        rows.push(...past.slice(0, room));
        const lastPast = room > 0 ? (past[room - 1] ?? null) : null;
        nextCursor = encodeCursor("past", lastPast, now);
      } else {
        rows.push(...past);
      }
    }
  } else {
    const past = await fetch("past", cursor.after, limit + 1);
    rows.push(...past.slice(0, limit));
    if (past.length > limit) {
      nextCursor = encodeCursor("past", rows[rows.length - 1] ?? null, now);
    }
  }

  // One read for the whole page, and only when a VOLUNTEER row is on it.
  const volunteerEventIds = new Set<string>();
  if (rows.some((row) => row.role === "VOLUNTEER")) {
    const signups = await deps.repos.volunteering.listSignupsByHuman(
      input.actorHumanId,
    );
    for (const signup of signups) {
      if (signup.eventId && isWithdrawableSignupStatus(signup.status)) {
        volunteerEventIds.add(signup.eventId);
      }
    }
  }

  // "Will the organiser be told?": one membership read per DISTINCT org on
  // the page, never per row, at most ORG_READ_CONCURRENCY at a time.
  const orgIds = [
    ...new Set(
      rows.flatMap((row) => (row.ownerOrgId ? [row.ownerOrgId] : [])),
    ),
  ];
  const orgEditorIds = new Map<string, readonly string[]>();
  for (let i = 0; i < orgIds.length; i += ORG_READ_CONCURRENCY) {
    const batch = orgIds.slice(i, i + ORG_READ_CONCURRENCY);
    const editors = await Promise.all(
      batch.map((orgId) => listLineupEditorHumanIds(deps.repos, orgId)),
    );
    batch.forEach((orgId, j) => orgEditorIds.set(orgId, editors[j] ?? []));
  }

  // "Leaving also gives up your booking spot": at most three reads for the
  // page, none unless an upcoming live show is on it.
  const bookingActEventIds = await listEventsWhereLeavePassesAct(
    deps.repos,
    input.actorHumanId,
    rows,
    now,
  );

  return listMyLineupsOutputSchema.parse({
    items: rows.map((row) =>
      toItem(
        row,
        now,
        input.actorHumanId,
        volunteerEventIds,
        orgEditorIds,
        bookingActEventIds,
      ),
    ),
    nextCursor,
  });
}
