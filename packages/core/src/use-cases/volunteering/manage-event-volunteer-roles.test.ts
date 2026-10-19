import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleRecord,
  EventVolunteerRoleWithShiftsRecord,
  RoleTemplateRecord,
} from "@th/ports/repos/volunteering";
import {
  createEventVolunteerRole,
  createFromTemplates,
  updateEventVolunteerRole,
  deleteEventVolunteerRole,
  listEventVolunteerRoles,
} from "./manage-event-volunteer-roles";
import type { ManageEventVolunteerRolesDeps } from "./manage-event-volunteer-roles";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000020";
const PLATFORM_TEMPLATE_ID = "00000000-0000-4000-8000-000000000021";
const OTHER_ORG_TEMPLATE_ID = "00000000-0000-4000-8000-000000000022";
const DRAFT_TEMPLATE_ID = "00000000-0000-4000-8000-000000000023";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000024";
const LIVE_PACK_ID = "00000000-0000-4000-8000-000000000025";
const DRAFT_PACK_ID = "00000000-0000-4000-8000-000000000026";
const EVENT_ASK_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
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
  createdAt: NOW,
  updatedAt: NOW,
} as EventRecord;

const baseRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: EVENT_ID,
  templateId: null,
  name: "Security",
  description: "Event security",
  capacity: 10,
  autoApprove: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const baseTemplate: RoleTemplateRecord = {
  id: TEMPLATE_ID,
  orgId: ORG_ID,
  name: "Bar Staff",
  description: "Serve drinks",
  defaultCapacity: 8,
  sortOrder: 0,
  archived: false,
  isPlatform: false,
  packId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** LIVE platform catalogue row: no owning org, read-only, pack-backed. */
const platformTemplate: RoleTemplateRecord = {
  ...baseTemplate,
  id: PLATFORM_TEMPLATE_ID,
  orgId: null,
  name: "Door (Ithas Fire)",
  description: "Greet and check tickets",
  defaultCapacity: 2,
  isPlatform: true,
  packId: LIVE_PACK_ID,
};

/** Another org's private template — must stay unreachable from this event. */
const otherOrgTemplate: RoleTemplateRecord = {
  ...baseTemplate,
  id: OTHER_ORG_TEMPLATE_ID,
  orgId: OTHER_ORG_ID,
  name: "Their Bar Staff",
};

/** Platform row under a pack that has NOT been published yet. */
const draftPackTemplate: RoleTemplateRecord = {
  ...platformTemplate,
  id: DRAFT_TEMPLATE_ID,
  name: "Unpublished role",
  packId: DRAFT_PACK_ID,
};

/**
 * Stands in for the adapter's `getRoleTemplateUsableBy` tenancy rule rather
 * than blindly returning a row, so these tests exercise the real "which
 * templates can this event reach" contract: own-org rows, plus platform
 * rows whose pack is LIVE, and nothing else.
 */
function fakeUsableBy(
  rows: RoleTemplateRecord[] = [
    baseTemplate,
    platformTemplate,
    otherOrgTemplate,
    draftPackTemplate,
  ],
  livePackIds: readonly string[] = [LIVE_PACK_ID],
) {
  return vi.fn(async (id: string, orgId: string | null) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return null;
    if (row.isPlatform) {
      return row.orgId === null &&
        row.packId !== null &&
        livePackIds.includes(row.packId)
        ? row
        : null;
    }
    return orgId !== null && row.orgId === orgId ? row : null;
  });
}

