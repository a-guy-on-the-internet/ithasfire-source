import { describe, expect, it, vi } from "vitest";

import { getEventSplits, type GetEventSplitsDeps } from "../get-event-splits";

// The splits read hands back what `updateEventSplits` needs to write a line
// back unchanged: the payee's SUBJECT (org or human) id, which is what
// `payeeRef.id` means on the write. The Payee row id is a different uuid; sent
// as `payeeRef.id` it resolved to no subject, so the write minted a new Payee
// for a subject that doesn't exist and the line's money went to it (seen live
// 2026-10-13 on a RESALE line re-saved from the event's splits editor).

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "66666666-6666-4666-8666-666666666666";
const LINE_ID = "77777777-7777-4777-8777-777777777777";
const PAYEE_ROW_ID = "88888888-8888-4888-8888-888888888888";
const HUMAN_ID = "99999999-9999-4999-8999-999999999999";
const MISSING_PAYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_2_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const line = (id: string, payeeId: string) => ({
  id,
  payeeId,
  ticketTypeId: null,
  percent: 40,
  floorCents: 0,
  capPercent: null,
  priority: 0,
  requiresConfirmation: true,
  confirmationStatus: "PENDING",
  confirmedAt: null,
  counterPercentBps: null,
  counterNote: null,
});

function deps(): GetEventSplitsDeps {
  return {
    repos: {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: ORG_ID,
          humanId: null,
          payoutTermsId: null,
          resalePayoutTermsId: TERMS_ID,
        })),
      },
      payoutTerms: {
        getById: vi.fn(async () => ({ id: TERMS_ID, kind: "RESALE" })),
        listLines: vi.fn(async () => [
          line(LINE_ID, PAYEE_ROW_ID),
          line(LINE_2_ID, MISSING_PAYEE_ID),
        ]),
        listByEvent: vi.fn(async () => []),
      },
      payees: {
        getByIds: vi.fn(async () => [
          {
            id: PAYEE_ROW_ID,
            subjectType: "HUMAN",
            subjectId: HUMAN_ID,
            payoutsEnabled: false,
          },
        ]),
        getBySubject: vi.fn(async () => null),
      },
      eventHumans: { listByEvent: vi.fn(async () => []) },
      humans: {
        getByIds: vi.fn(async () => [{ id: HUMAN_ID, name: "Alex Rivera" }]),
      },
      organizations: { getByIds: vi.fn(async () => []) },
      feePolicies: { resolveEffective: vi.fn(async () => null) },
    },
    authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) },
    clock: { now: () => new Date("2026-10-13T12:00:00Z") },
  } as unknown as GetEventSplitsDeps;
}

describe("getEventSplits — payee subject id", () => {
  it("returns the payee's subject id beside its row id", async () => {
    const out = await getEventSplits(deps(), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "RESALE",
    });

    expect(out.lines[0]).toMatchObject({
      payeeId: PAYEE_ROW_ID,
      payeeSubjectId: HUMAN_ID,
      payeeKind: "human",
      payeeDisplayName: "Alex Rivera",
    });
  });

  it("is null when the payee row is missing", async () => {
    const out = await getEventSplits(deps(), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "RESALE",
    });

    expect(out.lines[1]).toMatchObject({
      payeeId: MISSING_PAYEE_ID,
      payeeSubjectId: null,
      payeeStatus: "missing",
    });
  });
});
