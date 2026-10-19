import { describe, expect, it } from "vitest";

import {
  chunkIntoRows,
  selectBadgeRecipients,
  type BadgeRoleRow,
  type BadgeSignupRow,
} from "../badge-sheet-helpers";

/**
 * These helpers decide WHO gets a piece of credential stock. The assertions
 * that matter are therefore about exclusion and identity:
 *  - nothing but APPROVED reaches a badge,
 *  - one badge per HUMAN (the scan token is human+event scoped), and
 *  - a signup with no linked account is dropped LOUDLY, never silently.
 */

const signup = (over: Partial<BadgeSignupRow> & { id: string }): BadgeSignupRow => ({
  humanId: "human-1",
  roleId: "role-door",
  shiftId: "shift-evening",
  contactName: "Alex Martinez",
  contactEmail: "alex@example.com",
  status: "APPROVED",
  ...over,
});

const roles: BadgeRoleRow[] = [
  {
    id: "role-door",
    name: "Door",
    shifts: [
      {
        id: "shift-evening",
        label: "Evening",
        startsAt: new Date("2026-08-14T22:00:00Z"),
        endsAt: new Date("2026-08-15T03:00:00Z"),
      },
    ],
  },
  {
    id: "role-stage",
    name: "Stage Crew",
    shifts: [
      {
        id: "shift-load-in",
        label: "Load-in",
        startsAt: new Date("2026-08-14T18:00:00Z"),
        endsAt: new Date("2026-08-14T21:00:00Z"),
      },
    ],
  },
];

describe("selectBadgeRecipients", () => {
  it("issues to APPROVED signups and to nothing else", () => {
    const { recipients } = selectBadgeRecipients(
      [
        signup({ id: "s-approved", humanId: "h-approved", status: "APPROVED" }),
        signup({ id: "s-pending", humanId: "h-pending", status: "PENDING" }),
        signup({ id: "s-rejected", humanId: "h-rejected", status: "REJECTED" }),
        signup({
          id: "s-withdrawn",
          humanId: "h-withdrawn",
          status: "WITHDRAWN",
        }),
        // CHECKED_IN and NO_SHOW are "eligible" to the SCANNER, but
        // `mintVolunteerScanToken` refuses anything that is not APPROVED
        // (SIGNUP_NOT_APPROVED). Filtering here is what stops the run throwing
        // one row at a time instead of saying so cleanly.
        signup({ id: "s-in", humanId: "h-in", status: "CHECKED_IN" }),
        signup({ id: "s-noshow", humanId: "h-noshow", status: "NO_SHOW" }),
      ],
      roles,
    );

    expect(recipients.map((r) => r.humanId)).toEqual(["h-approved"]);
  });

  it("issues ONE badge per human, carrying every shift they are approved for", () => {
    // THE regression this block exists for. The scan token is human+event
    // scoped, and a person wears one badge — so a volunteer working two shifts
    // must not be handed two pieces of credential stock with the same code.
    const { recipients } = selectBadgeRecipients(
      [
        signup({ id: "s-door", roleId: "role-door", shiftId: "shift-evening" }),
        signup({
          id: "s-stage",
          roleId: "role-stage",
          shiftId: "shift-load-in",
        }),
      ],
      roles,
    );

    expect(recipients).toHaveLength(1);
    expect(recipients[0].assignments.map((a) => a.roleName)).toEqual([
      // Sorted by shift start: load-in (18:00) precedes the evening door
      // shift (22:00), which is the order the volunteer will work them.
      "Stage Crew",
      "Door",
    ]);
  });

  it("picks the mint signup deterministically (earliest shift), not by input order", () => {
    // Every APPROVED signup of this human mints the SAME human+event token, so
    // the choice only fixes which audit row records the issue — but it has to
    // be stable, or a refetch that reorders the roster scatters provenance
    // across rows for no reason.
    const forward = selectBadgeRecipients(
      [
        signup({ id: "s-door", roleId: "role-door", shiftId: "shift-evening" }),
        signup({ id: "s-stage", roleId: "role-stage", shiftId: "shift-load-in" }),
      ],
      roles,
    );
    const reversed = selectBadgeRecipients(
      [
        signup({ id: "s-stage", roleId: "role-stage", shiftId: "shift-load-in" }),
        signup({ id: "s-door", roleId: "role-door", shiftId: "shift-evening" }),
      ],
      roles,
    );

    expect(forward.recipients[0].mintSignupId).toBe("s-stage");
    expect(reversed.recipients[0].mintSignupId).toBe("s-stage");
  });

  it("counts signups with no linked account instead of dropping them silently", () => {
    // A signup with no `humanId` cannot mint at all (SIGNUP_MISSING_HUMAN), so
    // it gets no badge. Losing a person from a credential run without saying
    // so is a failure nobody sees until the door.
    const { recipients, unissuableCount } = selectBadgeRecipients(
      [
        signup({ id: "s-ok", humanId: "h-ok" }),
        signup({ id: "s-orphan", humanId: null }),
      ],
      roles,
    );

    expect(recipients).toHaveLength(1);
    expect(unissuableCount).toBe(1);
  });

  it("prefers a name supplied on any of a volunteer's signups over their email", () => {
    const { recipients } = selectBadgeRecipients(
      [
        signup({
          id: "s-first",
          contactName: null,
          contactEmail: "jules@example.com",
          roleId: "role-door",
          shiftId: "shift-evening",
        }),
        signup({
          id: "s-second",
          contactName: "Jules Okafor",
          contactEmail: "jules@example.com",
          roleId: "role-stage",
          shiftId: "shift-load-in",
        }),
      ],
      roles,
    );

    expect(recipients[0].name).toBe("Jules Okafor");
  });

  it("falls back to the contact email when no signup carries a name", () => {
    const { recipients } = selectBadgeRecipients(
      [signup({ id: "s1", contactName: "   ", contactEmail: "sam@example.com" })],
      roles,
    );

    expect(recipients[0].name).toBe("sam@example.com");
  });

  it("orders the run alphabetically — a badge stack is found by name", () => {
    const { recipients } = selectBadgeRecipients(
      [
        signup({ id: "s1", humanId: "h1", contactName: "zoe rivera" }),
        signup({ id: "s2", humanId: "h2", contactName: "Alex Martinez" }),
        signup({ id: "s3", humanId: "h3", contactName: "mira Sen" }),
      ],
      roles,
    );

    expect(recipients.map((r) => r.name)).toEqual([
      "Alex Martinez",
      "mira Sen",
      "zoe rivera",
    ]);
  });

  it("still issues to a signup whose role or shift no longer resolves", () => {
    // The badge is the person's authorization; a role row deleted out from
    // under an approved signup is a data problem, not a reason to leave
    // somebody standing at a door without a credential.
    const { recipients } = selectBadgeRecipients(
      [signup({ id: "s1", roleId: "role-gone", shiftId: "shift-gone" })],
      roles,
    );

    expect(recipients).toHaveLength(1);
    expect(recipients[0].assignments[0].roleName).toBeNull();
    expect(recipients[0].assignments[0].startsAt).toBeNull();
  });
});

describe("chunkIntoRows", () => {
  it("fills rows left to right and leaves a short final row short", () => {
    expect(chunkIntoRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no rows for an empty run", () => {
    expect(chunkIntoRows([], 2)).toEqual([]);
  });

  it("refuses a nonsensical row width rather than looping forever", () => {
    expect(() => chunkIntoRows([1], 0)).toThrow();
  });
});
