import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

/**
 * Venue-side booking requests for the demo org's four venues — the data behind
 * the org Bookings page.
 *
 * WHY THIS EXISTS. There was no booking-request seed at all, so every stage tab
 * on that page read `(0)` in a fresh dev database and the inbox could only be
 * exercised by hand-creating requests through the public form. Worse, the demo
 * org owned ONE venue, so the venue filter hid its select entirely and the
 * cross-venue filter — the reason the page exists — was unreachable in dev.
 *
 * WHAT IT COVERS. One row for every stage the inbox can show, because a tab
 * that is empty in dev is a tab nobody checks. The classifier is
 * `bookingInboxTabOf` (apps/web/src/components/bookings/booking-inbox-tabs.ts)
 * and its precedence is load-bearing, so the fixtures are written against it
 * rather than against what the statuses look like in isolation:
 *
 *   open      — PENDING / VIEWED. Note the classifier checks open FIRST, so a
 *               PENDING request that also carries a live hold still lands
 *               here, not on Holds ("an unanswered request with a hold is
 *               still an unanswered request"). One fixture is exactly that
 *               case, because it is the one most likely to regress.
 *   holds     — ACCEPTED + a LIVE hold (ACTIVE or CHALLENGED). A challenged
 *               hold carries `respondBy` so the countdown renders.
 *   agreement — ACCEPTED + a non-terminal Agreement, no event yet.
 *   event     — ACCEPTED + an Agreement that produced an Event.
 *   closed    — DECLINED / WITHDRAWN / EXPIRED, plus one accepted request
 *               whose Agreement was CANCELLED (the "closed by the agreement,
 *               not the request" path, which the request status alone cannot
 *               express).
 *
 * It also spreads across SENDER shapes — a human act, an org act, and an
 * anonymous EMBED inquiry with no performer owner at all — because the row
 * renderer narrows on that union and the anonymous branch is the one with no
 * profile to fall back on.
 *
 * IDEMPOTENT. Every row is pinned and upserted, so reseeding is stable and a
 * partially-seeded database converges. Dates are relative to the run so the
 * fixtures never go stale into the past.
 */

/** Deterministic id builder — keeps the fixtures readable and collision-free. */
const bookingId = (n: number) =>
  `00000000-0000-4000-8000-0000000bb0${n.toString(16).padStart(2, "0")}`;
const agreementId = (n: number) =>
  `00000000-0000-4000-8000-0000000ba0${n.toString(16).padStart(2, "0")}`;
const holdId = (n: number) =>
  `00000000-0000-4000-8000-0000000bc0${n.toString(16).padStart(2, "0")}`;

const daysFromNow = (days: number): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const hoursFromNow = (hours: number): Date =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

/** `preferredDates` is a JSON array of ISO date strings (no time component). */
const isoDate = (days: number): string =>
  daysFromNow(days).toISOString().slice(0, 10);

type SenderFixture =
  | { kind: "human"; humanId: string; actName: string }
  | { kind: "org"; orgId: string; actName: string }
  /** Anonymous embed inquiry — no performer owner until it is claimed. */
  | { kind: "anon"; contactName: string; contactEmail: string };

