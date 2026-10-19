import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { listBookingRequestMessages } from "../messages/list-messages";
import type { ListBookingRequestMessagesDeps } from "../messages/list-messages";
import { markBookingRequestMessagesRead } from "../messages/mark-read";
import type { MarkBookingRequestMessagesReadDeps } from "../messages/mark-read";
import { postBookingRequestMessage } from "../messages/post-message";
import type { PostBookingRequestMessageDeps } from "../messages/post-message";
import {
  ACTOR_ID,
  NOW,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// FR-008: a CONFIRMED tagged artist reads the request thread (side "ACT"),
// read-only. ACTOR_ID is the sender; OTHER_HUMAN_ID the tagged artist.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST_ID = OTHER_HUMAN_ID;
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";

function buildDeps(
  options: {
    request?: BookingRequestRecord;
    reportError?: ListBookingRequestMessagesDeps["reportError"];
    logger?: ListBookingRequestMessagesDeps["logger"];
  } = {},
) {
  const request = options.request ?? buildBookingRequestRecord();
  const messages = createFakeBookingRequestMessagesRepo();
  const bookingRequests = {
    getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    touchLastMessageAt: vi.fn(async () => {}),
  };
  const place = buildPlaceRecord({ humanIdsWithAccess: [VENUE_OWNER_ID] });
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
  };
  const authz = {
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: [VENUE_OWNER_ID],
    })),
    getOrgMembership: vi.fn(async () => null),
    getOrgMemberships: vi.fn(async () => []),
  };
  const repos = withTx({
    bookingRequests,
    bookingRequestMessages: messages,
    places,
    authz,
    audit: { log: vi.fn(async () => {}) },
  });
  const deps = {
    repos: repos as unknown as ListBookingRequestMessagesDeps["repos"],
    clock: { now: () => NOW },
    ...(options.reportError ? { reportError: options.reportError } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  return { deps, repos, messages };
}

type Repos = ReturnType<typeof buildDeps>["repos"];

async function tagArtist(repos: Repos, answer?: "CONFIRMED" | "DECLINED") {
  const acts = repos.bookingRequests as unknown as ListBookingRequestMessagesDeps["repos"]["bookingRequests"];
  const [act] = await acts.addActs(REQUEST_ID, [
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_ID, sortOrder: 0 },
  ]);
  if (answer) {
    await acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: ARTIST_ID,
      expectedFrom: "PENDING",
      to: answer,
      respondedAt: NOW,
    });
  }
  return act!;
}

/**
 * A thread with a message each way, one entry from each hidden family, and
 * the artist's own `act_confirmed` (keyed by their REAL act id — a
 * confirmation whose act is no longer CONFIRMED is hidden).
 */
function seedThread(
  messages: ReturnType<typeof createFakeBookingRequestMessagesRepo>,
  actId: string = crypto.randomUUID(),
) {
  messages.seed({ bookingRequestId: REQUEST_ID, authorSide: "PERFORMER", body: "Hi!" });
  messages.seed({ bookingRequestId: REQUEST_ID, authorSide: "VENUE", body: "Hello back" });
  messages.seed({
    bookingRequestId: REQUEST_ID,
    authorSide: "SYSTEM",
    body: "",
    systemKind: "booking_request.assigned",
    systemData: { assigneeHumanId: VENUE_OWNER_ID, previousAssigneeHumanId: null },
  });
  messages.seed({
    bookingRequestId: REQUEST_ID,
    authorSide: "SYSTEM",
    body: "",
    systemKind: "booking_request.act_declined",
    systemData: { actId: crypto.randomUUID(), actName: "Someone Else" },
  });
  messages.seed({
    bookingRequestId: REQUEST_ID,
    authorSide: "SYSTEM",
    body: "",
    systemKind: "booking_request.act_confirmed",
    systemData: { actId, actName: "Artie" },
  });
}

const actRead = { actorHumanId: ARTIST_ID, bookingRequestId: REQUEST_ID, side: "ACT" };

