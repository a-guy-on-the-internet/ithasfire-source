import { describe, expect, it } from "vitest";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_STRIP_CONCURRENCY,
  IMAGE_STRIP_MAX_WAITING,
  withImageStripSlot,
} from "../../../storage/strip-uploaded-image";

import {
  ACTOR_ID,
  NOW,
  ORGANIZER_ORG_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  systemEntriesFor,
} from "../../__tests__/helpers";
import { askOnBookingRequest } from "../ask-on-booking-request";
import { answerBookingRequestAsk } from "../answer-booking-request-ask";
import { withdrawBookingRequestAsk } from "../withdraw-booking-request-ask";
import {
  listBookingRequestAskSuggestions,
  listBookingRequestAsks,
} from "../list-booking-request-asks";
import { askEventImageKey, mapAskImageToEvent } from "../map-ask-answers";
import {
  SECRET,
  SOI,
  cleanJpeg,
  exifApp1,
  jpegImageData,
  phoneJpeg,
} from "../../../../lib/images/__tests__/image-fixtures";
import {
  AGREEMENT_ID,
  ASK_ID,
  ATTACHMENT_ID,
  EVENT_ID,
  OUTSIDER_ID,
  VENUE_EDITOR_ID,
  VENUE_OWNER_ID,
  VENUE_VIEWER_ID,
  buildAsk,
  buildAskDeps,
  buildFile,
} from "./ask-fakes";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request ASKS (venue-booking-standards v1.1, V9–V11, FR-009b/c/d).
// ─────────────────────────────────────────────────────────────────────────────

const askInput = (over: Record<string, unknown> = {}) => ({
  actorHumanId: VENUE_OWNER_ID,
  bookingRequestId: REQUEST_ID,
  kind: "IMAGE",
  label: "Poster",
  useAsEventImage: true,
  ...over,
});

const answerInput = (answer: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  actorHumanId: ACTOR_ID,
  bookingRequestId: REQUEST_ID,
  askId: ASK_ID,
  answer,
  ...over,
});

