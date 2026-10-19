import { describe, expect, it, vi } from "vitest";

import { listAuditLogs } from "../list-audit-logs";
import type { ListAuditLogsDeps } from "../list-audit-logs";
import { ACTOR_ID, makeStaffAuthz } from "./_fixtures";

const ROW_1 = {
  id: "33333333-3333-4333-8333-333333333331",
  entity: "event",
  entityId: "44444444-4444-4444-8444-444444444444",
  action: "created",
  data: { actorHumanId: ACTOR_ID },
  actorHumanId: ACTOR_ID,
  at: new Date("2026-07-06T12:00:00.000Z"),
};

const ROW_2 = {
  id: "33333333-3333-4333-8333-333333333332",
  entity: "human_role",
  entityId: null,
  action: "role.granted",
  data: {},
  actorHumanId: null,
  at: new Date("2026-07-05T12:00:00.000Z"),
};

function buildDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    items?: unknown[];
    total?: number;
  } = {},
) {
  const list = vi.fn(async () => ({
    items: overrides.items ?? [ROW_1, ROW_2],
    total: overrides.total ?? (overrides.items ?? [ROW_1, ROW_2]).length,
  }));

  const deps: ListAuditLogsDeps = {
    repos: { audit: { list } } as unknown as ListAuditLogsDeps["repos"],
    authz: makeStaffAuthz(overrides.rolesByHuman ?? { [ACTOR_ID]: ["ADMIN"] }),
  };

  return { deps, mocks: { list } };
}

describe("listAuditLogs", () => {
  it("forbids an actor without ADMIN or REVIEWER", async () => {
    const { deps, mocks } = buildDeps({ rolesByHuman: { [ACTOR_ID]: ["SUPPORT"] } });

    await expect(
      listAuditLogs(deps, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("allows REVIEWER (not just ADMIN)", async () => {
    const { deps } = buildDeps({ rolesByHuman: { [ACTOR_ID]: ["REVIEWER"] } });

    const result = await listAuditLogs(deps, { actorHumanId: ACTOR_ID });

    expect(result.items).toHaveLength(2);
  });

  it("returns paginated rows sorted by `at` descending by default", async () => {
    const { deps } = buildDeps();

    const result = await listAuditLogs(deps, { actorHumanId: ACTOR_ID });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ entity: "event", action: "created" });
    expect(result.pageInfo.total).toBe(2);
  });

  it("wires entity/action/date-range/humanId filters through to the repo", async () => {
    const { deps, mocks } = buildDeps({ items: [ROW_1], total: 1 });

    await listAuditLogs(deps, {
      actorHumanId: ACTOR_ID,
      entity: "event",
      action: "created",
      entityId: ROW_1.entityId,
      humanId: ACTOR_ID,
      atGte: new Date("2026-07-01T00:00:00.000Z"),
      atLte: new Date("2026-07-07T00:00:00.000Z"),
      sort: "at_asc",
      limit: 10,
      offset: 5,
    });

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "created",
        entityId: ROW_1.entityId,
        actorHumanId: ACTOR_ID,
        atGte: new Date("2026-07-01T00:00:00.000Z"),
        atLte: new Date("2026-07-07T00:00:00.000Z"),
        sort: "at_asc",
        limit: 10,
        offset: 5,
      }),
    );
  });

  it("works with no filters applied (all optional/additive)", async () => {
    const { deps, mocks } = buildDeps();

    await listAuditLogs(deps, { actorHumanId: ACTOR_ID });

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: undefined,
        action: undefined,
        entityId: undefined,
        actorHumanId: undefined,
      }),
    );
  });

  it("rejects unknown input fields (strict schema)", async () => {
    const { deps } = buildDeps();

    await expect(
      listAuditLogs(deps, {
        actorHumanId: ACTOR_ID,
        // @ts-expect-error - intentionally invalid extra field
        unexpectedField: "nope",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