describe("booking thread — confirmed act (side ACT, FR-008)", () => {
  it("a CONFIRMED tagged artist reads the thread: messages + shared entries, no venue-internal, no sender-only", async () => {
    const { deps, repos, messages } = buildDeps();
    const act = await tagArtist(repos, "CONFIRMED");
    seedThread(messages, act.id);

    const page = await listBookingRequestMessages(deps, actRead);

    expect(page.items.map((row) => row.systemKind ?? row.body)).toEqual([
      "Hi!",
      "Hello back",
      "booking_request.act_confirmed",
    ]);
  });

  it("a PENDING or DECLINED artist is refused, as is a stranger", async () => {
    for (const answer of [undefined, "DECLINED"] as const) {
      const { deps, repos } = buildDeps();
      await tagArtist(repos, answer);
      await expect(listBookingRequestMessages(deps, actRead)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
    const { deps } = buildDeps();
    await expect(
      listBookingRequestMessages(deps, { ...actRead, actorHumanId: VENUE_OWNER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("the SENDER cannot read as ACT (their SELF row is not a tagged spot)", async () => {
    const { deps, repos } = buildDeps();
    const acts = repos.bookingRequests as unknown as ListBookingRequestMessagesDeps["repos"]["bookingRequests"];
    await acts.addActs(REQUEST_ID, [{ source: "SELF", sortOrder: 0 }]);

    await expect(
      listBookingRequestMessages(deps, { ...actRead, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("a TO_PERFORMER request has no bill — ACT is always refused there", async () => {
    const { deps } = buildDeps({ request: buildOrganizerBookingRequestRecord() });
    await expect(listBookingRequestMessages(deps, actRead)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("a confirmed act can NEVER post: ACT is not a writer's side, and PERFORMER is the sender's", async () => {
    const { deps, repos, messages } = buildDeps();
    await tagArtist(repos, "CONFIRMED");
    const postDeps = deps as unknown as PostBookingRequestMessageDeps;
    const body = { actorHumanId: ARTIST_ID, bookingRequestId: REQUEST_ID, body: "Can I post?" };

    await expect(
      postBookingRequestMessage(postDeps, { ...body, side: "ACT" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      postBookingRequestMessage(postDeps, { ...body, side: "PERFORMER" }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      postBookingRequestMessage(postDeps, { ...body, side: "VENUE" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_RESOURCE_OWNER|INSUFFICIENT_ROLE/) });
    expect(messages.rows.size).toBe(0);
  });

  it("markRead as ACT is a no-op success that stamps nothing — and still gates", async () => {
    const { deps, repos, messages } = buildDeps();
    await tagArtist(repos, "CONFIRMED");
    seedThread(messages);
    const markDeps = deps as unknown as MarkBookingRequestMessagesReadDeps;
    const upTo = new Date(Date.now() + 60_000);

    await expect(
      markBookingRequestMessagesRead(markDeps, { ...actRead, upToCreatedAt: upTo }),
    ).resolves.toEqual({ updated: 0 });
    expect([...messages.rows.values()].every((row) => row.readAt === null)).toBe(true);
    expect(repos.tx).not.toHaveBeenCalled();

    // A pending artist gets the refusal, not a quiet success.
    const pending = buildDeps();
    await tagArtist(pending.repos);
    await expect(
      markBookingRequestMessagesRead(
        pending.deps as unknown as MarkBookingRequestMessagesReadDeps,
        { ...actRead, upToCreatedAt: upTo },
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("if the act state cannot be read, VENUE and ACT fail CLOSED (no act confirmations) and it is reported; the sender is untouched", async () => {
    const reportError = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const { deps, repos, messages } = buildDeps({
      reportError,
      logger: logger as unknown as ListBookingRequestMessagesDeps["logger"],
    });
    const act = await tagArtist(repos, "CONFIRMED");
    seedThread(messages, act.id);
    const lookupError = new Error("acts table on fire");
    (repos.bookingRequests as unknown as { listActsForRequests: unknown }).listActsForRequests =
      vi.fn(async () => {
        throw lookupError;
      });

    const venue = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(venue.items.map((row) => row.systemKind ?? row.body)).toEqual([
      "Hi!",
      "Hello back",
      "booking_request.assigned",
    ]);
    expect(reportError).toHaveBeenCalledWith(lookupError, {
      tags: { useCase: "listBookingRequestMessages", step: "actConfirmations" },
      extra: { bookingRequestId: REQUEST_ID, side: "VENUE" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.messages.act_state_lookup_failed",
      expect.objectContaining({ bookingRequestId: REQUEST_ID, side: "VENUE", err: lookupError }),
    );

    const actSide = await listBookingRequestMessages(deps, actRead);
    expect(actSide.items.map((row) => row.systemKind)).not.toContain(
      "booking_request.act_confirmed",
    );
    expect(reportError).toHaveBeenCalledTimes(2);

    // The sender's history needs no act read at all.
    const sender = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(sender.items.map((row) => row.systemKind)).toContain(
      "booking_request.act_confirmed",
    );
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("a throwing reporter never breaks the fail-closed fallback", async () => {
    const { deps, repos, messages } = buildDeps({
      reportError: vi.fn(() => {
        throw new Error("reporter down too");
      }),
    });
    const act = await tagArtist(repos, "CONFIRMED");
    seedThread(messages, act.id);
    (repos.bookingRequests as unknown as { listActsForRequests: unknown }).listActsForRequests =
      vi.fn(async () => {
        throw new Error("down");
      });

    const page = await listBookingRequestMessages(deps, actRead);
    expect(page.items.map((row) => row.body)).toEqual(["Hi!", "Hello back"]);
  });
});