describe("askOnBookingRequest", () => {
  it("the venue asks: an OPEN ask, the ledger entry, an audit row, the sender's notice", async () => {
    const f = buildAskDeps();
    const out = await askOnBookingRequest(f, askInput({ note: "  Portrait, please  " }));

    expect(out).toMatchObject({
      kind: "IMAGE",
      label: "Poster",
      note: "Portrait, please",
      useAsEventImage: true,
      status: "OPEN",
      answer: null,
      askedByHumanId: VENUE_OWNER_ID,
    });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toEqual([
      expect.objectContaining({
        systemKind: "booking_request.ask_opened",
        systemData: { askId: out.id, kind: "IMAGE", label: "Poster" },
        authorHumanId: VENUE_OWNER_ID,
      }),
    ]);
    expect(f.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.ask_opened" }),
    );
    expect(f.notifyBookingRequestAsk).toHaveBeenCalledWith(
      expect.objectContaining({ event: "asked", actorHumanId: VENUE_OWNER_ID }),
    );
  });

  it("an org edit-role member of the venue may ask; a VIEWER may not", async () => {
    const f = buildAskDeps();
    await expect(
      askOnBookingRequest(f, askInput({ actorHumanId: VENUE_EDITOR_ID })),
    ).resolves.toMatchObject({ status: "OPEN" });
    await expect(
      askOnBookingRequest(f, askInput({ actorHumanId: VENUE_VIEWER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("the sender cannot ask (only the venue asks, V11); an outsider cannot either", async () => {
    const f = buildAskDeps();
    await expect(
      askOnBookingRequest(f, askInput({ actorHumanId: ACTOR_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      askOnBookingRequest(f, askInput({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(f.mocks.bookingRequests.createAsk).not.toHaveBeenCalled();
  });

  it.each(["DECLINED", "WITHDRAWN", "EXPIRED"] as const)(
    "a %s request takes no asks (INVALID_STATUS booking_request_closed)",
    async (status) => {
      const f = buildAskDeps({ request: buildBookingRequestRecord({ status }) });
      await expect(askOnBookingRequest(f, askInput())).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "booking_request_closed",
      });
      expect(f.mocks.bookingRequests.createAsk).not.toHaveBeenCalled();
    },
  );

  it("an open request past its expiry is closed too; an ACCEPTED one takes asks", async () => {
    const stale = buildAskDeps({
      request: buildBookingRequestRecord({ expiresAt: new Date(NOW.getTime() - 1) }),
    });
    await expect(askOnBookingRequest(stale, askInput())).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
    const accepted = buildAskDeps({
      request: buildBookingRequestRecord({ status: "ACCEPTED", expiresAt: null }),
    });
    await expect(askOnBookingRequest(accepted, askInput())).resolves.toMatchObject({
      status: "OPEN",
    });
  });

  it("a cancelled booking takes no asks (BOOKING_CANCELLED)", async () => {
    const f = buildAskDeps({
      request: buildBookingRequestRecord({ status: "ACCEPTED", expiresAt: null }),
    });
    f.holds().seed({
      bookingRequestId: REQUEST_ID,
      calendarId: "ca1ca1ca-0000-4000-8000-000000000001",
      date: "2026-07-10",
      status: "RELEASED",
      releasedReason: "BOOKING_CANCELLED",
    });
    await expect(askOnBookingRequest(f, askInput())).rejects.toMatchObject({
      code: "BOOKING_CANCELLED",
    });
  });

  it("'use as the event image' is IMAGE-only; the label is sanitized and capped", async () => {
    const f = buildAskDeps();
    await expect(
      askOnBookingRequest(f, askInput({ kind: "FILE", useAsEventImage: true })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      askOnBookingRequest(f, askInput({ label: "x".repeat(81) })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const out = await askOnBookingRequest(f, askInput({ label: "<b>Rider</b>", kind: "FILE", useAsEventImage: undefined }));
    expect(out.label).not.toContain("<b>");
  });

  it("organizer → act requests take no asks (V11: only the venue asks)", async () => {
    // The actor passes the thread gate (an edit-role member of the sending
    // organizer org) — it is the direction that refuses.
    const f = buildAskDeps({
      request: buildOrganizerBookingRequestRecord(),
      memberships: { [`${ORGANIZER_ORG_ID}:${VENUE_EDITOR_ID}`]: "ADMIN" },
    });
    await expect(
      askOnBookingRequest(f, askInput({ actorHumanId: VENUE_EDITOR_ID })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_asks_venue_only" });
    expect(f.mocks.bookingRequests.createAsk).not.toHaveBeenCalled();
  });

  it("a throwing notifier never fails the committed ask (logged + reported)", async () => {
    const f = buildAskDeps();
    f.notifyBookingRequestAsk.mockRejectedValueOnce(new Error("smtp down"));
    await expect(askOnBookingRequest(f, askInput())).resolves.toMatchObject({
      status: "OPEN",
    });
    expect(f.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "askOnBookingRequest" }) }),
    );
  });
});

describe("answerBookingRequestAsk — the answer's shape matches the kind", () => {
  const SHAPES = {
    attachment: { type: "attachment", attachmentId: ATTACHMENT_ID },
    url: { type: "url", url: "https://video.test/live" },
    text: { type: "text", text: "Two guitars, a drum kit." },
    minutes: { type: "minutes", minutes: 45 },
  } as const;
  const TAKES = {
    IMAGE: "attachment",
    FILE: "attachment",
    LINK: "url",
    TEXT: "text",
    SET_LENGTH: "minutes",
  } as const;

  for (const [kind, takes] of Object.entries(TAKES)) {
    for (const [type, answer] of Object.entries(SHAPES)) {
      if (type === takes) continue;
      it(`${kind} refuses a ${type} answer`, async () => {
        const f = buildAskDeps({
          asks: [buildAsk({ kind: kind as keyof typeof TAKES })],
          files: [buildFile()],
        });
        await expect(
          answerBookingRequestAsk(f, answerInput(answer)),
        ).rejects.toMatchObject({
          code: "INVALID_INPUT",
          message: "answer_does_not_match_ask",
        });
        expect(f.mocks.bookingRequests.answerAsk).not.toHaveBeenCalled();
      });
    }
  }

  it("LINK takes an http(s) URL only; TEXT is sanitized and capped; SET_LENGTH is 5–600", async () => {
    const link = buildAskDeps({ asks: [buildAsk({ kind: "LINK" })] });
    await expect(
      answerBookingRequestAsk(link, answerInput({ type: "url", url: "javascript:alert(1)" })),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const text = buildAskDeps({ asks: [buildAsk({ kind: "TEXT" })] });
    await expect(
      answerBookingRequestAsk(text, answerInput({ type: "text", text: "y".repeat(2001) })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const saved = await answerBookingRequestAsk(
      text,
      answerInput({ type: "text", text: "<script>x</script>Bio" }),
    );
    expect(saved.answer).toMatchObject({ type: "text" });
    expect(JSON.stringify(saved.answer)).not.toContain("<script>");

    const minutes = buildAskDeps({ asks: [buildAsk({ kind: "SET_LENGTH" })] });
    for (const bad of [4, 601, 45.5]) {
      await expect(
        answerBookingRequestAsk(minutes, answerInput({ type: "minutes", minutes: bad })),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });
});

describe("answerBookingRequestAsk", () => {
  it("the sender answers a LINK ask: ANSWERED, ledger, venue notice", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ kind: "LINK" })] });
    const out = await answerBookingRequestAsk(
      f,
      answerInput({ type: "url", url: "https://video.test/live" }),
    );
    expect(out).toMatchObject({
      status: "ANSWERED",
      answer: { type: "url", url: "https://video.test/live" },
      answeredByHumanId: ACTOR_ID,
    });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toEqual([
      expect.objectContaining({
        systemKind: "booking_request.ask_answered",
        systemData: { askId: ASK_ID, kind: "LINK", label: "Live video", replaced: false },
      }),
    ]);
    expect(f.notifyBookingRequestAsk).toHaveBeenCalledWith(
      expect.objectContaining({ event: "answered" }),
    );
  });

  it("the venue cannot answer; an outsider cannot", async () => {
    const f = buildAskDeps({ asks: [buildAsk()] });
    for (const actor of [VENUE_OWNER_ID, OUTSIDER_ID]) {
      await expect(
        answerBookingRequestAsk(
          f,
          answerInput({ type: "url", url: "https://video.test/x" }, { actorHumanId: actor }),
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
  });

  it("an ask on another request is BOOKING_ASK_NOT_FOUND", async () => {
    const f = buildAskDeps({
      asks: [buildAsk({ bookingRequestId: "99999999-9999-4999-8999-999999999999" })],
    });
    await expect(
      answerBookingRequestAsk(f, answerInput({ type: "url", url: "https://video.test/x" })),
    ).rejects.toMatchObject({ code: "BOOKING_ASK_NOT_FOUND" });
  });

  it("a WITHDRAWN ask refuses an answer", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ status: "WITHDRAWN" })] });
    await expect(
      answerBookingRequestAsk(f, answerInput({ type: "url", url: "https://video.test/x" })),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_ask_withdrawn" });
  });

  it("an ANSWERED ask may be answered again (replace); the ledger says it replaced", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ kind: "LINK" })] });
    await answerBookingRequestAsk(f, answerInput({ type: "url", url: "https://video.test/a" }));
    const again = await answerBookingRequestAsk(
      f,
      answerInput({ type: "url", url: "https://video.test/b" }),
    );
    expect(again.answer).toEqual({ type: "url", url: "https://video.test/b" });
    expect(
      systemEntriesFor(f.repos, REQUEST_ID).map((e) => e.systemData?.replaced),
    ).toEqual([false, true]);
  });

  it("a concurrent answer that landed first wins the CAS; the loser gets INVALID_STATUS booking_ask_changed", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ kind: "LINK" })] });
    // Another answer lands between this call's read and its write.
    f.mocks.bookingRequests.answerAsk.mockImplementationOnce(async () => {
      f.asks.set(ASK_ID, buildAsk({ kind: "LINK", status: "ANSWERED", answerRevision: 1, answerUrl: "https://video.test/first" }));
      return null;
    });
    await expect(
      answerBookingRequestAsk(f, answerInput({ type: "url", url: "https://video.test/second" })),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_ask_changed" });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toEqual([]);
  });

  it("an answer racing a withdraw that won: refused as withdrawn, nothing written", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ kind: "LINK" })] });
    f.mocks.bookingRequests.answerAsk.mockImplementationOnce(async () => {
      f.asks.set(ASK_ID, buildAsk({ kind: "LINK", status: "WITHDRAWN" }));
      return null;
    });
    await expect(
      answerBookingRequestAsk(f, answerInput({ type: "url", url: "https://video.test/x" })),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_ask_withdrawn" });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toEqual([]);
  });

  describe("an attachment answer", () => {
    it("IMAGE: the sender's image uploaded for this ask, checked in storage", async () => {
      const f = buildAskDeps({ asks: [buildAsk({ kind: "IMAGE" })], files: [buildFile()] });
      const out = await answerBookingRequestAsk(
        f,
        answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }),
      );
      expect(out.answer).toEqual({
        type: "attachment",
        attachmentId: ATTACHMENT_ID,
        fileName: "poster.jpg",
        contentType: "image/jpeg",
        sizeBytes: 4096,
      });
      expect(f.storage.headObject).toHaveBeenCalled();
    });

    it("IMAGE refuses a PDF", async () => {
      const f = buildAskDeps({
        asks: [buildAsk({ kind: "IMAGE" })],
        files: [buildFile({ contentType: "application/pdf", storageKey: `booking-requests/${REQUEST_ID}/r.pdf` })],
      });
      await expect(
        answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "ask_needs_an_image" });
    });

    it("a file not uploaded for THIS ask, or by the venue side, is refused", async () => {
      for (const file of [
        buildFile({ askId: null }),
        buildFile({ askId: "a5a5a5a5-0000-4000-8000-000000000009" }),
        buildFile({ uploadedBySide: "VENUE" }),
      ]) {
        const f = buildAskDeps({ asks: [buildAsk({ kind: "FILE" })], files: [file] });
        await expect(
          answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
        ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "attachment_not_for_this_ask" });
      }
    });

    it("a deleted file, or one gone from storage, is refused", async () => {
      const deleted = buildAskDeps({
        asks: [buildAsk({ kind: "FILE" })],
        files: [buildFile({ deletedAt: NOW })],
      });
      await expect(
        answerBookingRequestAsk(deleted, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
      ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });

      const gone = buildAskDeps({
        asks: [buildAsk({ kind: "FILE" })],
        files: [buildFile()],
        heads: { [`booking-requests/${REQUEST_ID}/poster.jpg`]: { exists: false } },
      });
      await expect(
        answerBookingRequestAsk(gone, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
      ).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    });

    it("replacing a file answer soft-deletes the old file and enqueues its bytes for GC, in the same tx", async () => {
      const OLD = "a11a11a1-0000-4000-8000-0000000000aa";
      const f = buildAskDeps({
        asks: [buildAsk({ kind: "FILE", status: "ANSWERED", answerAttachmentId: OLD, answerRevision: 1 })],
        files: [
          buildFile({ id: OLD, storageKey: `booking-requests/${REQUEST_ID}/old.jpg` }),
          buildFile(),
        ],
      });
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.files.get(OLD)?.deletedAt).not.toBeNull();
      expect(f.mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
        expect.objectContaining({
          targetKey: `booking-requests/${REQUEST_ID}/old.jpg`,
          source: "booking_request_attachment",
          sourceId: OLD,
        }),
      ]);
      // ── review W2 ── the old file's UPLOADER gets its quota back, once.
      expect(f.mocks.resourceQuotas.incrementUsage).toHaveBeenCalledTimes(1);
      expect(f.mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
        subjectType: "HUMAN",
        subjectId: ACTOR_ID,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -4096n,
      });
    });

    it("re-answering with the SAME file supersedes nothing: no delete, no refund", async () => {
      const f = buildAskDeps({
        asks: [buildAsk({ kind: "FILE", status: "ANSWERED", answerAttachmentId: ATTACHMENT_ID, answerRevision: 1 })],
        files: [buildFile()],
      });
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.mocks.bookingRequests.softDeleteAttachment).not.toHaveBeenCalled();
      expect(f.mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
    });
  });

  describe("SET_LENGTH → the DRAFT terms' end (V10)", () => {
    const START = new Date("2026-07-10T01:00:00.000Z");

    it("sets proposedEndDate = proposedDate + minutes on DRAFT terms", async () => {
      const f = buildAskDeps({
        request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        asks: [buildAsk({ kind: "SET_LENGTH", label: "Set length" })],
        agreement: buildAgreementRecord({ id: AGREEMENT_ID, status: "DRAFT", proposedDate: START, proposedEndDate: null }),
      });
      await answerBookingRequestAsk(f, answerInput({ type: "minutes", minutes: 45 }));
      expect(f.agreementNow()?.proposedEndDate).toEqual(new Date("2026-07-10T01:45:00.000Z"));
    });

    it("leaves terms that went out (PROPOSED) alone, and the answer still saves", async () => {
      const f = buildAskDeps({
        request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        asks: [buildAsk({ kind: "SET_LENGTH", label: "Set length" })],
        agreement: buildAgreementRecord({ id: AGREEMENT_ID, status: "PROPOSED", proposedDate: START, proposedEndDate: null }),
      });
      await expect(
        answerBookingRequestAsk(f, answerInput({ type: "minutes", minutes: 45 })),
      ).resolves.toMatchObject({ status: "ANSWERED" });
      expect(f.mocks.agreements.updateHeader).not.toHaveBeenCalled();
      expect(f.agreementNow()?.proposedEndDate).toBeNull();
    });

    it("terms that left DRAFT between the read and the write: the CAS loss is a no-op", async () => {
      const f = buildAskDeps({
        request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        asks: [buildAsk({ kind: "SET_LENGTH", label: "Set length" })],
        agreement: buildAgreementRecord({ id: AGREEMENT_ID, status: "DRAFT", proposedDate: START }),
      });
      f.mocks.agreements.updateHeader.mockRejectedValueOnce({ code: "conflict", message: "agreement_status_changed" });
      await expect(
        answerBookingRequestAsk(f, answerInput({ type: "minutes", minutes: 45 })),
      ).resolves.toMatchObject({ status: "ANSWERED" });
    });
  });

  describe("IMAGE after the mint → the event's hero (V10)", () => {
    function minted(event: Record<string, unknown>) {
      return buildAskDeps({
        request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        asks: [buildAsk({ kind: "IMAGE", useAsEventImage: true })],
        files: [buildFile()],
        agreement: buildAgreementRecord({ id: AGREEMENT_ID, status: "ACCEPTED", draftEventId: EVENT_ID, eventId: null }),
        event: { id: EVENT_ID, ...event },
      });
    }

    it("copies the answer into events/{id}/images/, moderates it, and sets the empty hero", async () => {
      const f = minted({ heroImageKey: null, heroImageUrl: null });
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.storage.putObject).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `events/${EVENT_ID}/images/booking-ask-${ASK_ID}-${ATTACHMENT_ID}.jpg`,
          options: { contentType: "image/jpeg", public: true },
        }),
      );
      expect(f.mocks.imageModerationRecords.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "EVENT_HERO", subjectId: EVENT_ID }),
      );
      expect(f.heroImageId()).not.toBeNull();
      expect(f.asks.get(ASK_ID)?.eventImageEventId).toBe(EVENT_ID);
    });

    it("records the poster's pixel size, read from the copied bytes", async () => {
      const f = minted({ heroImageKey: null, heroImageUrl: null });
      // A JPEG with EXIF (orientation 1) and a SOF0 frame of 1080x1350.
      f.objects.set(
        `booking-requests/${REQUEST_ID}/poster.jpg`,
        Buffer.concat([SOI, exifApp1(1), jpegImageData({ width: 1080, height: 1350 })]),
      );
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.mocks.images.markUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ width: 1080, height: 1350 }),
      );
      expect(f.heroImageId()).not.toBeNull();
    });

    it("publishes the answer file with its metadata stripped (orientation kept)", async () => {
      const f = minted({ heroImageKey: null, heroImageUrl: null });
      const { file, imageData } = phoneJpeg({ orientation: 6 });
      f.objects.set(`booking-requests/${REQUEST_ID}/poster.jpg`, file);
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));

      const heroKey = askEventImageKey({
        eventId: EVENT_ID,
        askId: ASK_ID,
        attachmentId: ATTACHMENT_ID,
        contentType: "image/jpeg",
      });
      const published = f.objects.get(heroKey)!;
      for (const secret of Object.values(SECRET)) {
        expect(published.includes(Buffer.from(secret))).toBe(false);
      }
      expect(published.subarray(-imageData.length)).toEqual(imageData);
      expect(published.length).toBeLessThan(file.length);
      // Orientation 6 survives, so the size is the rotated one.
      expect(f.mocks.images.markUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ key: heroKey, width: 480, height: 640 }),
      );
      expect(f.heroImageId()).not.toBeNull();
    });

    it("an answer file the stripper cannot parse is never published (failed + reported)", async () => {
      const f = minted({ heroImageKey: null, heroImageUrl: null });
      f.objects.set(`booking-requests/${REQUEST_ID}/poster.jpg`, Buffer.from("not a jpeg"));
      await expect(
        answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
      ).resolves.toMatchObject({ status: "ANSWERED" });
      expect(f.storage.putObject).not.toHaveBeenCalled();
      expect(f.mocks.images.create).not.toHaveBeenCalled();
      expect(f.heroImageId()).toBeNull();
      expect(f.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ name: "ImageMetadataStripError" }),
        expect.objectContaining({ tags: expect.objectContaining({ step: "ask_image_mapping" }) }),
      );
    });

    it("a full strip queue is reported as strip_busy, not as a copy failure (no poster yet)", async () => {
      // Fill every strip slot and the whole wait queue.
      const gates: Array<() => void> = [];
      const held = Array.from({ length: IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING }, () =>
        withImageStripSlot(() => new Promise<void>((resolve) => gates.push(resolve))),
      );
      await new Promise((r) => setTimeout(r, 0));
      try {
        const f = minted({ heroImageKey: null, heroImageUrl: null });
        await expect(
          answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
        ).resolves.toMatchObject({ status: "ANSWERED" });
        expect(f.storage.putObject).not.toHaveBeenCalled();
        expect(f.heroImageId()).toBeNull();
        expect(f.reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "RATE_LIMITED", message: IMAGE_STRIP_BUSY }),
          expect.objectContaining({ tags: expect.objectContaining({ step: "strip_busy" }) }),
        );
      } finally {
        for (let i = 0; i < 100; i += 1) {
          gates.splice(0).forEach((open) => open());
          await new Promise((r) => setTimeout(r, 0));
        }
        await Promise.all(held);
      }
    });

    it("an unreadable header still maps the hero, with no size (both null)", async () => {
      const f = minted({ heroImageKey: null, heroImageUrl: null });
      // A well-formed JPEG whose frame header says 0x0: no usable size.
      f.objects.set(
        `booking-requests/${REQUEST_ID}/poster.jpg`,
        cleanJpeg({ width: 0, height: 0 }),
      );
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.mocks.images.markUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ width: null, height: null }),
      );
      expect(f.heroImageId()).not.toBeNull();
    });

    it("an event that already has a hero keeps it — no copy at all", async () => {
      const f = minted({ heroImageKey: "events/e/images/old.jpg", heroImageUrl: "https://cdn/old.jpg" });
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.storage.putObject).not.toHaveBeenCalled();
      expect(f.mocks.images.create).not.toHaveBeenCalled();
    });

    // ── review W1 ── the copy is public before its CAS. A delayed run for
    // an OLD answer (A) that loses the CAS after the run for the NEW answer
    // (B) won must never touch B's object: the hero key and its bytes stay
    // B's, A writes no row, and A's own object goes on the deletion outbox.
    it("race: a stale run for an old answer loses the CAS after the new answer's run won — B's hero key and bytes stand", async () => {
      const OLD = "a11a11a1-0000-4000-8000-0000000000aa";
      const NEW = ATTACHMENT_ID;
      const f = buildAskDeps({
        request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        asks: [
          buildAsk({
            kind: "IMAGE",
            useAsEventImage: true,
            status: "ANSWERED",
            answerAttachmentId: NEW,
            answerRevision: 2,
            answeredByHumanId: ACTOR_ID,
            answeredAt: NOW,
          }),
        ],
        files: [
          buildFile({ id: OLD, storageKey: `booking-requests/${REQUEST_ID}/old.jpg`, deletedAt: NOW }),
          buildFile({ id: NEW, storageKey: `booking-requests/${REQUEST_ID}/new.jpg` }),
        ],
        agreement: buildAgreementRecord({ id: AGREEMENT_ID, status: "ACCEPTED", draftEventId: EVENT_ID, eventId: null }),
        event: { id: EVENT_ID, heroImageKey: null, heroImageUrl: null },
      });
      const OLD_POSTER = cleanJpeg({ tag: 0x0a });
      const NEW_POSTER = cleanJpeg({ tag: 0x0b });
      f.objects.set(`booking-requests/${REQUEST_ID}/old.jpg`, OLD_POSTER);
      f.objects.set(`booking-requests/${REQUEST_ID}/new.jpg`, NEW_POSTER);
      const deps = { repos: f.repos, storage: f.storage, clock: f.clock, reportError: f.reportError };
      const args = { bookingRequestId: REQUEST_ID, eventId: EVENT_ID, context: "test" };

      // B — the run for the current answer — wins.
      const b = await mapAskImageToEvent(deps, args);
      expect(b).toMatchObject({ outcome: "mapped", heroSet: true });
      const heroKey = askEventImageKey({ eventId: EVENT_ID, askId: ASK_ID, attachmentId: NEW, contentType: "image/jpeg" });
      expect(f.objects.get(heroKey)).toEqual(NEW_POSTER);

      // A — delayed — read the ask and its file while the OLD answer stood.
      f.mocks.bookingRequests.listAsks.mockResolvedValueOnce([
        buildAsk({
          kind: "IMAGE",
          useAsEventImage: true,
          status: "ANSWERED",
          answerAttachmentId: OLD,
          answerRevision: 1,
          answeredByHumanId: ACTOR_ID,
          answeredAt: new Date(NOW.getTime() - 60_000),
        }),
      ]);
      f.mocks.bookingRequests.getAttachment.mockResolvedValueOnce(
        buildFile({ id: OLD, storageKey: `booking-requests/${REQUEST_ID}/old.jpg` }),
      );
      const a = await mapAskImageToEvent(deps, args);
      expect(a).toEqual({ outcome: "skipped", reason: "already_mapped" });

      // B's hero object is untouched, its image is the only row, the hero is B's.
      expect(f.objects.get(heroKey)).toEqual(NEW_POSTER);
      expect(f.imageRows).toHaveLength(1);
      expect(f.imageRows[0]).toMatchObject({ key: heroKey });
      expect(f.heroImageId()).toBe(b.outcome === "mapped" ? b.imageId : "unreachable");
      // A's own copy is referenced by nothing: outboxed, never left behind.
      const staleKey = askEventImageKey({ eventId: EVENT_ID, askId: ASK_ID, attachmentId: OLD, contentType: "image/jpeg" });
      expect(f.mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
        expect.objectContaining({ targetKey: staleKey, targetKind: "KEY" }),
      ]);
    });

    it("race: a duplicate run for the SAME answer that loses keeps the winner's object (no outbox)", async () => {
      const f = minted({ heroImageKey: null });
      // Answer, which maps once…
      await answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID }));
      expect(f.imageRows).toHaveLength(1);
      // …then a duplicate run that read the ask before the stamp landed.
      f.mocks.bookingRequests.listAsks.mockResolvedValueOnce([
        { ...f.asks.get(ASK_ID)!, eventImageEventId: null, eventImageId: null },
      ]);
      f.mocks.pendingObjectDeletions.enqueueMany.mockClear();
      const out = await mapAskImageToEvent(
        { repos: f.repos, storage: f.storage, clock: f.clock },
        { bookingRequestId: REQUEST_ID, eventId: EVENT_ID, context: "test" },
      );
      expect(out).toEqual({ outcome: "skipped", reason: "already_mapped" });
      expect(f.mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
      expect(f.imageRows).toHaveLength(1);
    });

    it("a failed copy never fails the answer (logged + reported)", async () => {
      const f = minted({ heroImageKey: null });
      f.storage.getObject.mockRejectedValueOnce(new Error("r2 down"));
      await expect(
        answerBookingRequestAsk(f, answerInput({ type: "attachment", attachmentId: ATTACHMENT_ID })),
      ).resolves.toMatchObject({ status: "ANSWERED" });
      expect(f.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ step: "ask_image_mapping" }) }),
      );
    });
  });
});

