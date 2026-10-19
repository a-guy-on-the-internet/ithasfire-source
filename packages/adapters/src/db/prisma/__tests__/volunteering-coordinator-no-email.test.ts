import { describe, expect, it, vi } from "vitest";

import { makeVolunteeringRepo } from "../volunteering";

// 2026-09-29 security review: `listGroupsByAsk` fed the ask owner's roster
// with the coordinator's ACCOUNT email. Since an owner picks the coordinator
// by typing any address or humanId, that was an email/humanId → account-email
// lookup. The read must not even select it.

describe("listGroupsByAsk coordinator info", () => {
  it("selects and returns the coordinator's name only, never an email", async () => {
    const now = new Date("2026-09-29T00:00:00.000Z");
    const findMany = vi.fn(async (_query: unknown) => [
      {
        id: "g1",
        askId: "a1",
        name: "Door crew",
        description: null,
        capacity: null,
        coordinatorHumanId: "h1",
        createdAt: now,
        updatedAt: now,
        _count: { members: 2 },
        coordinator: { id: "h1", name: "Jo" },
      },
    ]);
    const repo = makeVolunteeringRepo({
      volunteerGroup: { findMany },
    } as never);

    const [group] = await repo.listGroupsByAsk("a1");

    expect(group?.coordinator).toEqual({ humanId: "h1", name: "Jo" });
    const query = findMany.mock.calls[0]?.[0] as unknown as {
      select: { coordinator: { select: Record<string, unknown> } };
    };
    expect(query.select.coordinator.select).toEqual({ id: true, name: true });
    expect(JSON.stringify(query)).not.toContain("authUser");
  });
});