/** Backfilled EVENT-subject ask for `baseEvent` (A1 migration shape). */
const baseEventAsk = {
  id: EVENT_ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: EVENT_ID,
  orgId: ORG_ID,
  title: "Summer Fest",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: true,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    volunteering: {
      // Event-path role creates resolve (or lazily create) the event's
      // EVENT-subject ask to stamp askId (A4). The lazy insert goes through
      // the race-safe createAskIfAbsent + re-read, never createAsk.
      listAsksBySubject: vi.fn(async () => [baseEventAsk]),
      createAskIfAbsent: vi.fn(async () => undefined),
      createEventRole: vi.fn(async (input: any) => ({
        ...baseRole,
        ...input,
        id: ROLE_ID,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      updateEventRole: vi.fn(async (id: string, input: any) => ({
        ...baseRole,
        ...input,
        id,
      })),
      deleteEventRole: vi.fn(async () => undefined),
      listEventRoles: vi.fn(async () => [baseRole]),
      getEventRole: vi.fn(async () => baseRole),
      getRoleTemplate: vi.fn(async () => baseTemplate),
      getRoleTemplateUsableBy: fakeUsableBy(),
      createRoleTemplate: vi.fn(),
      updateRoleTemplate: vi.fn(),
      archiveRoleTemplate: vi.fn(),
      listRoleTemplates: vi.fn(async () => []),
      upsertRoleTemplateShifts: vi.fn(async () => []),
      listRoleTemplateShifts: vi.fn(async () => []),
      getRoleTemplateWithShifts: vi.fn(async () => null),
      listRoleTemplateShiftsByTemplateIds: vi.fn(async () => ({})),
      getShift: vi.fn(),
      createShift: vi.fn(),
      updateShift: vi.fn(),
      deleteShift: vi.fn(),
      listShifts: vi.fn(),
      createSignup: vi.fn(),
      updateSignupStatus: vi.fn(),
      getSignup: vi.fn(),
      getSignupByEmail: vi.fn(),
      listSignups: vi.fn(),
      listSignupsByHuman: vi.fn(),
      countByRole: vi.fn(),
      countByShift: vi.fn(),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(
  txOverrides: Record<string, unknown> = {},
): ManageEventVolunteerRolesDeps {
  const txRepos = makeTxRepos(txOverrides);
  return {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: ManageEventVolunteerRolesDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

// ══════════════════════════════════════════════════════════════════════════════
// createEventVolunteerRole
// ══════════════════════════════════════════════════════════════════════════════

describe("createEventVolunteerRole", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    name: "Security",
    description: "Event security",
    capacity: 10,
  };

  it("creates a role and returns it", async () => {
    const deps = makeDeps();
    const result = await createEventVolunteerRole(deps, validInput);

    expect(result).toMatchObject({ id: ROLE_ID, eventId: EVENT_ID });
  });

  it("rejects when event not found", async () => {
    const deps = makeDeps({
      events: { getById: vi.fn(async () => null) },
    });

    await expect(
      createEventVolunteerRole(deps, validInput),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects when actor lacks EDIT role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(
      createEventVolunteerRole(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("uses template defaults when templateId is provided", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await createEventVolunteerRole(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      templateId: TEMPLATE_ID,
      name: "Custom Name",
    });

    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        name: "Custom Name",
        description: "Serve drinks", // from template
        capacity: 8, // from template
      }),
    );
  });

  it("rejects when template not found", async () => {
    const deps = makeDeps();
    // Override the template lookup so nothing resolves
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getRoleTemplateUsableBy = fakeUsableBy([]);
    const overrideDeps: ManageEventVolunteerRolesDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(
      createEventVolunteerRole(overrideDeps, {
        ...validInput,
        templateId: TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("logs audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createEventVolunteerRole(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_volunteer_role",
        action: "created",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// createFromTemplates
// ══════════════════════════════════════════════════════════════════════════════

describe("createFromTemplates", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    templateIds: [TEMPLATE_ID],
  };

  it("creates roles from templates and returns them under `roles`", async () => {
    const deps = makeDeps();
    const result = await createFromTemplates(deps, validInput);

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({ name: "Bar Staff" });
    expect(result.templateShiftsByRoleId).toEqual({ [ROLE_ID]: [] });
  });

  it("returns template shift presets keyed by created role id", async () => {
    const templateShift = {
      id: "shift-1",
      templateId: TEMPLATE_ID,
      label: "Setup",
      startMinuteOfDay: 16 * 60,
      endMinuteOfDay: 18 * 60 + 30,
      startDayOffset: 0,
      endsNextDay: false,
      capacity: 2,
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    // Build the deps with a custom listRoleTemplateShiftsByTemplateIds spy
    // by patching after construction — `makeDeps`'s override replaces the
    // whole `volunteering` namespace, which would drop the other mocks.
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos as any).volunteering.listRoleTemplateShiftsByTemplateIds = vi.fn(
      async () => ({ [TEMPLATE_ID]: [templateShift] }),
    );
    const result = await createFromTemplates(deps, validInput);

    expect(result.roles).toHaveLength(1);
    expect(result.templateShiftsByRoleId[ROLE_ID]).toEqual([templateShift]);
  });

  it("echoes the event's startsAt so the UI can decide on the today fallback", async () => {
    const startsAt = new Date("2026-08-15T19:00:00.000Z");
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos as any).events.getById = vi.fn(async () => ({
      id: EVENT_ID,
      orgId: ORG_ID,
      startsAt,
    }));
    const result = await createFromTemplates(deps, validInput);
    expect(result.eventStartsAt).toEqual(startsAt);
  });

  it("rejects when a template is not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getRoleTemplateUsableBy = fakeUsableBy([]);
    const deps: ManageEventVolunteerRolesDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(createFromTemplates(deps, validInput)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects invalid input (empty templateIds)", async () => {
    const deps = makeDeps();
    await expect(
      createFromTemplates(deps, { ...validInput, templateIds: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cross-tenant apply rules (FR-010 / NFR-002)
// ══════════════════════════════════════════════════════════════════════════════

describe("applying templates to an event — tenancy", () => {
  it("applies a LIVE platform role to the event", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    const result = await createFromTemplates(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      templateIds: [PLATFORM_TEMPLATE_ID],
    });

    expect(result.roles).toHaveLength(1);
    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: PLATFORM_TEMPLATE_ID,
        name: "Door (Ithas Fire)",
        description: "Greet and check tickets",
        capacity: 2,
      }),
    );
  });

  it("refuses ANOTHER org's template on the same event, with no signal it exists", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await expect(
      createFromTemplates(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        templateIds: [OTHER_ORG_TEMPLATE_ID],
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    // Same code as a template that simply doesn't exist, and nothing written.
    expect((txRepos.volunteering as any).createEventRole).not.toHaveBeenCalled();
    // …and the foreign template's shifts were never even READ. The batch
    // prefetch sits AFTER the tenancy loop precisely so a refused id never
    // reaches it; asserting "not written" alone would still pass if the
    // prefetch ran first and the response merely filtered the result.
    expect(
      (txRepos.volunteering as any).listRoleTemplateShiftsByTemplateIds,
    ).not.toHaveBeenCalled();
  });

  it("refuses ANOTHER org's template on the single-role create path too", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await expect(
      createEventVolunteerRole(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        name: "Bar",
        templateId: OTHER_ORG_TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect((txRepos.volunteering as any).createEventRole).not.toHaveBeenCalled();
  });

  it("refuses a platform role whose pack is still DRAFT", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await expect(
      createFromTemplates(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        templateIds: [DRAFT_TEMPLATE_ID],
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect((txRepos.volunteering as any).createEventRole).not.toHaveBeenCalled();
    // Unpublished catalogue content is not read either, same reasoning as
    // the foreign-org case above.
    expect(
      (txRepos.volunteering as any).listRoleTemplateShiftsByTemplateIds,
    ).not.toHaveBeenCalled();
  });

  it("scopes every template lookup by the event's org", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await createFromTemplates(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      templateIds: [TEMPLATE_ID],
    });

    expect(
      (txRepos.volunteering as any).getRoleTemplateUsableBy,
    ).toHaveBeenCalledWith(TEMPLATE_ID, ORG_ID);
  });

  it("prefetches shifts exactly once on the happy path (no N+1, NFR-003)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await createFromTemplates(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      templateIds: [TEMPLATE_ID, PLATFORM_TEMPLATE_ID],
    });

    expect(
      (txRepos.volunteering as any).listRoleTemplateShiftsByTemplateIds,
    ).toHaveBeenCalledTimes(1);
    expect(
      (txRepos.volunteering as any).listRoleTemplateShiftsByTemplateIds,
    ).toHaveBeenCalledWith([TEMPLATE_ID, PLATFORM_TEMPLATE_ID]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// updateEventVolunteerRole
// ══════════════════════════════════════════════════════════════════════════════

describe("updateEventVolunteerRole", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: ROLE_ID,
    name: "Updated Security",
  };

  it("updates a role and returns it", async () => {
    const deps = makeDeps();
    const result = await updateEventVolunteerRole(deps, validInput);

    expect(result).toMatchObject({ id: ROLE_ID, name: "Updated Security" });
  });

  it("rejects when role not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => null);
    const deps: ManageEventVolunteerRolesDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(
      updateEventVolunteerRole(deps, validInput),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("rejects when actor lacks role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "SCANNER" })) },
    });

    await expect(
      updateEventVolunteerRole(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// deleteEventVolunteerRole
// ══════════════════════════════════════════════════════════════════════════════

describe("deleteEventVolunteerRole", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: ROLE_ID,
  };

  it("deletes a role", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await deleteEventVolunteerRole(deps, validInput);

    expect((txRepos.volunteering as any).deleteEventRole).toHaveBeenCalledWith(
      ROLE_ID,
    );
  });

  it("rejects when role not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => null);
    const deps: ManageEventVolunteerRolesDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(
      deleteEventVolunteerRole(deps, validInput),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("logs audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await deleteEventVolunteerRole(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_volunteer_role",
        action: "deleted",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listEventVolunteerRoles
// ══════════════════════════════════════════════════════════════════════════════

describe("listEventVolunteerRoles", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
  };

  it("returns roles with shifts", async () => {
    const deps = makeDeps();
    const result = await listEventVolunteerRoles(deps, validInput);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: ROLE_ID, shifts: [] });
  });

  it("rejects VIEWER role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(
      listEventVolunteerRoles(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A4 — EVENT-ask askId stamping on event-path role creates
// ══════════════════════════════════════════════════════════════════════════════

describe("event-path role creates stamp the EVENT ask's id", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    name: "Security",
  };

  it("createEventVolunteerRole stamps the backfilled ask's id", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await createEventVolunteerRole(deps, validInput);

    expect(
      (txRepos.volunteering as any).listAsksBySubject,
    ).toHaveBeenCalledWith("EVENT", EVENT_ID);
    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, askId: EVENT_ASK_ID }),
    );
    expect(
      (txRepos.volunteering as any).createAskIfAbsent,
    ).not.toHaveBeenCalled();
  });

  it("createEventVolunteerRole lazily creates the EVENT ask when missing", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([]) // nothing yet
      .mockResolvedValueOnce([baseEventAsk]); // re-read after insert

    await createEventVolunteerRole(deps, validInput);

    expect(
      (txRepos.volunteering as any).createAskIfAbsent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        orgId: ORG_ID,
      }),
    );
    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({ askId: EVENT_ASK_ID }),
    );
  });

  it("createFromTemplates stamps every created role with the ask id (one resolution)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await createFromTemplates(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      templateIds: [TEMPLATE_ID, TEMPLATE_ID],
    });

    const calls = (txRepos.volunteering as any).createEventRole.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [input] of calls) {
      expect(input).toMatchObject({ eventId: EVENT_ID, askId: EVENT_ASK_ID });
    }
    // Resolved once for the whole batch.
    expect(
      (txRepos.volunteering as any).listAsksBySubject,
    ).toHaveBeenCalledTimes(1);
  });
});
