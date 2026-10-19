import { describe, expect, it, vi } from "vitest";

import {
  ASK_ID,
  ATTACHMENT_ID,
  OUTSIDER_ID,
  VENUE_OWNER_ID,
  buildAsk,
  buildAskDeps,
  buildFile,
} from "@th/core/use-cases/booking-requests/asks/__tests__/ask-fakes";
import { ACTOR_ID, REQUEST_ID } from "@th/core/use-cases/booking-requests/__tests__/helpers";

import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

// ── P3b (asks) ───────────────────────────────────────────────────────────────
// Transport wiring for venue-booking-standards v1.1 FR-009: the upload path
// (`attachments.requestUpload` / `attachments.getUrl`) and the asks
// (`asks.ask` / `answer` / `withdraw` / `list` / `suggestions`). Thin passes:
// the actor comes from ctx (a smuggled one is refused by the strict inputs),
// storage is `ctx.fileStorage`, the notices go through `notifyWithEmail`, and
// the typed errors map to tRPC codes.
// ─────────────────────────────────────────────────────────────────────────────

function world(options: Parameters<typeof buildAskDeps>[0] = {}) {
  const f = buildAskDeps(options);
  const fileStorage = {
    ...f.storage,
    presignPutObject: vi.fn(async () => ({ uploadUrl: "https://r2.test/put" })),
  };
  const notifyWithEmail = vi.fn(async () => ({ ok: true }));
  return { f, fileStorage, notifyWithEmail };
}

function callerFor(
  w: ReturnType<typeof world>,
  actorHumanId: string,
) {
  return createCaller(bookingRequestsRouter, {
    repos: w.f.repos,
    fileStorage: w.fileStorage as never,
    notifyWithEmail: w.notifyWithEmail as never,
    publicAppUrl: "https://ithasfire.test",
    actorHumanId,
  });
}

describe("bookingRequests.asks (P3b)", () => {
  it("ask: the venue asks; the sender is told through notifyWithEmail (booking.ask-received)", async () => {
    const w = world();
    const { caller } = callerFor(w, VENUE_OWNER_ID);
    const out = await caller.asks.ask({
      bookingRequestId: REQUEST_ID,
      kind: "IMAGE",
      label: "Poster",
      useAsEventImage: true,
    });
    expect(out).toMatchObject({ status: "OPEN", kind: "IMAGE", useAsEventImage: true });
    expect(w.notifyWithEmail).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ACTOR_ID, variant: "booking.ask-received" }),
    );
  });

  it("ask: a client-smuggled actorHumanId is refused by the strict input", async () => {
    const w = world();
    const { caller } = callerFor(w, VENUE_OWNER_ID);
    await expect(
      caller.asks.ask({
        bookingRequestId: REQUEST_ID,
        kind: "LINK",
        label: "Video",
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answer: an unknown ask maps to NOT_FOUND; a mismatched shape to BAD_REQUEST", async () => {
    const w = world({ asks: [buildAsk({ kind: "LINK" })] });
    const { caller } = callerFor(w, ACTOR_ID);
    await expect(
      caller.asks.answer({
        bookingRequestId: REQUEST_ID,
        askId: "a5a5a5a5-0000-4000-8000-0000000000ff",
        answer: { type: "url", url: "https://video.test/x" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "BOOKING_ASK_NOT_FOUND" });
    await expect(
      caller.asks.answer({
        bookingRequestId: REQUEST_ID,
        askId: ASK_ID,
        answer: { type: "minutes", minutes: 45 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answer → the venue side hears booking.ask-answered; withdraw of the answered ask conflicts", async () => {
    const w = world({ asks: [buildAsk({ kind: "LINK" })] });
    const sender = callerFor(w, ACTOR_ID).caller;
    await expect(
      sender.asks.answer({
        bookingRequestId: REQUEST_ID,
        askId: ASK_ID,
        answer: { type: "url", url: "https://video.test/live" },
      }),
    ).resolves.toMatchObject({ status: "ANSWERED" });
    expect(w.notifyWithEmail).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: VENUE_OWNER_ID, variant: "booking.ask-answered" }),
    );

    const venue = callerFor(w, VENUE_OWNER_ID).caller;
    await expect(
      venue.asks.withdraw({ bookingRequestId: REQUEST_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("list and suggestions pass through; an outsider is FORBIDDEN", async () => {
    const w = world({ asks: [buildAsk()] });
    const venue = callerFor(w, VENUE_OWNER_ID).caller;
    await expect(
      venue.asks.list({ bookingRequestId: REQUEST_ID, side: "VENUE" }),
    ).resolves.toMatchObject({ asks: [expect.objectContaining({ id: ASK_ID })] });
    await expect(
      venue.asks.suggestions({ bookingRequestId: REQUEST_ID }),
    ).resolves.toMatchObject({ degraded: false });

    const outsider = callerFor(w, OUTSIDER_ID).caller;
    await expect(
      outsider.asks.list({ bookingRequestId: REQUEST_ID, side: "VENUE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("bookingRequests.attachments upload + open (P3b)", () => {
  it("requestUpload presigns through ctx.fileStorage under the request's namespace", async () => {
    const w = world();
    const { caller } = callerFor(w, ACTOR_ID);
    const out = await caller.attachments.requestUpload({
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });
    expect(out.key.startsWith(`booking-requests/${REQUEST_ID}/`)).toBe(true);
    expect(w.fileStorage.presignPutObject).toHaveBeenCalledTimes(1);
  });

  it("getUrl signs a GET for a participant; an outsider is FORBIDDEN and nothing is signed", async () => {
    const w = world({ files: [buildFile()] });
    await expect(
      callerFor(w, ACTOR_ID).caller.attachments.getUrl({
        bookingRequestId: REQUEST_ID,
        side: "PERFORMER",
        attachmentId: ATTACHMENT_ID,
      }),
    ).resolves.toMatchObject({ fileName: "poster.jpg" });

    w.fileStorage.getObjectUrl.mockClear();
    await expect(
      callerFor(w, OUTSIDER_ID).caller.attachments.getUrl({
        bookingRequestId: REQUEST_ID,
        side: "PERFORMER",
        attachmentId: ATTACHMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.fileStorage.getObjectUrl).not.toHaveBeenCalled();
  });
});
