import { describe, expect, it, vi } from "vitest";

import { makeVolunteeringRepo } from "../volunteering";

// VolunteerAsk.timezone is the IANA zone the organiser stated the window
// in. The adapter must write it on create, patch it on update (undefined =
// untouched, null = clear), select it on every ask read, and map it.

const NOW = new Date("2026-10-13T00:00:00.000Z");

function askRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    subjectType: "PLACE",
    subjectId: "p1",
    orgId: null,
    title: "Door help",
    description: null,
    status: "DRAFT",
    cadence: "ONE_TIME",
    startsAt: new Date("2026-11-01T23:00:00.000Z"),
    endsAt: new Date("2026-11-02T02:00:00.000Z"),
    timezone: "America/Chicago",
    capacity: null,
    autoApprove: false,
    waiverRequired: false,
    waiverTemplateId: null,
    smsOptInEnabled: false,
    formSchema: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type Query = { data: Record<string, unknown>; select: Record<string, unknown> };

describe("volunteer ask timezone (adapter mapping)", () => {
  it("writes, selects and maps the zone on create", async () => {
    const create = vi.fn(async (_q: Query) => askRow());
    const repo = makeVolunteeringRepo({ volunteerAsk: { create } } as never);

    const record = await repo.createAsk({
      subjectType: "PLACE",
      subjectId: "p1",
      title: "Door help",
      timezone: "America/Chicago",
    });

    const query = create.mock.calls[0]![0];
    expect(query.data.timezone).toBe("America/Chicago");
    expect(query.select.timezone).toBe(true);
    expect(record.timezone).toBe("America/Chicago");
  });

  it("writes null on create when no zone is given", async () => {
    const create = vi.fn(async (_q: Query) => askRow({ timezone: null }));
    const repo = makeVolunteeringRepo({ volunteerAsk: { create } } as never);

    const record = await repo.createAsk({
      subjectType: "PLACE",
      subjectId: "p1",
      title: "Door help",
    });

    expect(create.mock.calls[0]![0].data.timezone).toBeNull();
    expect(record.timezone).toBeNull();
  });

  it("patches the zone on update only when present, and clears it with null", async () => {
    const update = vi.fn(async (_q: Query) => askRow({ timezone: null }));
    const repo = makeVolunteeringRepo({ volunteerAsk: { update } } as never);

    await repo.updateAsk("a1", { title: "Renamed" });
    expect(update.mock.calls[0]![0].data).not.toHaveProperty("timezone");

    const cleared = await repo.updateAsk("a1", { timezone: null });
    expect(update.mock.calls[1]![0].data.timezone).toBeNull();
    expect(cleared.timezone).toBeNull();
  });

  it("returns the zone from getAsk", async () => {
    const findUnique = vi.fn(async (_q: { select: Record<string, unknown> }) =>
      askRow({ timezone: "Europe/Berlin" }),
    );
    const repo = makeVolunteeringRepo({
      volunteerAsk: { findUnique },
    } as never);

    const record = await repo.getAsk("a1");
    expect(findUnique.mock.calls[0]![0].select.timezone).toBe(true);
    expect(record?.timezone).toBe("Europe/Berlin");
  });
});

// ── /my-volunteering commitments: the ask's zone fills `eventTimezone` ──

function signupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s-ask",
    status: "APPROVED",
    eventId: null,
    askId: "a1",
    hoursWorked: null,
    checkedInAt: null,
    createdAt: NOW,
    event: null,
    ask: {
      title: "Door help",
      cadence: "ONE_TIME",
      startsAt: new Date("2026-11-01T23:00:00.000Z"),
      endsAt: new Date("2026-11-02T02:00:00.000Z"),
      timezone: "America/Chicago",
    },
    role: { name: "Door" },
    shift: null,
    ...overrides,
  };
}

function claimRow(askTimezone: string | null) {
  return {
    id: "c1",
    status: "CLAIMED",
    checkedInAt: null,
    hoursWorked: null,
    createdAt: NOW,
    occurrence: {
      id: "o1",
      askId: "a2",
      startsAt: new Date("2026-11-03T23:00:00.000Z"),
      endsAt: new Date("2026-11-04T02:00:00.000Z"),
      status: "SCHEDULED",
      role: { name: "Bar" },
      ask: { title: "Standing bar crew", cadence: "ONGOING", timezone: askTimezone },
    },
    signup: { id: "s-occ", status: "APPROVED", eventId: null },
  };
}

