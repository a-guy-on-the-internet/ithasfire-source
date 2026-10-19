import { describe, expect, it, vi } from "vitest";

import type { BookingRequestMessageRow } from "@th/ports/repos/booking-request-messages";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import {
  notifyBookingInquirer,
  type NotifyBookingInquirerDeps,
} from "../notify-booking-inquirer";
import {
  ORG_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
} from "./helpers";

const PUBLIC_APP_URL = "https://ithasfire.test";
const MESSAGE_ID = "5e55a6e5-1111-4111-8111-111111111111";
const SECOND_MESSAGE_ID = "5e55a6e5-2222-4222-8222-222222222222";
const SHADOW_HUMAN_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_EMAIL = "jo@example.com";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The row shape this use case exists for: an ANONYMOUS embed inquiry. */
function anonymousInquiry(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildBookingRequestRecord({
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "Jo Rivera",
    contactEmail: CONTACT_EMAIL,
    source: "EMBED",
    ...overrides,
  });
}

/** The same row after a first reply flipped it to shadow-owned. */
function shadowOwnedInquiry(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return anonymousInquiry({
    performerOwnerType: "human",
    performerOwnerId: SHADOW_HUMAN_ID,
    ...overrides,
  });
}

function venueMessage(
  overrides: Partial<BookingRequestMessageRow> = {},
): BookingRequestMessageRow {
  return {
    id: MESSAGE_ID,
    bookingRequestId: REQUEST_ID,
    authorSide: "VENUE",
    authorHumanId: "11111111-1111-4111-8111-111111111111",
    body: "Does the 10th work?",
    readAt: null,
    createdAt: new Date("2026-06-10T12:00:00.000Z"),
    ...overrides,
  } as BookingRequestMessageRow;
}

type BuildOptions = {
  /** What `bookingRequests.getById` returns (the FRESH row). */
  fresh?: BookingRequestRecord | null;
  /** What `attachInquirerOwner` resolves to, or throws. */
  attachImpl?: () => Promise<BookingRequestRecord | null>;
  ensureImpl?: () => Promise<{ humanId: string; created: boolean }>;
  /** Prior thread rows for the `References` chain (oldest first). */
  priorMessages?: BookingRequestMessageRow[];
  listMessagesImpl?: () => Promise<unknown>;
  orgContactEmail?: string | null;
  placeOrgIds?: string[];
  mailerImpl?: () => Promise<unknown>;
  publicAppUrl?: string | null;
  withMailer?: boolean;
};

function buildDeps(options: BuildOptions = {}) {
  const getById = vi.fn(async () => options.fresh ?? anonymousInquiry());
  const attachInquirerOwner = vi.fn(
    options.attachImpl ?? (async () => shadowOwnedInquiry()),
  );
  const setInquirerEmailMessageId = vi.fn(async () => true);
  const ensureGuestHuman = vi.fn(
    options.ensureImpl ??
      (async () => ({ humanId: SHADOW_HUMAN_ID, created: true })),
  );
  const updateHuman = vi.fn(async () => ({ id: SHADOW_HUMAN_ID }));
  const listForRequest = vi.fn(
    options.listMessagesImpl ??
      (async () => ({
        items: options.priorMessages ?? [],
        nextCursor: null,
      })),
  );
  const send = vi.fn(
    options.mailerImpl ?? (async () => ({ result: { ok: true } })),
  );
  const reportError = vi.fn();
  const logger = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const repos = {
    bookingRequests: {
      getById,
      attachInquirerOwner,
      setInquirerEmailMessageId,
    },
    bookingRequestMessages: { listForRequest },
    humans: {
      ensureGuestHuman,
      update: updateHuman,
    },
    places: {
      getById: vi.fn(async () =>
        buildPlaceRecord({
          orgIdsWithAccess: options.placeOrgIds ?? [ORG_ID],
        }),
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: "Corner Stage LLC",
        slug: "corner-stage",
        contactEmail:
          options.orgContactEmail === undefined
            ? "booking@cornerstage.example"
            : options.orgContactEmail,
      })),
    },
  } as unknown as NotifyBookingInquirerDeps["repos"];

  const deps: NotifyBookingInquirerDeps = {
    repos,
    ...(options.withMailer === false ? {} : { mailer: { send } as never }),
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
    logger: logger as never,
    reportError,
  };

  return {
    deps,
    send,
    reportError,
    logger,
    getById,
    attachInquirerOwner,
    setInquirerEmailMessageId,
    ensureGuestHuman,
    updateHuman,
    listForRequest,
  };
}

