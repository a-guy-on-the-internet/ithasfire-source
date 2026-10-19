import { describe, expect, it, vi } from "vitest";
import { updateDefaultResourceLimit } from "../update-default-resource-limit";
import type { UpdateDefaultResourceLimitDeps } from "../update-default-resource-limit";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

function makeDeps(overrides?: {
  adminAllowed?: boolean;
}): UpdateDefaultResourceLimitDeps {
  const auditEntries: unknown[] = [];

  return {
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: overrides?.adminAllowed ?? true,
      })),
    } as any,
    repos: {
      tx: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          resourceQuotas: {
            upsertDefaultLimit: vi.fn(async (input: any) => ({
              kind: input.kind,
              limitValue: input.limitValue,
              updatedAt: new Date(),
              createdAt: new Date(),
            })),
          },
          audit: {
            log: vi.fn(async (entry: unknown) => {
              auditEntries.push(entry);
            }),
          },
        };
        return fn(tx);
      }),
      _auditEntries: auditEntries,
    } as any,
  };
}

function validInput(overrides?: Partial<Record<string, unknown>>) {
  return {
    actorHumanId: ACTOR_ID,
    kind: "EVENTS_PER_ORG",
    limitValue: 100,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("updateDefaultResourceLimit", () => {
  it("upserts the limit and returns serialized output", async () => {
    const deps = makeDeps();
    const result = await updateDefaultResourceLimit(deps, validInput());

    expect(result).toEqual({
      kind: "EVENTS_PER_ORG",
      limitValue: "100",
    });
  });

  it("creates an audit log entry within the transaction", async () => {
    const deps = makeDeps();
    await updateDefaultResourceLimit(deps, validInput({ limitValue: 200 }));

    // tx was called; verify the audit log was invoked by inspecting the tx mock
    const txFn = (deps.repos.tx as any).mock.calls[0][0];
    // Re-run to capture the audit call
    const tx = {
      resourceQuotas: {
        upsertDefaultLimit: vi.fn(async (input: any) => ({
          kind: input.kind,
          limitValue: input.limitValue,
          updatedAt: new Date(),
          createdAt: new Date(),
        })),
      },
      audit: {
        log: vi.fn(async () => {}),
      },
    };
    await txFn(tx);

    expect(tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "default_resource_limit",
        entityId: "EVENTS_PER_ORG",
        action: "default_resource_limit.updated",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          kind: "EVENTS_PER_ORG",
          limitValue: "200",
        }),
      }),
    );
  });

  it("throws platform_admin_required when actor is not ADMIN", async () => {
    const deps = makeDeps({ adminAllowed: false });
    await expect(
      updateDefaultResourceLimit(deps, validInput()),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("checks for ADMIN-only staff role", async () => {
    const deps = makeDeps();
    await updateDefaultResourceLimit(deps, validInput());

    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN"],
    });
  });

  it("rejects invalid input (zero limitValue)", async () => {
    const deps = makeDeps();
    await expect(
      updateDefaultResourceLimit(deps, validInput({ limitValue: 0 })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid input (negative limitValue)", async () => {
    const deps = makeDeps();
    await expect(
      updateDefaultResourceLimit(deps, validInput({ limitValue: -5 })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
