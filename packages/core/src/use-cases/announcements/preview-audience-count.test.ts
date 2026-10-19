import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { authzRepoPrototype } from "@th/test-utils/fakes/prototypes/repos";

import {
  previewAudienceCount,
  type PreviewAudienceCountDeps,
} from "./preview-audience-count";

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const ACTOR_ID = randomUUID();
const EVENT_ID = randomUUID();
const FOREIGN_EVENT_ID = randomUUID();
const TIER_ID = randomUUID();
const FOREIGN_TIER_ID = randomUUID();
const LIST_ID = randomUUID();
const FOREIGN_LIST_ID = randomUUID();

function makeDeps(opts: { emailVerified?: boolean } = {}) {
  const authz = { ...authzRepoPrototype };
  authz.getOrgMembership = vi.fn(async () => ({ role: "OWNER" })) as never;

  const events = new Map([
    [EVENT_ID, { id: EVENT_ID, orgId: ORG_ID, humanId: null }],
    [FOREIGN_EVENT_ID, { id: FOREIGN_EVENT_ID, orgId: OTHER_ORG_ID, humanId: null }],
  ]);
  const tiers: Record<string, string[]> = {
    [EVENT_ID]: [TIER_ID],
    [FOREIGN_EVENT_ID]: [FOREIGN_TIER_ID],
  };
  const lists = new Map([
    [LIST_ID, { id: LIST_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID }],
    [
      FOREIGN_LIST_ID,
      { id: FOREIGN_LIST_ID, ownerType: "ORGANIZATION", ownerId: OTHER_ORG_ID },
    ],
  ]);

  const announcements = {
    countAudienceRecipients: vi.fn(async () => 42),
  };

  const repos = {
    authz,
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: ACTOR_ID },
        identity: { emailVerified: opts.emailVerified ?? true },
      })),
    },
    announcements,
    events: {
      getById: vi.fn(async (id: string) => events.get(id) ?? null),
      listTicketTypes: vi.fn(async (id: string) =>
        (tiers[id] ?? []).map((t) => ({ id: t })),
      ),
    },
    inviteLists: {
      getListById: vi.fn(async (id: string) => lists.get(id) ?? null),
    },
  } as unknown as PreviewAudienceCountDeps["repos"];

  const deps: PreviewAudienceCountDeps = {
    repos,
    logger: createTestLogger(),
  };
  return { deps, announcements };
}

const base = {
  ownerType: "ORGANIZATION" as const,
  ownerId: ORG_ID,
  actorHumanId: ACTOR_ID,
};

describe("previewAudienceCount", () => {
  it("counts an own audience, scoped to the owner", async () => {
    const { deps, announcements } = makeDeps();

    const result = await previewAudienceCount(deps, {
      ...base,
      audienceType: "EVENT_TICKET_HOLDERS",
      audienceRef: EVENT_ID,
      excludedContactListId: LIST_ID,
    });

    expect(result).toEqual({ count: 42 });
    expect(announcements.countAudienceRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "ORGANIZATION",
        orgId: ORG_ID,
        audienceRef: EVENT_ID,
      }),
    );
  });

  // Security review F4 (2026-09-29): the preview leaked any event's buyer /
  // waitlist count and any org's contact-list size.
  it.each<[string, Record<string, unknown>, string]>([
    [
      "another org's event buyers",
      { audienceType: "EVENT_TICKET_HOLDERS", audienceRef: FOREIGN_EVENT_ID },
      "EVENT_NOT_FOUND",
    ],
    [
      "another org's waitlist",
      { audienceType: "WAITLIST_SUBSCRIBERS", audienceRef: FOREIGN_EVENT_ID },
      "EVENT_NOT_FOUND",
    ],
    [
      "a foreign event in MULTIPLE_EVENTS",
      {
        audienceType: "MULTIPLE_EVENTS",
        audienceFilter: { eventIds: [EVENT_ID, FOREIGN_EVENT_ID] },
      },
      "EVENT_NOT_FOUND",
    ],
    [
      "a foreign tier on an own event",
      {
        audienceType: "EVENT_TICKET_TIER",
        audienceFilter: { eventId: EVENT_ID, tierIds: [FOREIGN_TIER_ID] },
      },
      "TICKET_TYPE_NOT_FOUND",
    ],
    [
      "another org's contact list",
      { audienceType: "CONTACT_LIST", audienceRef: FOREIGN_LIST_ID },
      "TARGET_LIST_NOT_FOUND",
    ],
    [
      "another org's list as the exclusion",
      {
        audienceType: "ALL_TICKET_HOLDERS",
        excludedContactListId: FOREIGN_LIST_ID,
      },
      "TARGET_LIST_NOT_FOUND",
    ],
  ])("refuses %s without counting", async (_label, audience, code) => {
    const { deps, announcements } = makeDeps();

    await expect(
      previewAudienceCount(deps, { ...base, ...audience }),
    ).rejects.toMatchObject({ code });
    expect(announcements.countAudienceRecipients).not.toHaveBeenCalled();
  });

  it("refuses an unverified actor before any lookup or count", async () => {
    const { deps, announcements } = makeDeps({ emailVerified: false });

    await expect(
      previewAudienceCount(deps, {
        ...base,
        audienceType: "EVENT_TICKET_HOLDERS",
        audienceRef: EVENT_ID,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(deps.repos.events.getById).not.toHaveBeenCalled();
    expect(announcements.countAudienceRecipients).not.toHaveBeenCalled();
  });
});