type BookingFixture = {
  id: string;
  placeId: string;
  sender: SenderFixture;
  message: string;
  /**
   * Preferred dates for PERFORM requests (JSON array of ISO date strings).
   * Omitted for RENT/USE which use requestedStartsAt/EndsAt instead.
   */
  preferredDates?: string[];
  status: "PENDING" | "VIEWED" | "ACCEPTED" | "DECLINED" | "WITHDRAWN" | "EXPIRED";
  /**
   * Intent: PERFORM (default), RENT, or USE. Determines form variant and owner default at accept.
   */
  intent?: "PERFORM" | "RENT" | "USE";
  genre?: string;
  expectedDraw?: number;
  feeType?: "GUARANTEE" | "DOOR_SPLIT" | "NEGOTIABLE";
  feeAmountCents?: number;
  viewedAt?: Date;
  respondedAt?: Date;
  declineReason?: string;
  source?: "PLATFORM" | "EMBED";
  /**
   * Programming calendar this request routes to, by slug. Omitted = the
   * venue's default ("main"). Spread across fixtures on purpose: a calendar
   * filter over rows that all share one calendar filters nothing.
   */
  calendarSlug?: string;
  /**
   * The space being booked. Index into the place's declared spaces or a
   * stable space id. OPTIONAL for every intent (ruling 2026-09-22 — a
   * request routes to a calendar and a window; the room is chosen at
   * accept/confirm, on the draft event). The RENT/USE fixtures below still
   * name one, which stays valid.
   */
  spaceIndex?: number;
  /**
   * For RENT/USE requests: start datetime of the window. Required for RENT/USE.
   */
  requestedStartsAt?: Date;
  /**
   * For RENT/USE requests: end datetime of the window. Required for RENT/USE.
   */
  requestedEndsAt?: Date;
  /**
   * For RENT/USE requests: what it is (one-line description). Required for RENT/USE.
   */
  purpose?: string;
  /**
   * For RENT/USE requests: expected attendance. Required for RENT/USE.
   */
  expectedAttendance?: number;
  /** Minted alongside the request when present. */
  agreement?: {
    id: string;
    status: "DRAFT" | "PROPOSED" | "ACCEPTED" | "CANCELLED" | "DECLINED";
    title: string;
    proposedDate: Date;
    guaranteeCents?: number;
    /**
     * Link this agreement to a real Event, which is what puts the request on
     * the EVENT tab (`Agreement.eventId`, falling back to `draftEventId`).
     *
     * Resolved at run time rather than pinned: seeded events get random ids,
     * so there is nothing stable to hardcode. `Agreement.eventId` is UNIQUE,
     * so the lookup takes an event no other agreement has claimed — and if it
     * finds none, the fixture still seeds, just on the Agreement tab. Better a
     * row on the wrong tab than a failed seed or a dangling FK.
     */
    attachDemoEvent?: boolean;
  };
  /** Holds on the request's calendar; `spaceIndex` picks a declared room. */
  holds?: {
    id: string;
    date: Date;
    position: number;
    status: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
    spaceIndex?: number;
    respondBy?: Date;
  }[];
};

