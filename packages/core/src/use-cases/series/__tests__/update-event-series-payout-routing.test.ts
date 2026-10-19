import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { updateEventSeries } from "../update-event-series";

// PAYOUT ROUTING in series defaults (owner ruling 2026-09-28). An edit-role
// delegate can save the principal's series — but may not write
// `defaults.payoutTermsDraft`, and a delegate's defaults save keeps the draft
// the owner stored.

const SERIES_ID = "51515151-5151-4515-8515-515151515151";
const PRINCIPAL_ID = "52525252-5252-4525-8525-525252525252";
const DELEGATE_ID = "53535353-5353-4535-8535-535353535353";
const PAYEE_ID = "54545454-5454-4545-8545-545454545454";

const STORED_DRAFT = {
  lines: [{ payeeId: PAYEE_ID, percent: 100, floorCents: 0 }],
};

function setup(actorRole: "OWNER" | "EDITOR") {
  const update = vi.fn(async () => undefined);
  const tx = {
    series: {
      getById: vi.fn(async () => ({
        id: SERIES_ID,
        ownerScope: "HUMAN",
        ownerId: PRINCIPAL_ID,
        name: "Weekly",
        defaults: {
          titlePrefix: "Weekly",
          payoutTermsDraft: STORED_DRAFT,
          agreementDraft: STORED_DRAFT,
        },
      })),
      update,
      findActiveByName: vi.fn(async () => null),
    },
    humans: { getById: vi.fn(async (id: string) => ({ id })) },
    authz: {
      getOrgMembership: vi.fn(async () => null),
      getHumanDelegation: vi.fn(async () => ({
        orgId: PRINCIPAL_ID,
        humanId: DELEGATE_ID,
        role: actorRole,
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
  return { deps, update };
}

const input = (defaults: Record<string, unknown>) => ({
  actorHumanId: DELEGATE_ID,
  seriesId: SERIES_ID,
  clientKey: "series-routing-0001",
  patch: { defaults },
});

describe("updateEventSeries — payoutTermsDraft is payout routing", () => {
  it("refuses a delegate's defaults carrying a payoutTermsDraft, and writes nothing", async () => {
    const { deps, update } = setup("OWNER");

    await expect(
      updateEventSeries(
        deps,
        input({
          titlePrefix: "Mine now",
          payoutTermsDraft: {
            lines: [{ payeeId: DELEGATE_ID, percent: 100, floorCents: 0 }],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(update).not.toHaveBeenCalled();
  });

  it("a delegate's defaults save without a draft keeps the owner's stored draft", async () => {
    const { deps, update } = setup("EDITOR");

    await updateEventSeries(deps, input({ titlePrefix: "Renamed" }));

    expect(update).toHaveBeenCalledTimes(1);
    const data = (update.mock.calls[0] as unknown[])[1] as {
      defaults: Record<string, unknown>;
    };
    expect(data.defaults).toMatchObject({
      titlePrefix: "Renamed",
      payoutTermsDraft: STORED_DRAFT,
    });
  });
});
