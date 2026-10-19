import { describe, expect, it, vi } from "vitest";

import {
  ACTOR_ID,
  NOW,
  REQUEST_ID,
  buildBookingRequestRecord,
} from "../../__tests__/helpers";
import {
  getBookingAttachmentUrl,
  requestBookingAttachmentUpload,
} from "../../attachment-files";
import {
  addBookingRequestAttachment,
  listBookingRequestAttachments,
} from "../../attachments";
import {
  ASK_ID,
  ATTACHMENT_ID,
  OUTSIDER_ID,
  VENUE_OWNER_ID,
  VENUE_VIEWER_ID,
  buildAsk,
  buildAskDeps,
  buildFile,
  type AskFakeOptions,
} from "./ask-fakes";

// ─────────────────────────────────────────────────────────────────────────────
// The booking-request file path (venue-booking-standards v1.1 FR-009a):
// presign → PUT → `attachments.add` (HEAD-verified, optional askId) → signed
// GET for the parties only.
// ─────────────────────────────────────────────────────────────────────────────

function deps(options: AskFakeOptions = {}) {
  const f = buildAskDeps(options);
  const storage = {
    ...f.storage,
    presignPutObject: vi.fn(async () => ({ uploadUrl: "https://r2.test/put" })),
  };
  return { ...f, storage };
}