function args(
  overrides: {
    bookingRequest?: BookingRequestRecord;
    message?: BookingRequestMessageRow;
    recipientSide?: "VENUE" | "PERFORMER";
  } = {},
) {
  return {
    bookingRequest: overrides.bookingRequest ?? anonymousInquiry(),
    message: overrides.message ?? venueMessage(),
    recipientSide: overrides.recipientSide ?? ("PERFORMER" as const),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("notifyBookingInquirer", () => {
  describe("applicability", () => {
    it("does nothing for the VENUE side", async () => {
      const h = buildDeps();
      const result = await notifyBookingInquirer(
        h.deps,
        args({
          recipientSide: "VENUE",
          message: venueMessage({ authorSide: "PERFORMER" }),
        }),
      );
      expect(result).toBeNull();
      expect(h.getById).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });

    it("does nothing for a genuinely owned request (no contact fields)", async () => {
      const owned = buildDeps();
      const result = await notifyBookingInquirer(
        owned.deps,
        args({ bookingRequest: buildBookingRequestRecord() }),
      );
      expect(result).toBeNull();
      expect(owned.getById).not.toHaveBeenCalled();
      expect(owned.send).not.toHaveBeenCalled();
    });

    it("does nothing once the inquiry has been CLAIMED", async () => {
      // A claimed row carries BOTH a real owner pair and the retained contact
      // fields — the exact shape a naive `contactEmail != null` check would
      // mis-handle.
      const claimed = shadowOwnedInquiry({
        claimedAt: new Date("2026-06-09T00:00:00.000Z"),
      });
      const h = buildDeps({ fresh: claimed });
      const result = await notifyBookingInquirer(
        h.deps,
        args({ bookingRequest: claimed }),
      );
      expect(result).toBeNull();
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  describe("first reply", () => {
    it("mints the shadow WITHOUT a name, then names only the new Human", async () => {
      const h = buildDeps();
      await notifyBookingInquirer(h.deps, args());

      // No `name` on the ensure call: the adapter would overwrite an existing
      // Human's name, and both name and address come from a public form.
      expect(h.ensureGuestHuman).toHaveBeenCalledWith({ email: CONTACT_EMAIL });
      expect(h.updateHuman).toHaveBeenCalledWith(SHADOW_HUMAN_ID, {
        name: "Jo Rivera",
      });
    });

    it("flips the request to shadow-owned and returns the fresh record", async () => {
      const h = buildDeps();
      const result = await notifyBookingInquirer(h.deps, args());

      expect(h.attachInquirerOwner).toHaveBeenCalledWith({
        id: REQUEST_ID,
        performerOwnerType: "human",
        performerOwnerId: SHADOW_HUMAN_ID,
      });
      expect(result?.performerOwnerId).toBe(SHADOW_HUMAN_ID);
      // The flip is NOT a claim — every accept/mint gate keys off this.
      expect(result?.claimedAt).toBeNull();
      // The venue's mailto affordance survives the flip.
      expect(result?.contactEmail).toBe(CONTACT_EMAIL);
      expect(result?.contactName).toBe("Jo Rivera");
    });

    it("sends the dedicated template with the org Reply-To and NO threading headers", async () => {
      const h = buildDeps();
      await notifyBookingInquirer(h.deps, args());

      expect(h.send).toHaveBeenCalledOnce();
      const payload = h.send.mock.calls[0]![0] as {
        to: { to: string };
        replyTo?: { to: string };
        template: { key: string; variables: Record<string, unknown> };
        headers: Record<string, string>;
        idempotencyKey: string;
      };

      expect(payload.to).toEqual({ to: CONTACT_EMAIL });
      expect(payload.replyTo).toEqual({ to: "booking@cornerstage.example" });
      expect(payload.template.key).toBe("booking.thread_message");
      expect(payload.template.variables.messageBody).toBe("Does the 10th work?");
      expect(payload.template.variables.replyToEmail).toBe(
        "booking@cornerstage.example",
      );
      expect(payload.idempotencyKey).toBe(
        `booking-inquirer-message:${MESSAGE_ID}`,
      );
      // NO threading headers, ever. Verified 2026-09-08 against real Resend +
      // Gmail: a caller-supplied Message-Id is DISCARDED and replaced with the
      // provider's own SES id, so anything we build from ours references a
      // message that exists nowhere and Gmail files the replies as separate
      // threads. Re-adding these is a silent regression, so it is pinned here.
      expect(payload.headers).toBeUndefined();
    });

    it("persists the outbound Message-ID as the thread root", async () => {
      const h = buildDeps();
      await notifyBookingInquirer(h.deps, args());
      expect(h.setInquirerEmailMessageId).toHaveBeenCalledWith({
        id: REQUEST_ID,
        messageId: `booking-inquiry.${REQUEST_ID}.${MESSAGE_ID}@ithasfire.test`,
      });
    });

    it("omits Reply-To (and the reply copy) when the org has no contact email", async () => {
      const h = buildDeps({ orgContactEmail: null });
      await notifyBookingInquirer(h.deps, args());

      const payload = h.send.mock.calls[0]![0] as {
        replyTo?: unknown;
        template: { variables: Record<string, unknown> };
      };
      // Inbound ingestion is out of scope — never invite a reply we can't route.
      expect(payload.replyTo).toBeUndefined();
      expect(payload.template.variables.replyToEmail).toBeNull();
    });
  });

  describe("second reply", () => {
    it("does not re-flip, and still sends NO threading headers", async () => {
      const root = `booking-inquiry.${REQUEST_ID}.${MESSAGE_ID}@ithasfire.test`;
      const already = shadowOwnedInquiry({ inquirerEmailMessageId: root });
      const h = buildDeps({
        fresh: already,
        // The CAS matches zero rows the second time around.
        attachImpl: async () => null,
      });

      await notifyBookingInquirer(
        h.deps,
        args({
          bookingRequest: already,
          message: venueMessage({ id: SECOND_MESSAGE_ID }),
        }),
      );

      const payload = h.send.mock.calls[0]![0] as {
        headers?: Record<string, string>;
      };
      // A stored marker does NOT become an In-Reply-To — it is only the
      // "this row was mailed" flag the bounce fan-in scopes on.
      expect(payload.headers).toBeUndefined();
      // The marker is written once, by the first send.
      expect(h.setInquirerEmailMessageId).not.toHaveBeenCalled();
    });
  });

  describe("identity safety", () => {
    // The gate is `ensured.created` and NOTHING ELSE. An earlier version gated
    // on `listAuthAccounts(humanId).length > 0` ("a real account always has a
    // credential/OAuth row"), which is FALSE here: `magicLink()` is mounted in
    // apps/api/src/auth/better-auth.ts with no `disableSignUp`, and Better
    // Auth's verify handler creates the user + session WITHOUT writing an
    // `account` row. A fully loginable magic-link user therefore has ZERO
    // AuthAccount rows and read as a shadow — so a stranger typing that
    // address into a public embed form got the venue's request attached to a
    // REAL person's account.
    it("does NOT flip onto an EXISTING Human, but still sends the email", async () => {
      const h = buildDeps({
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });

      const result = await notifyBookingInquirer(h.deps, args());

      expect(h.attachInquirerOwner).not.toHaveBeenCalled();
      expect(result?.performerOwnerId).toBeNull();
      // The email is the whole point of the use case — it goes either way.
      expect(h.send).toHaveBeenCalledOnce();
    });

    it("does NOT flip onto a MAGIC-LINK account (zero AuthAccount rows)", async () => {
      // The exact shape the old AuthAccount heuristic waved through: an
      // existing, loginable, emailVerified Human with no auth-account rows at
      // all. Nothing but `created` distinguishes it, so nothing but `created`
      // may be consulted.
      const h = buildDeps({
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });

      const result = await notifyBookingInquirer(h.deps, args());

      expect(h.attachInquirerOwner).not.toHaveBeenCalled();
      expect(result?.performerOwnerId).toBeNull();
      // No `humans.listAuthAccounts` lookup happens at all any more.
      expect(
        (h.deps.repos.humans as unknown as Record<string, unknown>)
          .listAuthAccounts,
      ).toBeUndefined();
    });

    it("makes the skipped flip COUNTABLE (reported, not just logged)", async () => {
      // On a thread we have NEVER mailed, `created: false` means the address
      // already had a Human before we touched it — an address with an account
      // typed into an unauthenticated public form. `info`/`warn` are not
      // Sentry-captured.
      const h = buildDeps({
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });

      await notifyBookingInquirer(h.deps, args());

      expect(h.logger.error).toHaveBeenCalledWith(
        "booking_requests.notify_inquirer.flip_skipped_not_created",
        { bookingRequestId: REQUEST_ID },
      );
      expect(h.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            step: "flip_skipped_not_created",
          }),
        }),
      );
    });

    it("stays QUIET on reply 2..N to the same inquiry (idempotent, not news)", async () => {
      // `created` is false on every later reply too, but the row already
      // carries exactly this shadow — reporting would fire a Sentry event on
      // every venue message.
      const already = shadowOwnedInquiry();
      const h = buildDeps({
        fresh: already,
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });

      await notifyBookingInquirer(
        h.deps,
        args({
          bookingRequest: already,
          message: venueMessage({ id: SECOND_MESSAGE_ID }),
        }),
      );

      expect(h.send).toHaveBeenCalledOnce();
      expect(h.reportError).not.toHaveBeenCalled();
    });

    it("stays QUIET on reply 2..N after the flip was LOST (owner pair still null)", async () => {
      // The regression this guards: reply 1 minted the shadow and then lost
      // `attachInquirerOwner` to a duplicate/transient failure, so the owner
      // pair is null FOREVER. `created` is false on every later reply and the
      // owner check can never match, so the report used to fire on EVERY venue
      // message — the exact per-message Sentry spam the owner check was added
      // to prevent, reached by another door — and under an impersonation
      // label that did not apply (the "existing Human" is our own shadow).
      // The stored thread root is what says "we have already been here".
      const root = `booking-inquiry.${REQUEST_ID}.${MESSAGE_ID}@ithasfire.test`;
      const lostFlip = anonymousInquiry({ inquirerEmailMessageId: root });
      const h = buildDeps({
        fresh: lostFlip,
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });

      await notifyBookingInquirer(
        h.deps,
        args({
          bookingRequest: lostFlip,
          message: venueMessage({ id: SECOND_MESSAGE_ID }),
        }),
      );

      // The reply still lands; only the noise is gone.
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.attachInquirerOwner).not.toHaveBeenCalled();
      expect(h.reportError).not.toHaveBeenCalled();
    });

    it("does not rename an existing Human", async () => {
      const h = buildDeps({
        ensureImpl: async () => ({ humanId: SHADOW_HUMAN_ID, created: false }),
      });
      await notifyBookingInquirer(h.deps, args());
      expect(h.updateHuman).not.toHaveBeenCalled();
    });
  });

  describe("misconfiguration is never silent", () => {
    it("STRIPS THE PORT from the stored marker's domain", async () => {
      // Regression: found by a real SMTP send on 2026-09-06, not by a test.
      // `new URL(...).host` keeps the port, so a local PUBLIC_APP_URL of
      // http://localhost:3000 emitted `<...@localhost:3000>` — a colon is not
      // legal in a Message-ID's domain (RFC 5322 `id-right`), and an MTA
      // stricter than Mailpit may reject or rewrite it, which silently breaks
      // threading while the code still reports success.
      const h = buildDeps({ publicAppUrl: "http://localhost:3000" });

      await notifyBookingInquirer(h.deps, args());

      expect(h.send).toHaveBeenCalledOnce();
      // `new URL(...).host` keeps the PORT; `.hostname` does not. The marker is
      // no longer emitted as a header, but a colon would still be wrong in an
      // id shaped like an addr-spec, and this is the only place the derivation
      // is observable.
      expect(h.setInquirerEmailMessageId).toHaveBeenCalledWith({
        id: REQUEST_ID,
        messageId: `booking-inquiry.${REQUEST_ID}.${MESSAGE_ID}@localhost`,
      });
      // A parseable URL is not a misconfiguration — nothing to report.
      expect(h.reportError).not.toHaveBeenCalled();
    });

    it("reports a PUBLIC_APP_URL that will not parse, and still sends", async () => {
      // Left silent, this threads every inquirer email under a hardcoded
      // foreign domain forever and nothing ever says so.
      const h = buildDeps({ publicAppUrl: "not a url" });

      await notifyBookingInquirer(h.deps, args());

      expect(h.send).toHaveBeenCalledOnce();
      expect(h.setInquirerEmailMessageId).toHaveBeenCalledWith({
        id: REQUEST_ID,
        messageId: `booking-inquiry.${REQUEST_ID}.${MESSAGE_ID}@ithasfire.com`,
      });
      expect(h.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ step: "message_id_domain" }),
        }),
      );
    });
  });

  describe("failure isolation (the venue's message is already committed)", () => {
    it("STILL SENDS the email when the mint/flip fails transiently", async () => {
      // THE REGRESSION THIS PINS: the flip used to run ahead of the send with
      // no catch of its own, so a connection reset here returned null WITHOUT
      // SENDING — and the post-commit hook fires exactly once per message, so
      // that venue reply was dropped permanently. `idempotencyKey` cannot
      // rescue a `send` that never happened. Delivery is the feature; the
      // owner pair is an optimisation.
      const h = buildDeps({
        ensureImpl: async () => {
          throw new Error("db down");
        },
      });

      const result = await notifyBookingInquirer(h.deps, args());

      expect(h.send).toHaveBeenCalledOnce();
      // The row stays anonymous; every other surface already handles that.
      expect(result?.performerOwnerId).toBeNull();
      expect(h.logger.error).toHaveBeenCalledWith(
        "booking_requests.notify_inquirer.attach_owner_failed",
        expect.objectContaining({ bookingRequestId: REQUEST_ID }),
      );
      expect(h.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "notifyBookingInquirer" },
          extra: expect.objectContaining({ step: "attach_owner" }),
        }),
      );
    });

    it("swallows + reports a send failure and never throws", async () => {
      const h = buildDeps({
        mailerImpl: async () => {
          throw new Error("provider down");
        },
      });

      const result = await notifyBookingInquirer(h.deps, args());

      expect(result).toBeNull();
      expect(h.logger.error).toHaveBeenCalledWith(
        "booking_requests.notify_inquirer_failed",
        expect.objectContaining({ bookingRequestId: REQUEST_ID }),
      );
      expect(h.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "notifyBookingInquirer" },
        }),
      );
    });

    it("STILL SENDS the email when the flip loses to duplicate_open_request", async () => {
      const h = buildDeps({
        attachImpl: async () => {
          throw {
            code: "duplicate_open_request",
            message: "duplicate_open_request",
          };
        },
      });

      const result = await notifyBookingInquirer(h.deps, args());

      // A dedupe collision is never a reason to drop a venue's reply.
      expect(h.send).toHaveBeenCalledOnce();
      // The row stays anonymous, which every other surface already handles.
      expect(result?.performerOwnerId).toBeNull();
      // Visible in Sentry — it means two open inquiries share one shadow.
      expect(h.reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          extra: expect.objectContaining({ step: "attach_owner_duplicate" }),
        }),
      );
    });

    it("swallows + reports a missing mailer", async () => {
      const h = buildDeps({ withMailer: false });
      const result = await notifyBookingInquirer(h.deps, args());
      expect(result).toBeNull();
      expect(h.reportError).toHaveBeenCalled();
    });

    it("survives a THROWING reporter", async () => {
      const h = buildDeps({
        mailerImpl: async () => {
          throw new Error("provider down");
        },
      });
      (h.deps as { reportError?: unknown }).reportError = () => {
        throw new Error("sentry down");
      };
      await expect(notifyBookingInquirer(h.deps, args())).resolves.toBeNull();
    });

    it("does not fail when the shadow's name update throws", async () => {
      const h = buildDeps();
      (
        h.deps.repos.humans as unknown as { update: ReturnType<typeof vi.fn> }
      ).update = vi.fn(async () => {
        throw new Error("name write failed");
      });

      const result = await notifyBookingInquirer(h.deps, args());

      expect(h.send).toHaveBeenCalledOnce();
      expect(result?.performerOwnerId).toBe(SHADOW_HUMAN_ID);
      expect(h.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ step: "shadow_name" }),
        }),
      );
    });
  });

  it("re-reads the request rather than trusting the pre-commit snapshot", async () => {
    // The caller hands over the row it loaded BEFORE the message transaction;
    // a concurrent claim in between must win.
    const claimedSince = shadowOwnedInquiry({
      claimedAt: new Date("2026-06-10T11:59:00.000Z"),
    });
    const h = buildDeps({ fresh: claimedSince });

    const result = await notifyBookingInquirer(h.deps, args());

    expect(h.getById).toHaveBeenCalledWith(REQUEST_ID);
    expect(h.send).not.toHaveBeenCalled();
    expect(result).toBe(claimedSince);
  });
});

