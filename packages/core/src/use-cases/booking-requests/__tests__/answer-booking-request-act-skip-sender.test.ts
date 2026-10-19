import { describe, expect, it, vi } from "vitest";

import {
  confirmBookingRequestAct,
  declineBookingRequestAct,
  passBookingRequestAct,
  type AnswerBookingRequestActDeps,
} from "../answer-booking-request-act";
import { notifyBookingLineupAnswered } from "../notify-booking-lineup-answered";
import {
  ACTOR_ID,
  NOW,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// `skipSenderNoticeFor` (owner ruling 2026-10-01): a server-side caller of the
// PASS may leave named humans out of the sender's in-app "{act} left / passed
// on your bill" — a lineup leave tells the event's editors with
// `event.lineup-left` instead. The DEFAULT (no option) must be byte-for-byte
// today's call, for confirm and for decline.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST = OTHER_HUMAN_ID;
const BAND_ORG = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const BAND_A = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
const BAND_B = "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c";

async function buildDeps(
  options: { sender?: { type: "human" | "organization"; id: string } } = {},
) {
  const request = buildBookingRequestRecord({
    performerOwnerType: options.sender?.type ?? "human",
    performerOwnerId: options.sender?.id ?? ACTOR_ID,
  });
  const repos = withTx({
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    },
    agreements: { getById: vi.fn(async () => null) },
    events: { getById: vi.fn(async () => null) },
    eventHumans: { listByEvent: vi.fn(async () => []), attach: vi.fn() },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === ARTIST ? "Artie Artist" : "Sam Sender", status: "ACTIVE" })),
      ),
      getByIdWithIdentity: vi.fn(async () => null),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, name: "The Band", slug: "the-band" })),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async () => ({
        items: [
          { humanId: BAND_A, role: "OWNER" },
          { humanId: BAND_B, role: "EDITOR" },
        ],
        total: 2,
      })),
    },
    entityPages: {
      getByOwner: vi.fn(async () => null),
      getByOwners: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}) },
    authz: { getOrgMembership: vi.fn(async () => null) },
  });
  const acts = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST, sortOrder: 1, invitedAt: NOW },
  ]);
  const notifyBookingLineupAnsweredSpy = vi.fn(async (_args: any) => {});
  const deps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock: { now: () => NOW },
    notifyBookingLineupAnswered: notifyBookingLineupAnsweredSpy,
  } satisfies AnswerBookingRequestActDeps;
  return { deps, repos, notifyBookingLineupAnsweredSpy };
}

const DEFAULT_ARG_KEYS = ["act", "actName", "actorHumanId", "answer", "bookingRequest"];
const input = { actorHumanId: ARTIST, bookingRequestId: REQUEST_ID };

describe("answerBookingRequestAct — skipSenderNoticeFor", () => {
  it("default decline: the sender-notice call is exactly today's (no skip key at all)", async () => {
    const { deps, notifyBookingLineupAnsweredSpy } = await buildDeps();
    await declineBookingRequestAct(deps, input);
    expect(notifyBookingLineupAnsweredSpy).toHaveBeenCalledTimes(1);
    const args = notifyBookingLineupAnsweredSpy.mock.calls[0]![0];
    expect(Object.keys(args).sort()).toEqual(DEFAULT_ARG_KEYS);
    expect(args).toMatchObject({ answer: "passed", actorHumanId: ARTIST });
  });

  it("default confirm: unchanged too; an EMPTY skip list is the default", async () => {
    const confirm = await buildDeps();
    await confirmBookingRequestAct(confirm.deps, input);
    expect(Object.keys(confirm.notifyBookingLineupAnsweredSpy.mock.calls[0]![0]).sort()).toEqual(
      DEFAULT_ARG_KEYS,
    );

    const empty = await buildDeps();
    await passBookingRequestAct(empty.deps, input, { skipSenderNoticeFor: [] });
    expect(Object.keys(empty.notifyBookingLineupAnsweredSpy.mock.calls[0]![0]).sort()).toEqual(
      DEFAULT_ARG_KEYS,
    );
  });

  it("the option reaches the sender notice; the ANSWER itself is unchanged", async () => {
    const { deps, notifyBookingLineupAnsweredSpy } = await buildDeps();
    const out = await passBookingRequestAct(deps, input, { skipSenderNoticeFor: [BAND_A] });
    expect(out).toMatchObject({ confirmation: "DECLINED", changed: true });
    expect(notifyBookingLineupAnsweredSpy.mock.calls[0]![0].skipRecipientHumanIds).toEqual([BAND_A]);
  });

  it("the client input schema stays strict: the option cannot ride in on the input", async () => {
    const { deps } = await buildDeps();
    await expect(
      declineBookingRequestAct(deps, { ...input, skipSenderNoticeFor: [BAND_A] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("notifyBookingLineupAnswered — skipRecipientHumanIds", () => {
  async function run(skip?: string[]) {
    const { repos } = await buildDeps();
    const notify = vi.fn(async (_input: any) => ({ ok: true }));
    const request = buildBookingRequestRecord({
      performerOwnerType: "organization",
      performerOwnerId: BAND_ORG,
    });
    await notifyBookingLineupAnswered(
      { repos: repos as any, notify: notify as any, publicAppUrl: "https://ithasfire.com" },
      {
        bookingRequest: request,
        act: { id: "act-1", respondedAt: NOW, updatedAt: NOW } as any,
        actName: "Artie Artist",
        answer: "left",
        actorHumanId: ARTIST,
        ...(skip ? { skipRecipientHumanIds: skip } : {}),
      },
    );
    return notify.mock.calls.map((c) => c[0].humanId).sort();
  }

  it("absent → every sender-side editor; named → those are left out, the rest still hear", async () => {
    expect(await run()).toEqual([BAND_A, BAND_B].sort());
    expect(await run([BAND_A])).toEqual([BAND_B]);
    expect(await run([BAND_A, BAND_B])).toEqual([]);
  });
});