describe("requestBookingAttachmentUpload", () => {
  it("mints a key under the request's namespace and a 15-minute private PUT, stamped with request + uploader", async () => {
    const f = deps();
    const out = await requestBookingAttachmentUpload(f, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
      contentType: "image/webp",
      sizeBytes: 1024,
    });
    expect(out.key).toMatch(
      new RegExp(`^booking-requests/${REQUEST_ID}/[0-9a-f-]{36}\\.webp$`),
    );
    expect(out.uploadHeaders).toEqual({ "Content-Type": "image/webp" });
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60 * 1000));
    expect(f.storage.presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: out.key,
        public: false,
        sizeBytes: 1024,
        metadata: expect.objectContaining({
          "th-booking-request-id": REQUEST_ID,
          "th-actor-human-id": ACTOR_ID,
        }),
        options: { expiresSec: 900 },
      }),
    );
    // The uploader's own quota is charged by the declared size.
    expect(f.mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "HUMAN", subjectId: ACTOR_ID, delta: 1024n }),
    );
  });

  it("the venue side may upload too", async () => {
    const f = deps();
    await expect(
      requestBookingAttachmentUpload(f, {
        actorHumanId: VENUE_OWNER_ID,
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
        contentType: "application/pdf",
        sizeBytes: 1024,
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses other types, files over 25 MB, outsiders and a venue VIEWER", async () => {
    const f = deps();
    const base = {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
      contentType: "image/png",
      sizeBytes: 1024,
    };
    for (const bad of [
      { contentType: "image/svg+xml" },
      { contentType: "text/html" },
      { sizeBytes: 25 * 1024 * 1024 + 1 },
    ]) {
      await expect(
        requestBookingAttachmentUpload(f, { ...base, ...bad }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      requestBookingAttachmentUpload(f, { ...base, actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      requestBookingAttachmentUpload(f, {
        ...base,
        actorHumanId: VENUE_VIEWER_ID,
        side: "VENUE",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(f.storage.presignPutObject).not.toHaveBeenCalled();
  });
});

describe("getBookingAttachmentUrl — the thread's participants (edit roles), not every member", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    actorHumanId: ACTOR_ID,
    bookingRequestId: REQUEST_ID,
    side: "PERFORMER",
    attachmentId: ATTACHMENT_ID,
    ...over,
  });

  it("both parties get a 5-minute signed GET", async () => {
    const f = deps({ files: [buildFile()] });
    for (const over of [{}, { actorHumanId: VENUE_OWNER_ID, side: "VENUE" }]) {
      const out = await getBookingAttachmentUrl(f, input(over));
      expect(out).toMatchObject({ fileName: "poster.jpg", contentType: "image/jpeg" });
      expect(out.expiresAt).toEqual(new Date(NOW.getTime() + 5 * 60 * 1000));
    }
    expect(f.storage.getObjectUrl).toHaveBeenCalledWith({
      key: `booking-requests/${REQUEST_ID}/poster.jpg`,
      options: { expiresSec: 300 },
    });
  });

  it("an outsider is refused BEFORE the file is read; a side claim they do not hold is refused", async () => {
    const f = deps({ files: [buildFile()] });
    await expect(
      getBookingAttachmentUrl(f, input({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      getBookingAttachmentUrl(f, input({ actorHumanId: OUTSIDER_ID, side: "VENUE" })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // The sender claiming the VENUE side.
    await expect(
      getBookingAttachmentUrl(f, input({ side: "VENUE" })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(f.mocks.bookingRequests.getAttachment).not.toHaveBeenCalled();
    expect(f.storage.getObjectUrl).not.toHaveBeenCalled();
  });

  // ── review W4 (orchestrator ruling) ── FR-009a "participants only": a
  // venue VIEWER may LIST the files (the read gate) but not OPEN one.
  it("a venue VIEWER is refused the URL, though the list shows them the file", async () => {
    const f = deps({ files: [buildFile()] });
    await expect(
      getBookingAttachmentUrl(f, input({ actorHumanId: VENUE_VIEWER_ID, side: "VENUE" })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(f.storage.getObjectUrl).not.toHaveBeenCalled();
    await expect(
      listBookingRequestAttachments(f, {
        actorHumanId: VENUE_VIEWER_ID,
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: ATTACHMENT_ID })]);
  });

  it("the read-only ACT side cannot open files", async () => {
    const f = deps({ files: [buildFile()] });
    await expect(
      getBookingAttachmentUrl(f, input({ side: "ACT" })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.storage.getObjectUrl).not.toHaveBeenCalled();
  });

  it("another request's file, a deleted file and an unknown id all read as DOCUMENT_NOT_FOUND", async () => {
    for (const file of [
      buildFile({ bookingRequestId: "99999999-9999-4999-8999-999999999999" }),
      buildFile({ deletedAt: NOW }),
    ]) {
      const f = deps({ files: [file] });
      await expect(getBookingAttachmentUrl(f, input())).rejects.toMatchObject({
        code: "DOCUMENT_NOT_FOUND",
      });
      expect(f.storage.getObjectUrl).not.toHaveBeenCalled();
    }
  });
});

describe("addBookingRequestAttachment — the store is the truth (FR-009a)", () => {
  const KEY = `booking-requests/${REQUEST_ID}/0b0b0b0b-0000-4000-8000-000000000001.jpg`;
  const add = (over: Record<string, unknown> = {}) => ({
    actorHumanId: ACTOR_ID,
    bookingRequestId: REQUEST_ID,
    side: "PERFORMER",
    storageKey: KEY,
    fileName: "poster.jpg",
    contentType: "image/jpeg",
    sizeBytes: 9,
    ...over,
  });
  const head = (h: Record<string, unknown>) => ({ [KEY]: { exists: true, ...h } });

  it("records the size and type the STORE reports, not the client's", async () => {
    const f = deps({
      heads: head({ size: 7777, contentType: "image/jpeg", metadata: { "th-actor-human-id": ACTOR_ID } }),
    });
    const out = await addBookingRequestAttachment(f, add());
    expect(out).toMatchObject({ sizeBytes: 7777, contentType: "image/jpeg", askId: null });
  });

  it("refuses a missing object, a disallowed or mismatched type, and an oversize one (deleted)", async () => {
    const missing = deps({ heads: { [KEY]: { exists: false } } });
    await expect(addBookingRequestAttachment(missing, add())).rejects.toMatchObject({
      code: "UPLOAD_NOT_COMPLETE",
    });
    const html = deps({ heads: head({ size: 10, contentType: "text/html" }) });
    await expect(addBookingRequestAttachment(html, add())).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "unsupported_content_type",
    });
    const untyped = deps({ heads: head({ size: 10 }) });
    await expect(addBookingRequestAttachment(untyped, add())).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "unsupported_content_type",
    });
    const mismatch = deps({ heads: head({ size: 10, contentType: "image/png" }) });
    await expect(addBookingRequestAttachment(mismatch, add())).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "content_type_mismatch",
    });
    const huge = deps({ heads: head({ size: 25 * 1024 * 1024 + 1, contentType: "image/jpeg" }) });
    await expect(addBookingRequestAttachment(huge, add())).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(huge.storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("refuses a file the presign stamped for ANOTHER uploader or request", async () => {
    for (const metadata of [
      { "th-actor-human-id": VENUE_OWNER_ID },
      { "th-booking-request-id": "99999999-9999-4999-8999-999999999999" },
    ]) {
      const f = deps({ heads: head({ size: 10, contentType: "image/jpeg", metadata }) });
      await expect(addBookingRequestAttachment(f, add())).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "attachment_not_uploaded_by_actor",
      });
    }
  });

  describe("with an askId", () => {
    it("links the sender's file to an IMAGE / FILE ask", async () => {
      const f = deps({
        asks: [buildAsk({ kind: "IMAGE", useAsEventImage: true })],
        heads: head({ size: 10, contentType: "image/jpeg" }),
      });
      const out = await addBookingRequestAttachment(f, add({ askId: ASK_ID }));
      expect(out.askId).toBe(ASK_ID);
    });

    it("refuses the venue side, a LINK ask, a withdrawn ask, a PDF for an IMAGE ask and an unknown ask", async () => {
      const ok = head({ size: 10, contentType: "image/jpeg" });
      const venue = deps({ asks: [buildAsk({ kind: "FILE" })], heads: ok });
      await expect(
        addBookingRequestAttachment(venue, add({ askId: ASK_ID, actorHumanId: VENUE_OWNER_ID, side: "VENUE" })),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

      const link = deps({ asks: [buildAsk({ kind: "LINK" })], heads: ok });
      await expect(addBookingRequestAttachment(link, add({ askId: ASK_ID }))).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "ask_takes_no_file",
      });

      const withdrawn = deps({ asks: [buildAsk({ kind: "FILE", status: "WITHDRAWN" })], heads: ok });
      await expect(addBookingRequestAttachment(withdrawn, add({ askId: ASK_ID }))).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "booking_ask_withdrawn",
      });

      const PDF_KEY = `booking-requests/${REQUEST_ID}/rider.pdf`;
      const pdf = deps({
        asks: [buildAsk({ kind: "IMAGE" })],
        heads: { [PDF_KEY]: { exists: true, size: 10, contentType: "application/pdf" } },
      });
      await expect(
        addBookingRequestAttachment(pdf, add({ askId: ASK_ID, storageKey: PDF_KEY, contentType: "application/pdf" })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "ask_needs_an_image" });

      const unknown = deps({ heads: ok });
      await expect(addBookingRequestAttachment(unknown, add({ askId: ASK_ID }))).rejects.toMatchObject({
        code: "BOOKING_ASK_NOT_FOUND",
      });
    });
  });

  it("a closed request still takes a loose file (the thread is history)", async () => {
    const f = deps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
      heads: head({ size: 10, contentType: "image/jpeg" }),
    });
    await expect(addBookingRequestAttachment(f, add())).resolves.toBeTruthy();
  });
});