const FIXTURES: BookingFixture[] = [
  // ── OPEN ────────────────────────────────────────────────────────────────
  {
    id: bookingId(1),
    placeId: DEMO_IDS.place1, // The Paramount Theatre
    sender: { kind: "human", humanId: DEMO_IDS.human2, actName: "Alex Rivera" },
    message:
      "We're routing through Texas in the spring and would love a night at the Paramount. Three-piece, we bring our own engineer.",
    preferredDates: [isoDate(38), isoDate(45)],
    status: "PENDING",
    genre: "Indie Rock",
    expectedDraw: 220,
    feeType: "GUARANTEE",
    feeAmountCents: 120000,
  },
  {
    id: bookingId(2),
    placeId: DEMO_IDS.demoVenueMohawk,
    sender: { kind: "human", humanId: DEMO_IDS.human3, actName: "Jamie Chen" },
    message:
      "Big fan of the outdoor stage. We can bring a full local bill if that helps you fill the night.",
    preferredDates: [isoDate(30)],
    status: "VIEWED",
    viewedAt: hoursFromNow(-20),
    genre: "Synth Pop",
    expectedDraw: 150,
    feeType: "DOOR_SPLIT",
    calendarSlug: "outdoor-series",
  },
  {
    // OPEN *and* holding a date. The classifier checks open first, so this
    // must render on Open with its hold visible — not on Holds.
    id: bookingId(3),
    placeId: DEMO_IDS.demoVenueCheerUp,
    sender: {
      kind: "anon",
      contactName: "Marisol Vega",
      contactEmail: "marisol@example.com",
    },
    source: "EMBED",
    message:
      "Found your booking form on the venue site. Solo set, about 40 minutes, happy to open for anyone.",
    preferredDates: [isoDate(21)],
    status: "PENDING",
    genre: "Folk",
    expectedDraw: 60,
    feeType: "NEGOTIABLE",
    calendarSlug: "late-night",
    holds: [
      {
        id: holdId(1),
        date: daysFromNow(21),
        position: 1,
        status: "ACTIVE",
        spaceIndex: 1, // Outside
      },
    ],
  },

  // ── HOLDS ───────────────────────────────────────────────────────────────
  {
    id: bookingId(4),
    placeId: DEMO_IDS.demoVenueMohawk,
    sender: { kind: "human", humanId: DEMO_IDS.human4, actName: "Sam Okonkwo" },
    message:
      "Pencil us in for the indoor stage — we can confirm once our tour routing locks.",
    preferredDates: [isoDate(52)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-96),
    respondedAt: hoursFromNow(-90),
    genre: "Soul",
    expectedDraw: 300,
    holds: [
      {
        id: holdId(2),
        date: daysFromNow(52),
        position: 1,
        status: "ACTIVE",
        spaceIndex: 1, // Indoor Stage
      },
    ],
  },
  {
    // CHALLENGED — the act has a keep-or-release clock running.
    id: bookingId(5),
    placeId: DEMO_IDS.place1,
    sender: {
      kind: "human",
      humanId: DEMO_IDS.human5,
      actName: "Taylor Morgan",
    },
    message:
      "Holding the 12th while we sort a support slot. Will know either way within the week.",
    preferredDates: [isoDate(60)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-140),
    respondedAt: hoursFromNow(-130),
    genre: "Americana",
    expectedDraw: 400,
    holds: [
      {
        id: holdId(3),
        date: daysFromNow(60),
        position: 1,
        status: "CHALLENGED",
        respondBy: hoursFromNow(23),
      },
    ],
  },

  // ── AGREEMENT ───────────────────────────────────────────────────────────
  {
    id: bookingId(6),
    placeId: DEMO_IDS.demoVenueCheerUp,
    sender: {
      kind: "org",
      orgId: DEMO_IDS.org4,
      actName: "Chicago Underground Collective",
    },
    message:
      "Bringing a three-band package down from Chicago. Terms attached — we'd take a door split.",
    preferredDates: [isoDate(70)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-200),
    respondedAt: hoursFromNow(-190),
    genre: "Post-Punk",
    expectedDraw: 250,
    feeType: "DOOR_SPLIT",
    calendarSlug: "late-night",
    agreement: {
      id: agreementId(1),
      status: "PROPOSED",
      title: "Chicago Underground @ Cheer Up Charlies",
      proposedDate: daysFromNow(70),
      guaranteeCents: 50000,
    },
  },
  {
    id: bookingId(7),
    placeId: DEMO_IDS.demoVenueHoleInWall,
    sender: {
      kind: "human",
      humanId: DEMO_IDS.human6,
      actName: "Morgan Kowalski",
    },
    message: "Residency idea — first Tuesday of the month, we build it slow.",
    preferredDates: [isoDate(28)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-300),
    respondedAt: hoursFromNow(-280),
    genre: "Jazz",
    expectedDraw: 80,
    agreement: {
      id: agreementId(2),
      status: "ACCEPTED",
      title: "Morgan Kowalski residency @ Hole in the Wall",
      proposedDate: daysFromNow(28),
      guaranteeCents: 20000,
    },
  },

  // ── EVENT ───────────────────────────────────────────────────────────────
  {
    id: bookingId(12),
    placeId: DEMO_IDS.place1,
    sender: { kind: "human", humanId: DEMO_IDS.human2, actName: "Alex Rivera" },
    message:
      "Confirmed for the showcase — sending the tech rider and stage plot this week.",
    preferredDates: [isoDate(35)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-720),
    respondedAt: hoursFromNow(-700),
    genre: "Indie Rock",
    expectedDraw: 500,
    feeType: "GUARANTEE",
    feeAmountCents: 250000,
    calendarSlug: "live-music",
    agreement: {
      id: agreementId(4),
      status: "ACCEPTED",
      title: "Alex Rivera @ The Paramount Theatre",
      proposedDate: daysFromNow(35),
      guaranteeCents: 250000,
      attachDemoEvent: true,
    },
  },


  // ── RENT/USE (venue-confirmation-and-booking-intents Phase-2) ───────────
  {
    id: DEMO_IDS.rentBookingId as string,
    placeId: DEMO_IDS.demoVenueCheerUp,
    sender: { kind: "human", humanId: DEMO_IDS.human2, actName: "Alex Rivera" },
    message: "Looking to rent the inside space for a birthday show.",
    status: "PENDING",
    intent: "RENT",
    calendarSlug: "room-rental",
    spaceIndex: 0, // Inside space
    requestedStartsAt: daysFromNow(45),
    requestedEndsAt: daysFromNow(45),
    purpose: "Birthday show, private",
    expectedAttendance: 80,
  },
  {
    id: DEMO_IDS.useBookingId as string,
    placeId: DEMO_IDS.demoVenueCheerUp,
    sender: { kind: "human", humanId: DEMO_IDS.human4, actName: "Sam Okonkwo" },
    message: "Interested in using the outside space for a community gathering.",
    status: "PENDING",
    intent: "USE",
    calendarSlug: "room-rental",
    spaceIndex: 1, // Outside space
    requestedStartsAt: daysFromNow(50),
    requestedEndsAt: daysFromNow(50),
    purpose: "Monthly poetry reading",
    expectedAttendance: 30,
  },
  {
    id: DEMO_IDS.parkedBookingId as string,
    placeId: DEMO_IDS.unclaimedPlace,
    sender: {
      kind: "anon",
      contactName: "Jordan Smith",
      contactEmail: "jordan@example.com",
    },
    message: "Interested in booking this venue for a performance.",
    preferredDates: [isoDate(40)],
    // An unclaimed venue takes no requests (amendment 2026-09-25), so this
    // inquiry is the state a request parked there before it is left in:
    // EXPIRED by the cleanup, no parked stamp. Nothing writes
    // `parkedUnclaimedAt` any more, the seed included.
    status: "EXPIRED",
    intent: "PERFORM",
    source: "EMBED",
  },

  // ── CLOSED ──────────────────────────────────────────────────────────────
  {
    id: bookingId(8),
    placeId: DEMO_IDS.place1,
    sender: {
      kind: "human",
      humanId: DEMO_IDS.human7,
      actName: "Diego Alvarez",
    },
    message: "Any chance of a Friday in the fall?",
    preferredDates: [isoDate(15)],
    status: "DECLINED",
    viewedAt: hoursFromNow(-400),
    respondedAt: hoursFromNow(-390),
    declineReason:
      "We're fully booked through the fall — try us again for the spring calendar.",
    genre: "Latin Rock",
  },
  {
    id: bookingId(9),
    placeId: DEMO_IDS.demoVenueMohawk,
    sender: { kind: "human", humanId: DEMO_IDS.human3, actName: "Jamie Chen" },
    message: "Asking about the outdoor stage in July.",
    preferredDates: [isoDate(12)],
    status: "WITHDRAWN",
    viewedAt: hoursFromNow(-500),
    genre: "Synth Pop",
  },
  {
    id: bookingId(10),
    placeId: DEMO_IDS.demoVenueCheerUp,
    sender: {
      kind: "anon",
      contactName: "Priya Raman",
      contactEmail: "priya@example.com",
    },
    source: "EMBED",
    message: "Solo harpist, would love an early evening slot outside.",
    preferredDates: [isoDate(9)],
    status: "EXPIRED",
    genre: "Ambient",
  },
  {
    // Closed BY THE AGREEMENT, not by the request: the request is still
    // ACCEPTED, but the agreement was cancelled, so nothing will come of it.
    // The request status alone cannot express this.
    id: bookingId(11),
    placeId: DEMO_IDS.demoVenueHoleInWall,
    sender: { kind: "human", humanId: DEMO_IDS.human4, actName: "Sam Okonkwo" },
    message: "Second Hole in the Wall date — the one that fell through.",
    preferredDates: [isoDate(18)],
    status: "ACCEPTED",
    viewedAt: hoursFromNow(-620),
    respondedAt: hoursFromNow(-600),
    genre: "Soul",
    agreement: {
      id: agreementId(3),
      status: "CANCELLED",
      title: "Sam Okonkwo @ Hole in the Wall (cancelled)",
      proposedDate: daysFromNow(18),
    },
  },
];