function commitmentsRepo(signups: unknown[], claims: unknown[]) {
  const signupFindMany = vi.fn(
    async (_q: { select: Record<string, any> }) => signups,
  );
  let claimCall = 0;
  const claimFindMany = vi.fn(
    async (_q: { select: Record<string, any> }) =>
      // upcoming bucket first, then past: hand every claim to the first.
      claimCall++ === 0 ? claims : [],
  );
  const repo = makeVolunteeringRepo({
    volunteerSignup: { findMany: signupFindMany },
    volunteerOccurrenceClaim: { findMany: claimFindMany },
  } as never);
  return { repo, signupFindMany, claimFindMany };
}

describe("commitments carry the ask's stated zone", () => {
  const now = new Date("2026-10-13T00:00:00.000Z");

  it("selects the ask zone on both the signup and the claim projections", async () => {
    const { repo, signupFindMany, claimFindMany } = commitmentsRepo([], []);
    await repo.listCommitmentsByHuman("h1", now);
    expect(signupFindMany.mock.calls[0]![0].select.ask.select.timezone).toBe(
      true,
    );
    expect(
      claimFindMany.mock.calls[0]![0].select.occurrence.select.ask.select
        .timezone,
    ).toBe(true);
  });

  it("fills an ask-path row from the ask's zone", async () => {
    const { repo } = commitmentsRepo([signupRow()], []);
    const [row] = await repo.listCommitmentsByHuman("h1", now);
    expect(row?.source).toBe("ASK_WINDOW");
    expect(row?.eventTimezone).toBe("America/Chicago");
  });

  it("prefers the ask's zone over the event's on an ask-path row, and falls back to the event's when the ask has none", async () => {
    const event = {
      title: "Night Market",
      slug: "night-market",
      timezone: "America/New_York",
      addressText: null,
    };
    const { repo } = commitmentsRepo(
      [
        signupRow({ id: "s1", eventId: "e1", event }),
        signupRow({
          id: "s2",
          eventId: "e1",
          event,
          ask: { ...signupRow().ask, timezone: null },
        }),
      ],
      [],
    );
    const rows = await repo.listCommitmentsByHuman("h1", now);
    const byId = Object.fromEntries(rows.map((r) => [r.signupId, r]));
    expect(byId.s1?.eventTimezone).toBe("America/Chicago");
    expect(byId.s2?.eventTimezone).toBe("America/New_York");
  });

  it("keeps null on an ask-path row when neither the ask nor an event states a zone", async () => {
    const { repo } = commitmentsRepo(
      [signupRow({ ask: { ...signupRow().ask, timezone: null } })],
      [],
    );
    const [row] = await repo.listCommitmentsByHuman("h1", now);
    expect(row?.eventTimezone).toBeNull();
  });

  it("keeps the event's zone on a shift-path row even when the ask states one", async () => {
    const { repo } = commitmentsRepo(
      [
        signupRow({
          eventId: "e1",
          event: {
            title: "Night Market",
            slug: "night-market",
            timezone: "America/New_York",
            addressText: null,
          },
          shift: {
            label: "Early",
            startsAt: new Date("2026-11-01T22:00:00.000Z"),
            endsAt: new Date("2026-11-02T01:00:00.000Z"),
          },
        }),
      ],
      [],
    );
    const [row] = await repo.listCommitmentsByHuman("h1", now);
    expect(row?.source).toBe("EVENT_SHIFT");
    expect(row?.eventTimezone).toBe("America/New_York");
  });

  it("fills an occurrence row from its ask's zone, null when the ask has none", async () => {
    const stated = commitmentsRepo([], [claimRow("Europe/Berlin")]);
    const [withZone] = await stated.repo.listCommitmentsByHuman("h1", now);
    expect(withZone?.occurrenceId).toBe("o1");
    expect(withZone?.eventTimezone).toBe("Europe/Berlin");

    const zoneless = commitmentsRepo([], [claimRow(null)]);
    const [withoutZone] = await zoneless.repo.listCommitmentsByHuman("h1", now);
    expect(withoutZone?.eventTimezone).toBeNull();
  });

  it("leaves the .ics feed unchanged: ask-path rows still carry no zone", async () => {
    const findMany = vi.fn(async (q: { where: Record<string, unknown> }) =>
      "shiftId" in q.where ? [signupRow()] : [],
    );
    const repo = makeVolunteeringRepo({
      volunteerSignup: { findMany },
    } as never);
    const [row] = await repo.listUpcomingSignupsForFeed("h1", now);
    expect(row?.source).toBe("ASK_WINDOW");
    expect(row?.eventTimezone).toBeNull();
  });
});