describe("withdrawBookingRequestAsk", () => {
  it("OPEN → WITHDRAWN with a ledger entry; any venue-side participant may withdraw", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ askedByHumanId: VENUE_OWNER_ID })] });
    const out = await withdrawBookingRequestAsk(f, {
      actorHumanId: VENUE_EDITOR_ID,
      bookingRequestId: REQUEST_ID,
      askId: ASK_ID,
    });
    expect(out.status).toBe("WITHDRAWN");
    expect(systemEntriesFor(f.repos, REQUEST_ID).map((e) => e.systemKind)).toEqual([
      "booking_request.ask_withdrawn",
    ]);
  });

  it("withdrawing twice is idempotent: one ledger entry", async () => {
    const f = buildAskDeps({ asks: [buildAsk()] });
    const input = { actorHumanId: VENUE_OWNER_ID, bookingRequestId: REQUEST_ID, askId: ASK_ID };
    await withdrawBookingRequestAsk(f, input);
    await expect(withdrawBookingRequestAsk(f, input)).resolves.toMatchObject({ status: "WITHDRAWN" });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toHaveLength(1);
  });

  it("an ANSWERED ask cannot be withdrawn", async () => {
    const f = buildAskDeps({ asks: [buildAsk({ status: "ANSWERED", answerUrl: "https://v.test" })] });
    await expect(
      withdrawBookingRequestAsk(f, { actorHumanId: VENUE_OWNER_ID, bookingRequestId: REQUEST_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_ask_answered" });
  });

  it("a withdraw that loses to an answer is refused (answered), not silently applied", async () => {
    const f = buildAskDeps({ asks: [buildAsk()] });
    f.mocks.bookingRequests.withdrawAsk.mockImplementationOnce(async () => {
      f.asks.set(ASK_ID, buildAsk({ status: "ANSWERED", answerUrl: "https://v.test" }));
      return null;
    });
    await expect(
      withdrawBookingRequestAsk(f, { actorHumanId: VENUE_OWNER_ID, bookingRequestId: REQUEST_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_ask_answered" });
    expect(systemEntriesFor(f.repos, REQUEST_ID)).toEqual([]);
  });

  it("the sender cannot withdraw the venue's ask", async () => {
    const f = buildAskDeps({ asks: [buildAsk()] });
    await expect(
      withdrawBookingRequestAsk(f, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

describe("listBookingRequestAsks", () => {
  it("both parties read the asks with their answers; a VIEWER on the venue side reads too", async () => {
    const f = buildAskDeps({
      asks: [buildAsk({ kind: "IMAGE", status: "ANSWERED", answerAttachmentId: ATTACHMENT_ID, answerRevision: 1 })],
      files: [buildFile()],
    });
    for (const [actorHumanId, side] of [
      [ACTOR_ID, "PERFORMER"],
      [VENUE_OWNER_ID, "VENUE"],
      [VENUE_VIEWER_ID, "VENUE"],
    ] as const) {
      const out = await listBookingRequestAsks(f, { actorHumanId, bookingRequestId: REQUEST_ID, side });
      expect(out.asks[0]?.answer).toMatchObject({ type: "attachment", fileName: "poster.jpg" });
    }
  });

  it("an outsider reads nothing; the read-only ACT side is not a side here", async () => {
    const f = buildAskDeps({ asks: [buildAsk()] });
    await expect(
      listBookingRequestAsks(f, { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_ID, side: "VENUE" }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      listBookingRequestAsks(f, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, side: "ACT" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listBookingRequestAskSuggestions (FR-009c)", () => {
  it("lists the effective standards the pitch left empty, pre-typed, minus what was asked", async () => {
    const f = buildAskDeps({
      request: buildBookingRequestRecord({ genre: "punk", linkVideo: null, setLengthMinutes: null, techNeeds: null }),
      standards: [
        { field: "LINK_VIDEO", label: "A live video" },
        { field: "SET_LENGTH", label: "Set length" },
        { field: "TECH_NEEDS", label: "What you bring" },
        { field: "GENRE", label: "Your genre" }, // filled by the pitch
        { field: "CUSTOM", label: "Stage plot" },
        { field: "LINK_MUSIC", label: "Music" }, // already asked below
      ],
      asks: [buildAsk({ kind: "LINK", standardField: "LINK_MUSIC" })],
    });
    const out = await listBookingRequestAskSuggestions(f, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
    });
    expect(out.degraded).toBe(false);
    expect(out.suggestions.map((s) => [s.field, s.kind, s.label])).toEqual([
      ["LINK_VIDEO", "LINK", "A live video"],
      ["SET_LENGTH", "SET_LENGTH", "Set length"],
      ["TECH_NEEDS", "TEXT", "What you bring"],
      ["CUSTOM", "FILE", "Stage plot"],
    ]);
  });

  it("the sender cannot read the venue's ask list", async () => {
    const f = buildAskDeps();
    await expect(
      listBookingRequestAskSuggestions(f, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});