export const ensureBookingRequests = async (prisma: PrismaClient) => {
  // Every fixture venue must exist and have a default calendar — the request's
  // calendar routing is required app-side for TO_VENUE rows. Resolve them
  // once rather than per fixture.
  const placeIds = [...new Set(FIXTURES.map((f) => f.placeId))];
  const calendars = await prisma.calendar.findMany({
    where: { placeId: { in: placeIds } },
    select: { id: true, placeId: true, slug: true, isDefault: true },
  });
  const calendarByPlace = new Map(
    calendars.filter((c) => c.isDefault).map((c) => [c.placeId, c.id]),
  );
  const calendarBySlug = new Map(
    calendars.map((c) => [`${c.placeId}:${c.slug}`, c.id]),
  );

  const spaces = await prisma.space.findMany({
    where: { placeId: { in: placeIds } },
    select: { id: true, placeId: true, sortOrder: true },
    orderBy: [{ placeId: "asc" }, { sortOrder: "asc" }],
  });
  const spacesByPlace = new Map<string, string[]>();
  for (const space of spaces) {
    const list = spacesByPlace.get(space.placeId) ?? [];
    list.push(space.id);
    spacesByPlace.set(space.placeId, list);
  }

  // One unclaimed demo-org event for the EVENT-stage fixture. `eventId` is
  // UNIQUE on Agreement, so an event another agreement already holds is not a
  // candidate; `null` simply means that fixture lands on Agreement instead.
  const claimedEventIds = (
    await prisma.agreement.findMany({
      where: { eventId: { not: null } },
      select: { eventId: true },
    })
  )
    .map((a) => a.eventId)
    .filter((id): id is string => id !== null);

  const attachableEvent = await prisma.event.findFirst({
    where: {
      orgId: DEMO_IDS.org,
      ...(claimedEventIds.length > 0
        ? { id: { notIn: claimedEventIds } }
        : {}),
    },
    // Prefer the venue the EVENT-stage fixture pitches, so the row reads
    // coherently; any demo-org event is an acceptable fallback.
    orderBy: [{ placeId: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  let created = 0;
  let skipped = 0;

  for (const fixture of FIXTURES) {
    // A named calendar when the fixture asks for one, else the venue default.
    // Falling back rather than skipping: a missing named calendar means the
    // place fixture changed, and routing to the default is a truthful state
    // the app can produce — an unrouted request is not.
    const calendarId = fixture.calendarSlug
      ? (calendarBySlug.get(`${fixture.placeId}:${fixture.calendarSlug}`) ??
        calendarByPlace.get(fixture.placeId))
      : calendarByPlace.get(fixture.placeId);
    if (!calendarId) {
      // A missing calendar means places seeded partially. Skip loudly rather
      // than writing a request with null routing that the inbox would then
      // render in a state the app can never produce.
      console.warn(
        `    ! skipping booking ${fixture.id.slice(-4)} — no default calendar for place ${fixture.placeId.slice(-4)}`,
      );
      skipped += 1;
      continue;
    }

    if (fixture.agreement) {
      const { agreement } = fixture;
      // Venue side is the counterparty on a TO_VENUE booking: the act
      // proposes, the venue's org answers.
      const proposer =
        fixture.sender.kind === "org"
          ? { type: "organization", id: fixture.sender.orgId }
          : fixture.sender.kind === "human"
            ? { type: "human", id: fixture.sender.humanId }
            : { type: "organization", id: DEMO_IDS.org };
      await prisma.agreement.upsert({
        where: { id: agreement.id },
        update: {
          status: agreement.status,
          title: agreement.title,
          proposedDate: agreement.proposedDate,
        },
        create: {
          id: agreement.id,
          type: "PERFORMANCE",
          status: agreement.status,
          proposerType: proposer.type,
          proposerId: proposer.id,
          counterpartyType: "organization",
          counterpartyId: DEMO_IDS.org,
          placeId: fixture.placeId,
          title: agreement.title,
          proposedDate: agreement.proposedDate,
          ...(agreement.guaranteeCents !== undefined
            ? { guaranteeCents: agreement.guaranteeCents }
            : {}),
          proposedAt: hoursFromNow(-180),
          ...(agreement.status === "ACCEPTED"
            ? { acceptedAt: hoursFromNow(-170) }
            : {}),
        },
      });

      if (agreement.attachDemoEvent && attachableEvent) {
        // Separate update, not part of the upsert payload: on a RESEED the
        // agreement already holds this event, and re-asserting it inside
        // `create` would never run while putting it in `update` is harmless
        // and idempotent.
        await prisma.agreement.update({
          where: { id: agreement.id },
          data: { eventId: attachableEvent.id },
        });
      }
    }

    const senderColumns =
      fixture.sender.kind === "anon"
        ? {
            performerOwnerType: null,
            performerOwnerId: null,
            contactName: fixture.sender.contactName,
            // Stored LOWERCASED app-side — the anonymous open-pair dedupe
            // index matches on lower(email).
            contactEmail: fixture.sender.contactEmail.toLowerCase(),
          }
        : {
            performerOwnerType:
              fixture.sender.kind === "org" ? "organization" : "human",
            performerOwnerId:
              fixture.sender.kind === "org"
                ? fixture.sender.orgId
                : fixture.sender.humanId,
            contactName: null,
            contactEmail: null,
          };

    // For RENT/USE: resolve space from spaceIndex, if provided
    let spaceId: string | null = null;
    if (fixture.spaceIndex !== undefined && fixture.spaceIndex >= 0) {
      const placeSpaces = spacesByPlace.get(fixture.placeId) ?? [];
      spaceId = placeSpaces[fixture.spaceIndex] ?? null;
    }

    const common = {
      direction: "TO_VENUE" as const,
      placeId: fixture.placeId,
      calendarId,
      ...senderColumns,
      // Anonymous inquiries pitch under a contact name, not an act name.
      actName:
        fixture.sender.kind === "anon" ? null : fixture.sender.actName,
      source: fixture.source ?? ("PLATFORM" as const),
      message: fixture.message,
      preferredDates: fixture.preferredDates ?? [],
      intent: fixture.intent ?? ("PERFORM" as const),
      spaceId: spaceId ?? undefined,
      requestedStartsAt: fixture.requestedStartsAt ?? undefined,
      requestedEndsAt: fixture.requestedEndsAt ?? undefined,
      purpose: fixture.purpose ?? undefined,
      expectedAttendance: fixture.expectedAttendance ?? undefined,
      status: fixture.status,
      genre: fixture.genre ?? null,
      expectedDraw: fixture.expectedDraw ?? null,
      feeType: fixture.feeType ?? null,
      feeAmountCents: fixture.feeAmountCents ?? null,
      feeCurrency: fixture.feeAmountCents !== undefined ? "usd" : null,
      viewedAt: fixture.viewedAt ?? null,
      respondedAt: fixture.respondedAt ?? null,
      declineReason: fixture.declineReason ?? null,
      agreementId: fixture.agreement?.id ?? null,
    };

    await prisma.bookingRequest.upsert({
      where: { id: fixture.id },
      // A re-seed clears any parked stamp an earlier seed wrote (amendment
      // 2026-09-25: nothing parks). Create leaves the column default (null).
      update: { ...common, parkedUnclaimedAt: null },
      create: { id: fixture.id, ...common },
    });
    created += 1;

    for (const hold of fixture.holds ?? []) {
      const placeSpaces = spacesByPlace.get(fixture.placeId) ?? [];
      const spaceId =
        hold.spaceIndex !== undefined
          ? (placeSpaces[hold.spaceIndex] ?? placeSpaces[0] ?? null)
          : null;
      const holdData = {
        bookingRequestId: fixture.id,
        calendarId,
        spaceId,
        date: hold.date,
        position: hold.position,
        status: hold.status,
        placedByHumanId: DEMO_IDS.devUser,
        challengedAt: hold.status === "CHALLENGED" ? hoursFromNow(-1) : null,
        respondBy: hold.respondBy ?? null,
      };
      await prisma.bookingHold.upsert({
        where: { id: hold.id },
        update: holdData,
        create: { id: hold.id, ...holdData },
      });
    }
  }

  return { created, skipped };
};
