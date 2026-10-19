import { describe, expect, it, vi } from "vitest";

import { makeVolunteeringRepo } from "../volunteering";

// A CONTACT-ONLY signup (anonymous signup naming an email that already has
// an account) has humanId NULL, and so does its VolunteerWaiverAcceptance
// row. The roster badge is the PRESENCE of that 1:1 acceptance relation, so
// it must still read "accepted" — never "no waiver" — for these signups.

describe("roster waiver badge for a contact-only signup", () => {
  it("reports waiverAccepted: true when the acceptance row exists, with humanId null", async () => {
    const now = new Date("2026-09-29T00:00:00.000Z");
    const findMany = vi.fn(async (_query: unknown) => [
      {
        id: "s1",
        eventId: null,
        askId: "a1",
        roleId: "r1",
        shiftId: null,
        groupId: null,
        humanId: null,
        contactEmail: "someone@example.org",
        contactName: "Someone",
        contactPhone: null,
        smsOptIn: false,
        status: "PENDING",
        hoursWorked: null,
        answers: {},
        reviewerHumanId: null,
        reviewedAt: null,
        checkedInAt: null,
        waiverAcceptance: { acceptedAt: now },
        notes: null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const count = vi.fn(async () => 1);
    const repo = makeVolunteeringRepo({
      volunteerSignup: { findMany, count },
    } as never);

    const page = await repo.listSignupsByAsk("a1");
    const [record] = page.items;

    expect(record?.humanId).toBeNull();
    expect(record?.waiverAccepted).toBe(true);
    expect(record?.waiverAcceptedAt).toEqual(now);
    // The badge reads the relation — make sure the query still selects it.
    const query = findMany.mock.calls[0]?.[0] as { select: Record<string, unknown> };
    expect(query.select.waiverAcceptance).toBeTruthy();
  });
});
