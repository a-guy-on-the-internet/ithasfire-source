import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
} from "@th/ports/repos/volunteering";

import {
  listPublicEventVolunteerRoles,
  type ListPublicEventVolunteerRolesDeps,
} from "./list-public-event-volunteer-roles";

// ── Constants ────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const ROLE_ID_2 = "00000000-0000-4000-8000-000000000011";
const SHIFT_ID = "00000000-0000-4000-8000-000000000030";
const SHIFT_ID_2 = "00000000-0000-4000-8000-000000000031";
const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: null,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  timezone: "UTC",
  startsAt: new Date("2026-07-01T18:00:00Z"),
  endsAt: new Date("2026-07-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  locality: null,
  region: null,
  countryCode: null,
  postalCode: null,
  shortId: null,
  slug: null,
  regionCode: null,
  publishedAt: null,
  currency: "usd",
  heroImageUrl: null,
  content: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  refundCutoffAt: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  placeLayoutId: null,
  volunteeringEnabled: true,
  volunteerAutoApprove: false,
  volunteerIntroText: "Help us make it great",
  createdAt: NOW,
  updatedAt: NOW,
} as EventRecord;

const baseShift: VolunteerShiftRecord = {
  id: SHIFT_ID,
  roleId: ROLE_ID,
  label: "Morning",
  startsAt: new Date("2026-07-01T18:00:00Z"),
  endsAt: new Date("2026-07-01T21:00:00Z"),
  capacity: 5,
  notes: "Admin-only notes",
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const secondShift: VolunteerShiftRecord = {
  ...baseShift,
  id: SHIFT_ID_2,
  label: "Evening",
  sortOrder: 1,
};

const baseRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: EVENT_ID,
  templateId: "00000000-0000-4000-8000-0000000000aa",
  name: "Security",
  description: "Keep things safe",
  capacity: 10,
  autoApprove: true,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [baseShift, secondShift],
};

const secondRole: EventVolunteerRoleWithShiftsRecord = {
  ...baseRole,
  id: ROLE_ID_2,
  name: "Bar",
  shifts: [],
  sortOrder: 1,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

type TxOverrides = {
  event?: EventRecord | null;
  roles?: EventVolunteerRoleWithShiftsRecord[];
  countByRole?: Record<string, number>;
  countByShiftForEvent?: Record<string, number>;
  countAcceptedByRole?: Record<string, number>;
  countAcceptedByShiftForEvent?: Record<string, number>;
};

function makeDeps(overrides: TxOverrides = {}) {
  const event = overrides.event === undefined ? baseEvent : overrides.event;
  const roles = overrides.roles ?? [baseRole, secondRole];
  const countByRole = overrides.countByRole ?? {};
  const countByShiftForEvent = overrides.countByShiftForEvent ?? {};
  const countAcceptedByRole = overrides.countAcceptedByRole ?? {};
  const countAcceptedByShiftForEvent =
    overrides.countAcceptedByShiftForEvent ?? {};

  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
    },
    volunteering: {
      listEventRoles: vi.fn(async () => roles),
      countByRole: vi.fn(async () => countByRole),
      countByShiftForEvent: vi.fn(async () => countByShiftForEvent),
      countAcceptedByRole: vi.fn(async () => countAcceptedByRole),
      countAcceptedByShiftForEvent: vi.fn(
        async () => countAcceptedByShiftForEvent,
      ),
    },
  };

  const txSpy = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
    fn(txRepos as unknown as TxRepos),
  );

  const deps: ListPublicEventVolunteerRolesDeps = {
    repos: { tx: txSpy } as unknown as Repos,
  };

  return { deps, txRepos, txSpy };
}

// ══════════════════════════════════════════════════════════════════════════════
// Visibility gate
// ══════════════════════════════════════════════════════════════════════════════

