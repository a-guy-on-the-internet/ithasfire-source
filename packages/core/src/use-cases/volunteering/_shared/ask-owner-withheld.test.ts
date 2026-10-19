import { describe, expect, it, vi } from "vitest";

import { findWithheldAskIds, isAskOwnerWithheld } from "./ask-owner-withheld";

const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const EVENT_ID = "00000000-0000-4000-8000-000000000004";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";

function makeTx(opts: {
  banned?: { humanIds: string[]; orgIds: string[] };
  event?: { id: string; ownerBanned?: boolean } | null;
}) {
  return {
    bans: {
      findBannedOwners: vi.fn(
        async () => opts.banned ?? { humanIds: [], orgIds: [] },
      ),
    },
    events: {
      getById: vi.fn(async () =>
        opts.event === undefined ? null : opts.event,
      ),
    },
  };
}

describe("isAskOwnerWithheld", () => {
  it("ORG ask: withheld when the org is reported banned", async () => {
    const tx = makeTx({ banned: { humanIds: [], orgIds: [ORG_ID] } });
    await expect(
      isAskOwnerWithheld(tx as never, {
        subjectType: "ORG",
        subjectId: ORG_ID,
      }),
    ).resolves.toBe(true);
    expect(tx.bans.findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [ORG_ID],
    });
    expect(tx.events.getById).not.toHaveBeenCalled();
  });

  it("HUMAN ask: withheld when the human is reported banned", async () => {
    const tx = makeTx({ banned: { humanIds: [HUMAN_ID], orgIds: [] } });
    await expect(
      isAskOwnerWithheld(tx as never, {
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
      }),
    ).resolves.toBe(true);
  });

  describe("EVENT ask", () => {
    const ask = { subjectType: "EVENT", subjectId: EVENT_ID };

    it("is withheld when the event's owner standing says banned", async () => {
      const tx = makeTx({ event: { id: EVENT_ID, ownerBanned: true } });
      await expect(isAskOwnerWithheld(tx as never, ask)).resolves.toBe(true);
      // The event read's derived owner standing, the same rule as
      // `ensureEventOpenToPublic`; no separate bans lookup.
      expect(tx.events.getById).toHaveBeenCalledWith(EVENT_ID, {
        withOwnerStanding: true,
      });
      expect(tx.bans.findBannedOwners).not.toHaveBeenCalled();
    });

    it("is not withheld when the event's owner is in good standing", async () => {
      const tx = makeTx({ event: { id: EVENT_ID, ownerBanned: false } });
      await expect(isAskOwnerWithheld(tx as never, ask)).resolves.toBe(false);
    });

    it("is not withheld when the event is missing (no owner to withhold)", async () => {
      const tx = makeTx({ event: null });
      await expect(isAskOwnerWithheld(tx as never, ask)).resolves.toBe(false);
      // Matches the batched form for a missing event owner.
      await expect(
        findWithheldAskIds(tx as never, [
          { id: "a", ...ask, eventOwner: null },
        ]),
      ).resolves.toEqual(new Set());
    });
  });

  it("PLACE ask: out of scope, never withheld and no reads", async () => {
    const tx = makeTx({ banned: { humanIds: [], orgIds: [ORG_ID] } });
    await expect(
      isAskOwnerWithheld(tx as never, {
        subjectType: "PLACE",
        subjectId: PLACE_ID,
      }),
    ).resolves.toBe(false);
    expect(tx.bans.findBannedOwners).not.toHaveBeenCalled();
    expect(tx.events.getById).not.toHaveBeenCalled();
  });
});
