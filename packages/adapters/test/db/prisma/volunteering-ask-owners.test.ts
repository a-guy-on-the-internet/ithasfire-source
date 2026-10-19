/**
 * `listAskOwnersByIds` (stubbed Prisma): the batched owner read behind the
 * `/my-volunteering` "sign-ups paused" flag. One `findMany` for every id,
 * selecting only the owner columns; no query at all for an empty list.
 */
import { describe, expect, it, vi } from "vitest";

import { makeVolunteeringRepo } from "../../../src/db/prisma/volunteering";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";

function makeRepo(
  rows: Array<Record<string, unknown>>,
  events: Array<Record<string, unknown>> = [],
) {
  const findMany = vi.fn(async () => rows);
  const eventFindMany = vi.fn(async () => events);
  const prisma = {
    volunteerAsk: { findMany },
    event: { findMany: eventFindMany },
  };
  return {
    repo: makeVolunteeringRepo(prisma as unknown as PrismaClientOrTx),
    findMany,
    eventFindMany,
  };
}

describe("listAskOwnersByIds", () => {
  it("reads every id in ONE query, selecting only the owner columns", async () => {
    const { repo, findMany } = makeRepo([
      { id: "ask-1", subjectType: "ORG", subjectId: "org-1" },
      { id: "ask-2", subjectType: "HUMAN", subjectId: "human-1" },
    ]);

    const owners = await repo.listAskOwnersByIds(["ask-1", "ask-2"]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["ask-1", "ask-2"] } },
      select: { id: true, subjectType: true, subjectId: true },
    });
    expect(owners).toEqual([
      { id: "ask-1", subjectType: "ORG", subjectId: "org-1" },
      { id: "ask-2", subjectType: "HUMAN", subjectId: "human-1" },
    ]);
  });

  it("EVENT asks resolve the event's owner in ONE extra batched read", async () => {
    const { repo, eventFindMany } = makeRepo(
      [
        { id: "a1", subjectType: "EVENT", subjectId: "ev-1" },
        { id: "a2", subjectType: "EVENT", subjectId: "ev-2" },
        { id: "a3", subjectType: "ORG", subjectId: "org-1" },
      ],
      [
        { id: "ev-1", humanId: null, orgId: "org-9" },
        { id: "ev-2", humanId: "h-1", orgId: null },
      ],
    );

    const owners = await repo.listAskOwnersByIds(["a1", "a2", "a3"]);

    expect(eventFindMany).toHaveBeenCalledTimes(1);
    expect(eventFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["ev-1", "ev-2"] } },
      select: { id: true, humanId: true, orgId: true },
    });
    expect(owners).toEqual([
      {
        id: "a1",
        subjectType: "EVENT",
        subjectId: "ev-1",
        eventOwner: { humanId: null, orgId: "org-9" },
      },
      {
        id: "a2",
        subjectType: "EVENT",
        subjectId: "ev-2",
        eventOwner: { humanId: "h-1", orgId: null },
      },
      { id: "a3", subjectType: "ORG", subjectId: "org-1" },
    ]);
  });

  it("makes no event read when no ask is EVENT-owned", async () => {
    const { repo, eventFindMany } = makeRepo([
      { id: "a1", subjectType: "ORG", subjectId: "org-1" },
    ]);
    await repo.listAskOwnersByIds(["a1"]);
    expect(eventFindMany).not.toHaveBeenCalled();
  });

  it("an empty id list makes no query", async () => {
    const { repo, findMany } = makeRepo([]);

    await expect(repo.listAskOwnersByIds([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