describe("listPublicEventVolunteerRoles — visibility gate", () => {
  const validInput = { eventId: EVENT_ID };

  it("throws not_found when the event does not exist", async () => {
    const { deps } = makeDeps({ event: null });
    await expect(
      listPublicEventVolunteerRoles(deps, validInput),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws not_found when volunteering is disabled", async () => {
    const { deps } = makeDeps({
      event: { ...baseEvent, volunteeringEnabled: false } as EventRecord,
    });
    await expect(
      listPublicEventVolunteerRoles(deps, validInput),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws not_found when the event is a draft", async () => {
    const { deps } = makeDeps({
      event: { ...baseEvent, status: "DRAFT" } as EventRecord,
    });
    await expect(
      listPublicEventVolunteerRoles(deps, validInput),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws not_found when the event is cancelled", async () => {
    const { deps } = makeDeps({
      event: { ...baseEvent, status: "CANCELLED" } as EventRecord,
    });
    await expect(
      listPublicEventVolunteerRoles(deps, validInput),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Happy path
// ══════════════════════════════════════════════════════════════════════════════

describe("listPublicEventVolunteerRoles — happy path", () => {
  const validInput = { eventId: EVENT_ID };

  it("returns intro text and a public role list", async () => {
    const { deps } = makeDeps();
    const result = await listPublicEventVolunteerRoles(deps, validInput);

    expect(result.introText).toBe("Help us make it great");
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0]).toMatchObject({
      id: ROLE_ID,
      name: "Security",
      description: "Keep things safe",
      capacity: 10,
      sortOrder: 0,
    });
  });

  it("does NOT expose admin-only fields on roles or shifts", async () => {
    const { deps } = makeDeps();
    const result = await listPublicEventVolunteerRoles(deps, validInput);

    const role = result.roles[0]!;
    // Admin-only role fields must not be present.
    expect(role).not.toHaveProperty("autoApprove");
    expect(role).not.toHaveProperty("templateId");
    expect(role).not.toHaveProperty("createdAt");
    expect(role).not.toHaveProperty("updatedAt");

    const shift = role.shifts[0]!;
    // Admin-only shift fields must not be present.
    expect(shift).not.toHaveProperty("notes");
    expect(shift).not.toHaveProperty("createdAt");
    expect(shift).not.toHaveProperty("updatedAt");
    expect(shift).not.toHaveProperty("roleId");
  });

  it("populates signupCount from role and shift count maps", async () => {
    const { deps } = makeDeps({
      countByRole: { [ROLE_ID]: 3, [ROLE_ID_2]: 0 },
      countByShiftForEvent: { [SHIFT_ID]: 2, [SHIFT_ID_2]: 1 },
    });
    const result = await listPublicEventVolunteerRoles(deps, validInput);

    expect(result.roles[0]!.signupCount).toBe(3);
    expect(result.roles[1]!.signupCount).toBe(0);
    expect(result.roles[0]!.shifts[0]!.signupCount).toBe(2);
    expect(result.roles[0]!.shifts[1]!.signupCount).toBe(1);
  });

  it("defaults missing counts to 0", async () => {
    const { deps } = makeDeps({ countByRole: {}, countByShiftForEvent: {} });
    const result = await listPublicEventVolunteerRoles(deps, validInput);

    expect(result.roles[0]!.signupCount).toBe(0);
    expect(result.roles[0]!.shifts[0]!.signupCount).toBe(0);
    expect(result.roles[0]!.acceptedCount).toBe(0);
    expect(result.roles[0]!.shifts[0]!.acceptedCount).toBe(0);
  });

  it("populates acceptedCount separately from pending-inclusive signupCount", async () => {
    // Pending signups inflate signupCount but never acceptedCount — the
    // public form keys "Full — you'll be waitlisted" off acceptedCount.
    const { deps } = makeDeps({
      countByRole: { [ROLE_ID]: 7, [ROLE_ID_2]: 2 },
      countByShiftForEvent: { [SHIFT_ID]: 5, [SHIFT_ID_2]: 3 },
      countAcceptedByRole: { [ROLE_ID]: 4 },
      countAcceptedByShiftForEvent: { [SHIFT_ID]: 2 },
    });
    const result = await listPublicEventVolunteerRoles(deps, validInput);

    expect(result.roles[0]!.signupCount).toBe(7);
    expect(result.roles[0]!.acceptedCount).toBe(4);
    expect(result.roles[1]!.signupCount).toBe(2);
    expect(result.roles[1]!.acceptedCount).toBe(0);

    expect(result.roles[0]!.shifts[0]!.signupCount).toBe(5);
    expect(result.roles[0]!.shifts[0]!.acceptedCount).toBe(2);
    expect(result.roles[0]!.shifts[1]!.signupCount).toBe(3);
    expect(result.roles[0]!.shifts[1]!.acceptedCount).toBe(0);
  });

  it("runs all reads inside a single repos.tx()", async () => {
    const { deps, txSpy } = makeDeps();
    await listPublicEventVolunteerRoles(deps, validInput);
    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});
