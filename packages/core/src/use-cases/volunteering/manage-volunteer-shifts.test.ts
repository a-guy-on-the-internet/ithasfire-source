import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
} from "@th/ports/repos/volunteering";
import {
  createVolunteerShift,
  createVolunteerShiftBatch,
  updateVolunteerShift,
  deleteVolunteerShift,
  listVolunteerShifts,
} from "./manage-volunteer-shifts";
import type { ManageVolunteerShiftsDeps } from "./manage-volunteer-shifts";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SHIFT_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-06-01T12:00:00.000Z");
const SHIFT_START = new Date("2026-07-01T09:00:00Z");
const SHIFT_END = new Date("2026-07-01T13:00:00Z");

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
  createdAt: NOW,
  updatedAt: NOW,
} as EventRecord;

const baseRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: EVENT_ID,
  templateId: null,
  name: "Security",
  description: null,
  capacity: 10,
  autoApprove: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const baseShift: VolunteerShiftRecord = {
  id: SHIFT_ID,
  roleId: ROLE_ID,
  label: "Morning shift",
  startsAt: SHIFT_START,
  endsAt: SHIFT_END,
  capacity: 5,
  notes: null,
  sortOrder: 0,
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
      getEventRole: vi.fn(async () => baseRole),
      getShift: vi.fn(async () => baseShift),
      createShift: vi.fn(async (input: any) => ({
        ...baseShift,
        ...input,
        id: SHIFT_ID,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      updateShift: vi.fn(async (id: string, input: any) => ({
        ...baseShift,
        ...input,
        id,
      })),
      deleteShift: vi.fn(async () => undefined),
      listShifts: vi.fn(async () => [baseShift]),
      // Other volunteering methods (not used but needed for type compat)
      createRoleTemplate: vi.fn(),
      updateRoleTemplate: vi.fn(),
      archiveRoleTemplate: vi.fn(),
      listRoleTemplates: vi.fn(),
      getRoleTemplate: vi.fn(),
      createEventRole: vi.fn(),
      updateEventRole: vi.fn(),
      deleteEventRole: vi.fn(),
      listEventRoles: vi.fn(),
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
): ManageVolunteerShiftsDeps {
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
  const deps: ManageVolunteerShiftsDeps = {
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
// createVolunteerShift
// ══════════════════════════════════════════════════════════════════════════════

describe("createVolunteerShift", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    roleId: ROLE_ID,
    label: "Morning shift",
    startsAt: SHIFT_START,
    endsAt: SHIFT_END,
    capacity: 5,
  };

  it("creates a shift and returns it", async () => {
    const deps = makeDeps();
    const result = await createVolunteerShift(deps, validInput);

    expect(result).toMatchObject({
      id: SHIFT_ID,
      roleId: ROLE_ID,
      label: "Morning shift",
    });
  });

  it("rejects when role not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => null);
    const deps: ManageVolunteerShiftsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(createVolunteerShift(deps, validInput)).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("rejects when endsAt <= startsAt", async () => {
    const deps = makeDeps();
    await expect(
      createVolunteerShift(deps, {
        ...validInput,
        endsAt: SHIFT_START, // same as startsAt
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects when endsAt < startsAt", async () => {
    const deps = makeDeps();
    await expect(
      createVolunteerShift(deps, {
        ...validInput,
        endsAt: new Date("2026-07-01T08:00:00Z"), // before start
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects when actor lacks EDIT role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(createVolunteerShift(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("logs audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerShift(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_shift",
        action: "created",
      }),
    );
  });
});

describe("createVolunteerShiftBatch", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    roleId: ROLE_ID,
    shifts: [
      {
        label: "Load-in",
        startsAt: new Date("2026-07-01T07:00:00Z"),
        endsAt: new Date("2026-07-01T09:00:00Z"),
        capacity: 3,
      },
      {
        label: "Doors",
        startsAt: new Date("2026-07-01T17:30:00Z"),
        endsAt: new Date("2026-07-01T20:00:00Z"),
        capacity: 4,
      },
    ],
  };

  it("creates all shifts in one tx and reuses role auth once", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        ...(makeTxRepos().volunteering as Record<string, unknown>),
        createShift: vi
          .fn()
          .mockImplementationOnce(async (input: any) => ({
            ...baseShift,
            ...input,
            id: "00000000-0000-4000-8000-000000000101",
          }))
          .mockImplementationOnce(async (input: any) => ({
            ...baseShift,
            ...input,
            id: "00000000-0000-4000-8000-000000000102",
          })),
      },
    });

    const result = await createVolunteerShiftBatch(deps, validInput);

    expect(result).toHaveLength(2);
    expect(deps.repos.tx as any).toHaveBeenCalledTimes(1);
    expect((txRepos.volunteering as any).getEventRole).toHaveBeenCalledTimes(1);
    expect((txRepos.events as any).getById).toHaveBeenCalledTimes(1);
    expect((txRepos.authz as any).getOrgMembership).toHaveBeenCalledTimes(1);
    expect((txRepos.volunteering as any).createShift).toHaveBeenCalledTimes(2);
    expect((txRepos.audit as any).log).toHaveBeenCalledTimes(2);
  });

  it("assigns monotonic sortOrder values after the existing max in input order", async () => {
    const createShift = vi
      .fn()
      .mockImplementationOnce(async (input: any) => ({
        ...baseShift,
        ...input,
        id: "00000000-0000-4000-8000-000000000201",
      }))
      .mockImplementationOnce(async (input: any) => ({
        ...baseShift,
        ...input,
        id: "00000000-0000-4000-8000-000000000202",
      }));
    const listShifts = vi.fn(async () => [
      {
        ...baseShift,
        id: "00000000-0000-4000-8000-000000000041",
        sortOrder: 1,
      },
      {
        ...baseShift,
        id: "00000000-0000-4000-8000-000000000042",
        sortOrder: 4,
      },
      {
        ...baseShift,
        id: "00000000-0000-4000-8000-000000000043",
        sortOrder: 2,
      },
    ]);
    const { deps } = makeDepsWithMocks({
      volunteering: {
        ...(makeTxRepos().volunteering as Record<string, unknown>),
        listShifts,
        createShift,
      },
    });

    await createVolunteerShiftBatch(deps, validInput);

    expect(listShifts).toHaveBeenCalledTimes(1);
    expect(listShifts).toHaveBeenCalledWith(ROLE_ID);
    expect(createShift).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        roleId: ROLE_ID,
        label: "Load-in",
        sortOrder: 5,
      }),
    );
    expect(createShift).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        roleId: ROLE_ID,
        label: "Doors",
        sortOrder: 6,
      }),
    );
  });

  it("rejects when shifts is empty", async () => {
    const deps = makeDeps();

    await expect(
      createVolunteerShiftBatch(deps, {
        actorHumanId: ACTOR_ID,
        roleId: ROLE_ID,
        shifts: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects when any shift ends before it starts", async () => {
    const deps = makeDeps();

    await expect(
      createVolunteerShiftBatch(deps, {
        ...validInput,
        shifts: [
          validInput.shifts[0],
          {
            ...validInput.shifts[1],
            endsAt: validInput.shifts[1].startsAt,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// updateVolunteerShift
// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerShift", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: SHIFT_ID,
    label: "Afternoon shift",
  };

  it("updates a shift and returns it", async () => {
    const deps = makeDeps();
    const result = await updateVolunteerShift(deps, validInput);

    expect(result).toMatchObject({ id: SHIFT_ID, label: "Afternoon shift" });
  });

  it("rejects when shift not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getShift = vi.fn(async () => null);
    const deps: ManageVolunteerShiftsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(updateVolunteerShift(deps, validInput)).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
  });

  it("rejects when both startsAt and endsAt provided but endsAt <= startsAt", async () => {
    const deps = makeDeps();
    await expect(
      updateVolunteerShift(deps, {
        ...validInput,
        startsAt: new Date("2026-07-01T14:00:00Z"),
        endsAt: new Date("2026-07-01T13:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("allows updating only startsAt (no cross-validation needed)", async () => {
    const deps = makeDeps();
    const result = await updateVolunteerShift(deps, {
      actorHumanId: ACTOR_ID,
      id: SHIFT_ID,
      startsAt: new Date("2026-07-01T08:00:00Z"),
    });
    expect(result.id).toBe(SHIFT_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// deleteVolunteerShift
// ══════════════════════════════════════════════════════════════════════════════

describe("deleteVolunteerShift", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: SHIFT_ID,
  };

  it("deletes a shift", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await deleteVolunteerShift(deps, validInput);

    expect((txRepos.volunteering as any).deleteShift).toHaveBeenCalledWith(
      SHIFT_ID,
    );
  });

  it("rejects when shift not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getShift = vi.fn(async () => null);
    const deps: ManageVolunteerShiftsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(deleteVolunteerShift(deps, validInput)).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
  });

  it("logs audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await deleteVolunteerShift(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_shift",
        action: "deleted",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listVolunteerShifts
// ══════════════════════════════════════════════════════════════════════════════

describe("listVolunteerShifts", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    roleId: ROLE_ID,
  };

  it("returns shifts for the role", async () => {
    const deps = makeDeps();
    const result = await listVolunteerShifts(deps, validInput);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: SHIFT_ID });
  });

  it("rejects when role not found", async () => {
    const txRepos = makeTxRepos();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => null);
    const deps: ManageVolunteerShiftsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await expect(listVolunteerShifts(deps, validInput)).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });
});
