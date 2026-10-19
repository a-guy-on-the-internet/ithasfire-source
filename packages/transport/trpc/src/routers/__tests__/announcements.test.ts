import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { announcementsRouter } from "../announcements";
import * as announcementUseCases from "@th/core/use-cases/announcements";
import { createTestLogger } from "@th/test-utils";

// Regression for the 2026-09-29 prod incident: `announcements.send` and
// `announcements.sendTest` answered malformed bodies with a 500
// ("Cannot read properties of undefined (reading 'ownerId')"). The per-route
// rateLimit middleware was chained BEFORE `.input(...)`, and in tRPC v11 a
// middleware only sees `input` once the input parser middleware has run —
// so the limiter's `key` read `input.ownerId` off `undefined` for EVERY call,
// well-formed ones included. Parsing now runs first; malformed input is a 400
// before the limiter or any use-case code runs.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ANNOUNCEMENT_ID = "33333333-3333-4333-8333-333333333333";

const buildCtx = () => {
  const consume = vi.fn(async () => ({
    allowed: true,
    remaining: Number.POSITIVE_INFINITY,
    retryAfterSeconds: 0,
  }));
  const ctx = {
    repos: {} as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => new Date("2026-09-29T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"],
    actorHumanId: ACTOR_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
  } as unknown as Ctx;
  return { ctx, consume };
};

const callerFor = (ctx: Ctx) =>
  trpcRouter({ announcements: router(announcementsRouter) }).createCaller(ctx);

const validSend = {
  ownerType: "ORGANIZATION" as const,
  ownerId: ORG_ID,
  subject: "Doors at 8",
  bodyDoc: {
    type: "doc" as const,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "See you" }] },
    ],
  },
  bodyHtml: "<p>See you</p>",
  audienceType: "ALL_TICKET_HOLDERS" as const,
};

const validSendTest = {
  ownerType: "ORGANIZATION" as const,
  ownerId: ORG_ID,
  subject: "Doors at 8",
  bodyHtml: "<p>See you</p>",
};

const expectBadRequest = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe("BAD_REQUEST");
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("announcements.send input validation", () => {
  it("rejects {} with BAD_REQUEST before the limiter or use case runs", async () => {
    const { ctx, consume } = buildCtx();
    const spy = vi.spyOn(announcementUseCases, "sendAnnouncement");

    await expectBadRequest(
      callerFor(ctx).announcements.send({} as never),
    );

    expect(spy).not.toHaveBeenCalled();
    // Only the default floor limiter ran; the per-route one (keyed on input)
    // never saw the unparsed body.
    expect(consume).not.toHaveBeenCalledWith(
      expect.stringMatching(/^announce:send:/),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects a body missing the nested bodyDoc object with BAD_REQUEST", async () => {
    const { ctx } = buildCtx();
    const spy = vi.spyOn(announcementUseCases, "sendAnnouncement");
    const { bodyDoc: _omit, ...withoutDoc } = validSend;

    await expectBadRequest(
      callerFor(ctx).announcements.send(withoutDoc as never),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an undefined body with BAD_REQUEST", async () => {
    const { ctx } = buildCtx();
    await expectBadRequest(
      callerFor(ctx).announcements.send(undefined as never),
    );
  });

  it("a well-formed body reaches the use case and the limiter keys on the parsed ownerId", async () => {
    const { ctx, consume } = buildCtx();
    const spy = vi
      .spyOn(announcementUseCases, "sendAnnouncement")
      .mockResolvedValue({
        id: ANNOUNCEMENT_ID,
        sentAt: new Date("2026-09-29T00:00:00.000Z"),
      });

    const out = await callerFor(ctx).announcements.send(validSend);

    expect(out.id).toBe(ANNOUNCEMENT_ID);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerId: ORG_ID, actorHumanId: ACTOR_ID }),
    );
    expect(consume).toHaveBeenCalledWith(
      // Keyed on the actor too (F4): the owner id is caller-chosen.
      `announce:send:${ACTOR_ID}:${ORG_ID}:ALL_TICKET_HOLDERS:all`,
      5,
      300,
    );
  });
});

describe("announcements.sendTest input validation", () => {
  it("rejects {} with BAD_REQUEST before the use case runs", async () => {
    const { ctx, consume } = buildCtx();
    const spy = vi.spyOn(announcementUseCases, "sendTestAnnouncement");

    await expectBadRequest(
      callerFor(ctx).announcements.sendTest({} as never),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalledWith(
      expect.stringMatching(/^announce:test:/),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects an undefined body with BAD_REQUEST", async () => {
    const { ctx } = buildCtx();
    await expectBadRequest(
      callerFor(ctx).announcements.sendTest(undefined as never),
    );
  });

  it("a well-formed body reaches the use case and the limiter keys on the parsed ownerId", async () => {
    const { ctx, consume } = buildCtx();
    const spy = vi
      .spyOn(announcementUseCases, "sendTestAnnouncement")
      .mockResolvedValue({ sentToEmail: "me@example.com" });

    const out = await callerFor(ctx).announcements.sendTest(validSendTest);

    expect(out.sentToEmail).toBe("me@example.com");
    expect(spy).toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith(
      `announce:test:${ACTOR_ID}:${ORG_ID}`,
      10,
      60,
    );
  });
});
