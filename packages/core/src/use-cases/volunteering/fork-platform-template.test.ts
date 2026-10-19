import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  RoleTemplateRecord,
  RoleTemplateShiftRecord,
} from "@th/ports/repos/volunteering";

import {
  forkPlatformRoleTemplate,
  type ForkPlatformRoleTemplateDeps,
} from "./fork-platform-template";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const PLATFORM_TEMPLATE_ID = "00000000-0000-4000-8000-000000000012";
const FORK_ID = "00000000-0000-4000-8000-000000000013";
const OTHER_ORG_TEMPLATE_ID = "00000000-0000-4000-8000-000000000014";
const LIVE_PACK_ID = "00000000-0000-4000-8000-000000000020";
const NOW = new Date("2026-07-28T12:00:00.000Z");

const FORK_KEY = `volunteer-template-fork:${ORG_ID}:${PLATFORM_TEMPLATE_ID}`;
/** Mirrors `FAILURE_KEEP_SECONDS` in the use case. */
const FAILURE_KEEP_SECONDS = 1;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const platformTemplate: RoleTemplateRecord = {
  id: PLATFORM_TEMPLATE_ID,
  orgId: null,
  name: "Door",
  description: "Greet and check tickets",
  defaultCapacity: 2,
  sortOrder: 3,
  archived: false,
  isPlatform: true,
  packId: LIVE_PACK_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

/** An anchored preset — the exact shape the schema work exists to preserve. */
const platformShift: RoleTemplateShiftRecord = {
  id: "shift-1",
  templateId: PLATFORM_TEMPLATE_ID,
  label: "Load-in",
  startMinuteOfDay: 16 * 60,
  endMinuteOfDay: 18 * 60 + 30,
  startDayOffset: 0,
  endsNextDay: false,
  capacity: 2,
  position: 0,
  anchor: "EVENT_START",
  offsetMinutes: -180,
  notes: "Meet at the loading dock",
  createdAt: NOW,
  updatedAt: NOW,
};

const forkedTemplate: RoleTemplateRecord = {
  ...platformTemplate,
  id: FORK_ID,
  orgId: ORG_ID,
  isPlatform: false,
  packId: LIVE_PACK_ID,
};

// ── Mock builders ────────────────────────────────────────────────────────────

/** Adapter defaults, mirrored so the double can't drift from them silently. */
const ADAPTER_DEFAULT_BEGIN_TTL_SEC = 60;
const ADAPTER_DEFAULT_COMMIT_KEEP_SEC = 3 * 86400;
const ADAPTER_DEFAULT_FAIL_KEEP_SEC = 15 * 60;

type FakeIdempotency = IdempotencyPort &
  Record<string, ReturnType<typeof vi.fn>> & {
    /** Move the double's virtual clock forward, in milliseconds. */
    advance: (ms: number) => void;
  };

/**
 * A faithful model of the SHIPPED adapters, not a convenient one.
 *
 * `PrismaIdempotencyAdapter` and `RedisIdempotency` both:
 *   - `fail()` WRITES a `failed` marker with its own retention (15 min by
 *     default). It does not delete the claim.
 *   - `begin()` re-claims only once that retention has elapsed (Prisma:
 *     `WHERE expiresAt <= now`; Redis: `SET … NX` after the key expires).
 *   - `get()` replays only a `succeeded` key — a failed one reads as null.
 *
 * The previous double implemented `fail` as "delete the claim", the exact
 * opposite, which is why the 15-minute retry lockout shipped green.
 */
function makeIdempotency(overrides: Partial<IdempotencyPort> = {}) {
  type Entry = {
    status: "in_progress" | "succeeded" | "failed";
    expiresAtMs: number;
    result?: unknown;
  };
  const entries = new Map<string, Entry>();
  let nowMs = NOW.getTime();
  const live = (key: string): Entry | null => {
    const entry = entries.get(key);
    return entry && entry.expiresAtMs > nowMs ? entry : null;
  };

  const port = {
    get: vi.fn(async (key: string) => {
      const entry = live(key);
      return entry?.status === "succeeded" ? (entry.result ?? null) : null;
    }),
    begin: vi.fn(
      async (key: string, ttlSec = ADAPTER_DEFAULT_BEGIN_TTL_SEC) => {
        if (live(key)) return false;
        entries.set(key, {
          status: "in_progress",
          expiresAtMs: nowMs + ttlSec * 1000,
        });
        return true;
      },
    ),
    commit: vi.fn(
      async (
        key: string,
        result: unknown,
        keepSec = ADAPTER_DEFAULT_COMMIT_KEEP_SEC,
      ) => {
        entries.set(key, {
          status: "succeeded",
          expiresAtMs: nowMs + keepSec * 1000,
          result,
        });
      },
    ),
    fail: vi.fn(
      async (
        key: string,
        _error?: string,
        keepSec = ADAPTER_DEFAULT_FAIL_KEEP_SEC,
      ) => {
        entries.set(key, {
          status: "failed",
          expiresAtMs: nowMs + keepSec * 1000,
        });
      },
    ),
    run: vi.fn(),
    advance: (ms: number) => {
      nowMs += ms;
    },
    ...overrides,
    purgeExpired: async () => 0,
  };
  return port as unknown as FakeIdempotency;
}

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  const created: RoleTemplateRecord[] = [];
  return {
    authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    volunteering: {
      getRoleTemplateUsableBy: vi.fn(async (id: string) =>
        id === PLATFORM_TEMPLATE_ID ? platformTemplate : null,
      ),
      listRoleTemplates: vi.fn(async () => [] as RoleTemplateRecord[]),
      createRoleTemplate: vi.fn(async (input: any) => {
        const row: RoleTemplateRecord = {
          ...forkedTemplate,
          name: input.name,
          description: input.description ?? null,
          defaultCapacity: input.defaultCapacity ?? null,
          sortOrder: input.sortOrder ?? 0,
          packId: input.packId ?? null,
        };
        created.push(row);
        return row;
      }),
      listRoleTemplateShifts: vi.fn(async () => [platformShift]),
      upsertRoleTemplateShifts: vi.fn(async () => [platformShift]),
      getRoleTemplateWithShifts: vi.fn(async (id: string) =>
        id === FORK_ID ? { ...forkedTemplate, shifts: [platformShift] } : null,
      ),
      ...((overrides.volunteering as object) ?? {}),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== "volunteering"),
    ),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(overrides);
  const idempotency = makeIdempotency();
  const deps: ForkPlatformRoleTemplateDeps = {
    repos: {
      ...txRepos,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    idempotency,
  };
  return { deps, txRepos, idempotency };
}

const validInput = {
  actorHumanId: ACTOR_ID,
  orgId: ORG_ID,
  templateId: PLATFORM_TEMPLATE_ID,
};

/** Nth argument of a mock's FIRST call. These mocks are hand-rolled, so the
 *  call tuple has no useful static type to narrow against. */
function nthArg(mock: unknown, index: number): unknown {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[index];
}

const firstArg = (mock: unknown): unknown => nthArg(mock, 0);

// ══════════════════════════════════════════════════════════════════════════════

describe("forkPlatformRoleTemplate", () => {
  it("creates an org-owned copy that retains the source pack as provenance", async () => {
    const { deps, txRepos } = makeDeps();
    const result = await forkPlatformRoleTemplate(deps, validInput);

    expect(result.id).toBe(FORK_ID);
    expect(txRepos.volunteering.createRoleTemplate).toHaveBeenCalledWith({
      orgId: ORG_ID,
      name: "Door",
      description: "Greet and check tickets",
      defaultCapacity: 2,
      sortOrder: 3,
      packId: LIVE_PACK_ID,
    });
    // `isPlatform` is not settable through `createRoleTemplate` — no
    // organizer-facing path can mint a catalogue row.
    expect(
      firstArg(txRepos.volunteering.createRoleTemplate),
    ).not.toHaveProperty("isPlatform");
  });

  it("copies the shift presets INCLUDING anchor, offset and notes", async () => {
    const { deps, txRepos } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);

    expect(txRepos.volunteering.upsertRoleTemplateShifts).toHaveBeenCalledWith(
      FORK_ID,
      [
        {
          label: "Load-in",
          startMinuteOfDay: 16 * 60,
          endMinuteOfDay: 18 * 60 + 30,
          startDayOffset: 0,
          endsNextDay: false,
          capacity: 2,
          position: 0,
          anchor: "EVENT_START",
          offsetMinutes: -180,
          notes: "Meet at the loading dock",
        },
      ],
    );
  });

  it("skips the shift write entirely when the catalogue role has none", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: { listRoleTemplateShifts: vi.fn(async () => []) },
    });
    await forkPlatformRoleTemplate(deps, validInput);
    expect(
      txRepos.volunteering.upsertRoleTemplateShifts,
    ).not.toHaveBeenCalled();
  });

  it("writes an audit row naming the actor and the source", async () => {
    const { deps, txRepos } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);

    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_role_template",
        entityId: FORK_ID,
        action: "forked_from_platform",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          sourceTemplateId: PLATFORM_TEMPLATE_ID,
          packId: LIVE_PACK_ID,
        }),
      }),
    );
  });

  // ── Idempotency (FR-012) ──────────────────────────────────────────────────

  it("claims the derived (orgId, templateId) key, not a client-supplied one", async () => {
    const { deps, idempotency } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);
    expect(idempotency.begin).toHaveBeenCalledWith(
      FORK_KEY,
      expect.any(Number),
    );
    expect(idempotency.commit).toHaveBeenCalledWith(
      FORK_KEY,
      { forkedTemplateId: FORK_ID },
      expect.any(Number),
    );
  });

  it("rejects a client-supplied idempotencyKey field outright", async () => {
    const { deps } = makeDeps();
    await expect(
      forkPlatformRoleTemplate(deps, {
        ...validInput,
        idempotencyKey: "attacker-chosen",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a double-clicked Customise creates exactly one copy", async () => {
    const { deps, txRepos } = makeDeps();
    const first = await forkPlatformRoleTemplate(deps, validInput);
    const second = await forkPlatformRoleTemplate(deps, validInput);

    expect(second.id).toBe(first.id);
    expect(txRepos.volunteering.createRoleTemplate).toHaveBeenCalledTimes(1);
  });

  it("replays through the store without re-reading the catalogue row", async () => {
    const { deps, txRepos } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);
    txRepos.volunteering.getRoleTemplateUsableBy.mockClear();

    await forkPlatformRoleTemplate(deps, validInput);
    expect(txRepos.volunteering.getRoleTemplateUsableBy).not.toHaveBeenCalled();
  });

  it("ignores a cached id whose row now belongs to another org", async () => {
    // A cache that outlived its row must not become a cross-tenant read.
    const { deps, txRepos, idempotency } = makeDeps({
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => ({
          ...forkedTemplate,
          orgId: "00000000-0000-4000-8000-0000000000ff",
          shifts: [],
        })),
      },
    });
    (idempotency.get as any).mockResolvedValue({ forkedTemplateId: FORK_ID });

    // Falls through to a real fork rather than returning the foreign row.
    await forkPlatformRoleTemplate(deps, validInput).catch(() => undefined);
    expect(txRepos.volunteering.getRoleTemplateUsableBy).toHaveBeenCalled();
  });

  it("surfaces IDEMPOTENCY_LOCK_IN_PROGRESS when another run holds the claim", async () => {
    const { deps, idempotency } = makeDeps();
    (idempotency.begin as any).mockResolvedValue(false);
    (idempotency.get as any).mockResolvedValue(null);

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
  });

  it("releases the claim when the fork fails, with an EXPLICIT short retention", async () => {
    const { deps, idempotency, txRepos } = makeDeps({
      volunteering: {
        getRoleTemplateUsableBy: vi.fn(async () => null),
      },
    });

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    // The third argument is the point: omitting it takes the ADAPTERS'
    // default, which holds the failed key — and therefore the retry — for 15
    // minutes. `fail()` does not release anything on its own.
    expect(idempotency.fail).toHaveBeenCalledWith(
      FORK_KEY,
      expect.any(String),
      FAILURE_KEEP_SECONDS,
    );
    expect(txRepos.volunteering.createRoleTemplate).not.toHaveBeenCalled();
  });

  it("lets the documented FR-011 corrected retry through on the SAME key", async () => {
    // The exact path the doc block promises: the org already has a hand-made
    // "Door", Customise fails with TEMPLATE_NAME_TAKEN, the UI re-submits with
    // an explicit name. The key derives from (orgId, templateId) only, so the
    // retry lands on the very key the failure just wrote.
    const homegrown: RoleTemplateRecord = {
      ...forkedTemplate,
      id: "00000000-0000-4000-8000-0000000000aa",
      packId: null,
    };
    const { deps, idempotency, txRepos } = makeDeps({
      volunteering: { listRoleTemplates: vi.fn(async () => [homegrown]) },
    });

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });

    idempotency.advance(FAILURE_KEEP_SECONDS * 1000);

    const retried = await forkPlatformRoleTemplate(deps, {
      ...validInput,
      name: "Door (Ithas Fire)",
    });

    expect(retried.id).toBe(FORK_ID);
    expect(txRepos.volunteering.createRoleTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Door (Ithas Fire)" }),
    );
  });

  it("the idempotency double holds a DEFAULT-retention failure, like both adapters", async () => {
    // Guards the DOUBLE, not the use case. The retry test above only proves
    // anything if `fail()` genuinely keeps the claim for `keepSec` — the
    // previous double deleted it outright, so that test would have passed
    // against the 15-minute lockout too.
    const idem = makeIdempotency();

    expect(await idem.begin("k", 60)).toBe(true);
    await idem.fail("k", "boom"); // adapters' default retention
    expect(await idem.get("k")).toBeNull(); // a failed key never replays

    idem.advance(60_000); // past the begin TTL, inside the fail retention
    expect(await idem.begin("k", 60)).toBe(false);

    idem.advance(15 * 60_000);
    expect(await idem.begin("k", 60)).toBe(true);
  });

  // ── Name collisions ───────────────────────────────────────────────────────

  it("returns the existing fork instead of duplicating it (stale tab)", async () => {
    const existingFork = { ...forkedTemplate };
    const { deps, txRepos } = makeDeps({
      volunteering: {
        listRoleTemplates: vi.fn(async () => [existingFork]),
      },
    });

    const result = await forkPlatformRoleTemplate(deps, validInput);
    expect(result.id).toBe(FORK_ID);
    expect(txRepos.volunteering.createRoleTemplate).not.toHaveBeenCalled();
  });

  it("refuses rather than overwriting the org's OWN row of the same name", async () => {
    const homegrown: RoleTemplateRecord = {
      ...forkedTemplate,
      id: "00000000-0000-4000-8000-0000000000aa",
      packId: null, // never came from the catalogue
    };
    const { deps, txRepos } = makeDeps({
      volunteering: { listRoleTemplates: vi.fn(async () => [homegrown]) },
    });

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(txRepos.volunteering.createRoleTemplate).not.toHaveBeenCalled();
    // The fork path owns no update primitive at all — the org's row is left
    // exactly as it was, not renamed or re-pointed.
    expect(
      (txRepos.volunteering as Record<string, unknown>).updateRoleTemplate,
    ).toBeUndefined();
  });

  it("treats an ARCHIVED fork as a collision, not a row to revive", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        listRoleTemplates: vi.fn(async () => [
          { ...forkedTemplate, archived: true },
        ]),
      },
    });

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(txRepos.volunteering.createRoleTemplate).not.toHaveBeenCalled();
  });

  it("accepts an explicit name to sidestep a collision", async () => {
    const homegrown: RoleTemplateRecord = {
      ...forkedTemplate,
      id: "00000000-0000-4000-8000-0000000000aa",
      packId: null,
    };
    const { deps, txRepos } = makeDeps({
      volunteering: { listRoleTemplates: vi.fn(async () => [homegrown]) },
    });

    await forkPlatformRoleTemplate(deps, {
      ...validInput,
      name: "Door (Ithas Fire)",
    });
    expect(txRepos.volunteering.createRoleTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Door (Ithas Fire)" }),
    );
  });

  it("compares the collision name case-insensitively", async () => {
    const { deps } = makeDeps({
      volunteering: {
        listRoleTemplates: vi.fn(async () => [
          { ...forkedTemplate, id: "x", name: "DOOR", packId: null },
        ]),
      },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("checks collisions against ARCHIVED rows too (the DB unique counts them)", async () => {
    const { deps, txRepos } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);
    expect(txRepos.volunteering.listRoleTemplates).toHaveBeenCalledWith(
      ORG_ID,
      {
        includeArchived: true,
      },
    );
    // ORG-ONLY: no `includePlatform`, so the catalogue row itself is never
    // mistaken for a collision with the copy being made.
    expect(
      nthArg(txRepos.volunteering.listRoleTemplates, 1),
    ).not.toHaveProperty("includePlatform");
  });

  // ── Tenancy + authz ───────────────────────────────────────────────────────

  it("refuses another org's template with no signal it exists", async () => {
    const { deps } = makeDeps();
    await expect(
      forkPlatformRoleTemplate(deps, {
        ...validInput,
        templateId: OTHER_ORG_TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("scopes the source lookup by the caller's org", async () => {
    const { deps, txRepos } = makeDeps();
    await forkPlatformRoleTemplate(deps, validInput);
    expect(txRepos.volunteering.getRoleTemplateUsableBy).toHaveBeenCalledWith(
      PLATFORM_TEMPLATE_ID,
      ORG_ID,
    );
  });

  it("refuses to fork an ORG-owned row (this is not a duplicate primitive)", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getRoleTemplateUsableBy: vi.fn(async () => ({
          ...forkedTemplate,
          isPlatform: false,
        })),
      },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses a mis-shaped platform row with no pack", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getRoleTemplateUsableBy: vi.fn(async () => ({
          ...platformTemplate,
          packId: null,
        })),
      },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects EDITOR (fork is an OWNER | ADMIN action)", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a non-member", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses a non-member BEFORE the idempotency replay can leak the org's template", async () => {
    // NFR-002. `orgId` is caller-supplied and the key is derived from it, so
    // an outsider who knows a victim org's uuid and a catalogue role id —
    // catalogue rows are returned to EVERY org — can name the victim's key.
    // If the replay ran before membership, this call would return org A's
    // customised template and every shift preset on it, `notes` included.
    const { deps, idempotency, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    // Org A's owner already clicked Customise: the result is cached for 24h.
    await idempotency.commit(FORK_KEY, { forkedTemplateId: FORK_ID }, 86400);
    (idempotency.get as ReturnType<typeof vi.fn>).mockClear();

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // Not "returned the wrong row" — the store and the template read are
    // never reached at all.
    expect(idempotency.get).not.toHaveBeenCalled();
    expect(
      txRepos.volunteering.getRoleTemplateWithShifts,
    ).not.toHaveBeenCalled();
  });

  it("refuses an under-privileged member before the replay, too", async () => {
    // Same leak, the ex-/low-privilege-member shape: EDITOR is not in
    // ORG_ADMIN_ROLES, so the cached fork must stay unreadable for them.
    const { deps, idempotency, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });
    await idempotency.commit(FORK_KEY, { forkedTemplateId: FORK_ID }, 86400);
    (idempotency.get as ReturnType<typeof vi.fn>).mockClear();

    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(idempotency.get).not.toHaveBeenCalled();
    expect(
      txRepos.volunteering.getRoleTemplateWithShifts,
    ).not.toHaveBeenCalled();
  });

  it("never claims — or stomps — the key when authz fails", async () => {
    // The pre-claim rejection must not call `fail()`: at that point another
    // run may legitimately own the claim, and marking it failed would abort
    // a fork the rightful owner is midway through.
    const { deps, idempotency } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    await expect(
      forkPlatformRoleTemplate(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(idempotency.fail).not.toHaveBeenCalled();
  });

  it("rejects a malformed org id", async () => {
    const { deps } = makeDeps();
    await expect(
      forkPlatformRoleTemplate(deps, { ...validInput, orgId: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
