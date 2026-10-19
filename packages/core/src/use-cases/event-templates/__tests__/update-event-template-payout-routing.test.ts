import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { updateEventTemplate } from "../update-event-template";

// PAYOUT ROUTING in template defaults (owner ruling 2026-09-28). An edit-role
// delegate can edit the principal's templates — but may not write
// `defaults.payoutTermsDraft`, and a delegate's defaults save keeps the draft
// the owner stored.

const TEMPLATE_ID = "61616161-6161-4616-8616-616161616161";
const PRINCIPAL_ID = "62626262-6262-4626-8626-626262626262";
const DELEGATE_ID = "63636363-6363-4636-8636-636363636363";
const PAYEE_ID = "64646464-6464-4646-8646-646464646464";

const STORED_DRAFT = {
  lines: [{ payeeId: PAYEE_ID, percent: 100, floorCents: 0 }],
};

function setup(actorHumanId: string) {
  const update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: TEMPLATE_ID,
    active: true,
    ...patch,
  }));
  const tx = {
    eventTemplates: {
      getById: vi.fn(async () => ({
        id: TEMPLATE_ID,
        ownerScope: "HUMAN",
        ownerId: PRINCIPAL_ID,
        name: "Standard",
        archivedAt: null,
        active: true,
        defaults: { title: "Standard", payoutTermsDraft: STORED_DRAFT },
      })),
      update,
      findByName: vi.fn(async () => null),
    },
    humans: { getById: vi.fn(async (id: string) => ({ id })) },
    authz: {
      getOrgMembership: vi.fn(async () => null),
      getHumanDelegation: vi.fn(async () => ({
        orgId: PRINCIPAL_ID,
        humanId: DELEGATE_ID,
        role: "OWNER",
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
  const deps = {
    repos: {
      tx: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
    } as unknown as Repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => new Date("2026-09-28T12:00:00Z") },
  };
  const run = (defaults: Record<string, unknown>) =>
    updateEventTemplate(deps, {
      actorHumanId,
      templateId: TEMPLATE_ID,
      clientKey: "template-routing-0001",
      patch: { defaults },
    });
  return { run, update };
}

const DIVERTED = {
  lines: [{ payeeId: DELEGATE_ID, percent: 100, floorCents: 0 }],
};

describe("updateEventTemplate — payoutTermsDraft is payout routing", () => {
  it("refuses an OWNER-role delegate's payoutTermsDraft, and writes nothing", async () => {
    const { run, update } = setup(DELEGATE_ID);

    await expect(
      run({ title: "Mine", payoutTermsDraft: DIVERTED }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(update).not.toHaveBeenCalled();
  });

  it("a delegate's defaults save without a draft keeps the owner's stored draft", async () => {
    const { run, update } = setup(DELEGATE_ID);

    await run({ title: "Renamed" });

    const patch = update.mock.calls[0]![1] as {
      defaults: Record<string, unknown>;
    };
    expect(patch.defaults).toEqual({
      title: "Renamed",
      payoutTermsDraft: STORED_DRAFT,
    });
  });

  it("the owner can still write (and clear) the draft", async () => {
    const { run, update } = setup(PRINCIPAL_ID);

    await run({ title: "Owner", payoutTermsDraft: DIVERTED });
    expect(
      (update.mock.calls[0]![1] as { defaults: Record<string, unknown> })
        .defaults,
    ).toMatchObject({ payoutTermsDraft: DIVERTED });
  });
});
