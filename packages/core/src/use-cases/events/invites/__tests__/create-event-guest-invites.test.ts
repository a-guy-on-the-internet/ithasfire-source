import { describe, expect, it, vi } from "vitest";

import type { MailerPort, MailerSendInput } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_OPT_OUT_SECRET,
  INVITE_EVENT_ID,
  INVITE_ORG_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_STRANGER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { mintInviteToken } from "../../../../lib/security/invite-token";
import {
  createEventGuestInvites,
  type CreateEventGuestInvitesDeps,
  INVITE_RESEND_COOLDOWN_SECONDS,
  MAX_GUEST_INVITE_RECIPIENTS,
  resendEventGuestInvite,
} from "../create-event-guest-invites";

type SentMail = MailerSendInput & {
  to: { to: string; name?: string };
  template: { key: string; variables: Record<string, unknown> };
};

const makeMailer = (impl?: () => Promise<unknown>) => {
  const send = vi.fn<[SentMail], Promise<unknown>>(
    impl ?? (async () => ({ result: { id: "msg", status: "queued" } })),
  );
  const mailer = { send, sendBatch: vi.fn(), health: vi.fn() };
  return mailer as unknown as MailerPort & { send: typeof send };
};

const depsFor = (
  world: InviteWorld,
  extra: {
    mailer?: MailerPort;
    reportError?: ReporterPort;
    logger?: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  } = {},
): CreateEventGuestInvitesDeps => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: extra.mailer ?? makeMailer(),
  reportError: extra.reportError,
  logger: extra.logger as unknown as LoggerPort | undefined,
});

const guests = (...emails: string[]) =>
  emails.map((email, i) => ({ name: `Guest ${i}`, email }));

describe("createEventGuestInvites (FR-002, FR-003)", () => {
  it("creates a PERSONAL invite per guest, lowercases emails, and emails each one with its own link", async () => {
    const world = createInviteWorld();
    const mailer = makeMailer();
    const out = await createEventGuestInvites(depsFor(world, { mailer }), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [
        { name: "Ana  <b>Ruiz</b>", email: "  Ana@Example.COM " },
        { name: "Bo", email: "bo@example.com" },
      ],
    });

    expect(out).toEqual({
      created: 2,
      reused: 0,
      skippedUnsubscribed: 0,
      skippedOptedOut: 0,
      skippedNoEmail: 0,
      sent: 2,
      failed: 0,
    });
    const ana = world.invites.find((i) => i.inviteeEmail === "ana@example.com");
    expect(ana).toMatchObject({ kind: "PERSONAL", sentAt: world.now });
    expect(ana?.inviteeName).not.toContain("<b>");

    expect(mailer.send).toHaveBeenCalledTimes(2);
    const first = mailer.send.mock.calls[0]![0];
    expect(first.to.to).toBe("ana@example.com");
    expect(first.template.key).toBe("event.invite");
    expect(first.template.variables).toMatchObject({
      eventTitle: "Basement Show",
      organizerName: "Stub Collective",
      inviteeName: ana?.inviteeName,
      inviteUrl: `${INVITE_APP_BASE_URL}/events/basement-show?invite=${mintInviteToken(ana!.id, INVITE_SECRET)}`,
    });
    expect(typeof first.template.variables.eventWhen).toBe("string");
    expect(world.audit.map((a) => a.action)).toEqual([
      "event_guest_invites_created",
    ]);
  });

  it("never puts the token anywhere but the template's inviteUrl", async () => {
    const world = createInviteWorld();
    const mailer = makeMailer();
    await createEventGuestInvites(depsFor(world, { mailer }), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });
    const token = mintInviteToken(world.invites[0]!.id, INVITE_SECRET);
    const call = mailer.send.mock.calls[0]![0];
    const { template, ...rest } = call;
    const { inviteUrl, ...otherVars } = template.variables;
    expect(String(inviteUrl)).toContain(token);
    expect(JSON.stringify(rest)).not.toContain(token);
    expect(JSON.stringify(otherVars)).not.toContain(token);
    expect(JSON.stringify(call.metadata ?? {})).not.toContain(token);
    expect(String(call.idempotencyKey)).not.toContain(token);
  });

  it("dedupes against live invites: reuses the row and sends nothing unless asked to resend", async () => {
    const world = createInviteWorld();
    const deps = depsFor(world);
    await createEventGuestInvites(deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });

    const mailer = makeMailer();
    const again = await createEventGuestInvites(depsFor(world, { mailer }), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ANA@example.com", "ana@example.com", "cy@example.com"),
    });
    expect(again).toMatchObject({ created: 1, reused: 1, sent: 1 });
    expect(world.invites).toHaveLength(2);
    expect(mailer.send).toHaveBeenCalledTimes(1);

    const resendMailer = makeMailer();
    const resent = await createEventGuestInvites(
      depsFor(world, { mailer: resendMailer }),
      {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: guests("ana@example.com"),
        resendExisting: true,
      },
    );
    expect(resent).toMatchObject({ created: 0, reused: 1, sent: 1 });
    expect(resendMailer.send).toHaveBeenCalledTimes(1);
  });

  it("a guest re-invited after a revoke gets a NEW row", async () => {
    const world = createInviteWorld();
    const deps = depsFor(world);
    await createEventGuestInvites(deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });
    world.invites[0]!.revokedAt = world.now;
    const out = await createEventGuestInvites(deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });
    expect(out.created).toBe(1);
    expect(world.invites).toHaveLength(2);
  });

  it("a concurrent send winning the email's unique index is retried and counted as reused", async () => {
    const world = createInviteWorld();
    world.hooks.beforePersonalCreate = (email) => {
      world.hooks.beforePersonalCreate = undefined;
      // A concurrent send inserts the same guest first.
      world.invites.push({
        id: "88888888-8888-4888-8888-888888888888",
        eventId: INVITE_EVENT_ID,
        kind: "PERSONAL",
        inviteeName: "Ana",
        inviteeEmail: email,
        tokenHash: "concurrent",
        createdByHumanId: INVITE_ORGANIZER_ID,
        inviteListEntryId: null,
        metadata: {},
        revokedAt: null,
        firstRedeemedAt: null,
        redemptionCount: 0,
        sentAt: world.now,
        createdAt: world.now,
        updatedAt: world.now,
      });
    };
    const out = await createEventGuestInvites(depsFor(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });
    expect(out).toMatchObject({ created: 0, reused: 1, sent: 0 });
  });

  describe("contact list send (FR-003)", () => {
    it("skips unsubscribed and suppressed entries and counts them apart; phone-only entries are counted apart", async () => {
      const world = createInviteWorld();
      const list = world.addList(undefined, [
        { contactEmail: "in@example.com", displayName: "In" },
        { contactEmail: "gone@example.com", unsubscribedAt: world.now },
        { contactEmail: "Blocked@Example.com" },
        { contactEmail: null, contactPhone: "+15555550100" },
        { contactEmail: "in@example.com" },
      ]);
      world.suppressed.add("blocked@example.com");

      const mailer = makeMailer();
      const out = await createEventGuestInvites(depsFor(world, { mailer }), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        contactListId: list.id,
      });
      expect(out).toEqual({
        created: 1,
        reused: 0,
        skippedUnsubscribed: 1,
        skippedOptedOut: 1,
        skippedNoEmail: 1,
        sent: 1,
        failed: 0,
      });
      expect(world.invites[0]).toMatchObject({
        inviteeEmail: "in@example.com",
        inviteeName: "In",
        inviteListEntryId: expect.any(String),
      });
    });

    it("a hand-added guest on the org suppression list gets no row and no email (owner ruling 10-05, replaces R13)", async () => {
      const world = createInviteWorld();
      world.suppressed.add("blocked@example.com");
      const mailer = makeMailer();
      const out = await createEventGuestInvites(depsFor(world, { mailer }), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: guests("Blocked@Example.com", "ok@example.com"),
      });
      expect(out).toMatchObject({
        created: 1,
        sent: 1,
        skippedUnsubscribed: 0,
        skippedOptedOut: 1,
      });
      expect(world.invites.map((i) => i.inviteeEmail)).toEqual(["ok@example.com"]);
      expect(mailer.send.mock.calls.map((c) => c[0].to.to)).toEqual([
        "ok@example.com",
      ]);
    });

    it(`refuses a list over ${MAX_GUEST_INVITE_RECIPIENTS} entries without inviting anyone`, async () => {
      const world = createInviteWorld();
      const list = world.addList(
        undefined,
        Array.from({ length: MAX_GUEST_INVITE_RECIPIENTS + 1 }, (_, i) => ({
          contactEmail: `g${i}@example.com`,
        })),
      );
      await expect(
        createEventGuestInvites(depsFor(world), {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          contactListId: list.id,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(world.invites).toHaveLength(0);
    });

    it("accepts a list of exactly the cap", async () => {
      const world = createInviteWorld();
      const list = world.addList(
        undefined,
        Array.from({ length: MAX_GUEST_INVITE_RECIPIENTS }, (_, i) => ({
          contactEmail: `g${i}@example.com`,
        })),
      );
      const out = await createEventGuestInvites(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        contactListId: list.id,
      });
      expect(out.created).toBe(MAX_GUEST_INVITE_RECIPIENTS);
    });

    it("refuses another owner's list as if it didn't exist", async () => {
      const world = createInviteWorld();
      const list = world.addList("77777777-7777-4777-8777-777777777777", [
        { contactEmail: "x@example.com" },
      ]);
      await expect(
        createEventGuestInvites(depsFor(world), {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          contactListId: list.id,
        }),
      ).rejects.toMatchObject({ code: "TARGET_LIST_NOT_FOUND" });
    });
  });

  describe("allowance charge covers skipped recipients (owner ruling 2026-10-07)", () => {
    /** A limiter that allows everything and records each charge. */
    const spyLimiter = () => {
      const consumeAllowance = vi.fn(async (_: { amount: number }) => ({
        allowed: true,
        results: [],
      }));
      const refundAllowance = vi.fn(async (_: { amount: number }) => {});
      return { consumeAllowance, refundAllowance };
    };
    const ORG_OWNER = { kind: "ORG" as const, orgId: INVITE_ORG_ID };

    it("charges a list send for every opted-out address, once per address; unsubscribed entries are free", async () => {
      const world = createInviteWorld();
      world.optOuts.add(world.optOutKey(ORG_OWNER, "org-no@example.com"));
      world.optOuts.add(world.optOutAllKey("all-no@example.com"));
      world.suppressed.add("suppressed@example.com");
      const list = world.addList(undefined, [
        { contactEmail: "org-no@example.com" },
        { contactEmail: "all-no@example.com" },
        { contactEmail: "suppressed@example.com" },
        { contactEmail: "in@example.com" },
        // Repeats of one address cost once.
        { contactEmail: "IN@example.com" },
        // Unsubscribed: free (the organiser already sees that status).
        { contactEmail: "gone@example.com", unsubscribedAt: world.now },
        { contactEmail: "gone@example.com", unsubscribedAt: world.now },
        { contactEmail: null, contactPhone: "+15555550100" },
      ]);
      const limiter = spyLimiter();
      const out = await createEventGuestInvites(
        { ...depsFor(world), rateLimit: limiter },
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          contactListId: list.id,
        },
      );
      expect(out).toMatchObject({
        created: 1,
        sent: 1,
        skippedOptedOut: 3,
        skippedUnsubscribed: 2,
        skippedNoEmail: 1,
      });
      // in + 3 opted out = 4.
      expect(limiter.consumeAllowance).toHaveBeenCalledTimes(1);
      expect(limiter.consumeAllowance.mock.calls[0]![0]).toMatchObject({ amount: 4 });
      // Everything charged for mail went out: nothing handed back.
      expect(limiter.refundAllowance).not.toHaveBeenCalled();
    });

    it("charges one unit for a single hand-added guest who opted out", async () => {
      const world = createInviteWorld();
      world.optOuts.add(world.optOutAllKey("ana@example.com"));
      const limiter = spyLimiter();
      const mailer = makeMailer();
      const out = await createEventGuestInvites(
        { ...depsFor(world, { mailer }), rateLimit: limiter },
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("ana@example.com"),
        },
      );
      expect(out).toMatchObject({ created: 0, sent: 0, skippedOptedOut: 1 });
      expect(limiter.consumeAllowance.mock.calls[0]![0]).toMatchObject({ amount: 1 });
      expect(limiter.refundAllowance).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it("an opted-out guest who already holds a live invite reads as reused and costs nothing", async () => {
      const world = createInviteWorld();
      await createEventGuestInvites(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: guests("ana@example.com"),
      });
      world.optOuts.add(world.optOutKey(ORG_OWNER, "ana@example.com"));
      const limiter = spyLimiter();
      const out = await createEventGuestInvites(
        { ...depsFor(world), rateLimit: limiter },
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("ana@example.com"),
        },
      );
      expect(out).toMatchObject({ created: 0, reused: 1, sent: 0, skippedOptedOut: 0 });
      expect(limiter.consumeAllowance).not.toHaveBeenCalled();
    });
  });

  it(`caps hand-added guests at ${MAX_GUEST_INVITE_RECIPIENTS}`, async () => {
    const world = createInviteWorld();
    await expect(
      createEventGuestInvites(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: guests(
          ...Array.from(
            { length: MAX_GUEST_INVITE_RECIPIENTS + 1 },
            (_, i) => `g${i}@example.com`,
          ),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("send failure (deliberate swallow + ReporterPort)", () => {
    it("keeps the invite unsent, counts the failure, and reports ONCE per batch without the token", async () => {
      const world = createInviteWorld();
      const reportError = vi.fn();
      const logger = { error: vi.fn(), info: vi.fn() };
      const mailer = makeMailer(async () => {
        throw new Error("ses down");
      });
      const out = await createEventGuestInvites(
        depsFor(world, { mailer, reportError, logger }),
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("a@example.com", "b@example.com"),
        },
      );
      expect(out).toMatchObject({ created: 2, sent: 0, failed: 2 });
      expect(world.invites.every((i) => i.sentAt === null)).toBe(true);

      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, ctx] = reportError.mock.calls[0]!;
      expect((err as Error).message).toBe("ses down");
      expect(ctx).toMatchObject({
        tags: { useCase: "createEventGuestInvites", channel: "inviteEmail" },
        extra: { eventId: INVITE_EVENT_ID, failed: 2, attempted: 2 },
      });
      for (const invite of world.invites) {
        const token = mintInviteToken(invite.id, INVITE_SECRET);
        expect(JSON.stringify(ctx)).not.toContain(token);
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(token);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("a throwing reporter changes nothing", async () => {
      const world = createInviteWorld();
      const mailer = makeMailer(async () => {
        throw new Error("ses down");
      });
      const out = await createEventGuestInvites(
        depsFor(world, {
          mailer,
          reportError: () => {
            throw new Error("sentry down");
          },
        }),
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("a@example.com"),
        },
      );
      expect(out).toMatchObject({ created: 1, failed: 1 });
    });

    it("a missing mailer is a reported failure, not a thrown one", async () => {
      const world = createInviteWorld();
      const reportError = vi.fn();
      const out = await createEventGuestInvites(
        { ...depsFor(world, { reportError }), mailer: undefined },
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("a@example.com"),
        },
      );
      expect(out).toMatchObject({ created: 1, failed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["DRAFT", "ARCHIVED"] as const)(
    "refuses to send invites for a %s event (its page isn't public)",
    async (status) => {
      const world = createInviteWorld({ event: { status } });
      const mailer = makeMailer();
      await expect(
        createEventGuestInvites(depsFor(world, { mailer }), {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: guests("a@example.com"),
        }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
      expect(world.invites).toHaveLength(0);
      expect(mailer.send).not.toHaveBeenCalled();
    },
  );

  it("refuses a resend once the event is no longer published", async () => {
    const world = createInviteWorld();
    await createEventGuestInvites(depsFor(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("a@example.com"),
    });
    world.event.status = "ARCHIVED";
    await expect(
      resendEventGuestInvite(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        inviteId: world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("requires a verified organizer email (NFR-004)", async () => {
    const world = createInviteWorld();
    world.verified.clear();
    await expect(
      createEventGuestInvites(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: guests("a@example.com"),
      }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(world.invites).toHaveLength(0);
  });

  it("requires edit rights", async () => {
    const world = createInviteWorld();
    world.verified.add(INVITE_STRANGER_ID);
    await expect(
      createEventGuestInvites(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_STRANGER_ID,
        guests: guests("a@example.com"),
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("resendEventGuestInvite (FR-002 Resend)", () => {
  const seed = async (world: InviteWorld) => {
    await createEventGuestInvites(depsFor(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: guests("ana@example.com"),
    });
    const invite = world.invites[0]!;
    // Past the resend cooldown unless a test says otherwise.
    invite.sentAt = new Date(world.now.getTime() - 11 * 60_000);
    return invite;
  };

  it("refuses a resend within 10 minutes of the last send, before charging anything", async () => {
    const world = createInviteWorld();
    const invite = await seed(world);
    invite.sentAt = new Date(world.now.getTime() - 4 * 60_000);
    const mailer = makeMailer();
    const consumeAllowance = vi.fn();
    expect(INVITE_RESEND_COOLDOWN_SECONDS).toBe(600);
    await expect(
      resendEventGuestInvite(
        { ...depsFor(world, { mailer }), rateLimit: { consumeAllowance, refundAllowance: vi.fn() } },
        { eventId: INVITE_EVENT_ID, inviteId: invite.id, actorHumanId: INVITE_ORGANIZER_ID },
      ),
    ).rejects.toMatchObject({
      code: "INVITE_RESEND_TOO_SOON",
      meta: { retryAfterSeconds: 360 },
    });
    expect(consumeAllowance).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("allows the resend once 10 minutes have passed", async () => {
    const world = createInviteWorld();
    const invite = await seed(world);
    invite.sentAt = new Date(world.now.getTime() - 600_000);
    const out = await resendEventGuestInvite(depsFor(world), {
      eventId: INVITE_EVENT_ID,
      inviteId: invite.id,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(out.sent).toBe(true);
  });

  it("re-sends the same link and stamps sentAt", async () => {
    const world = createInviteWorld();
    const invite = await seed(world);
    invite.sentAt = null;
    const mailer = makeMailer();
    const out = await resendEventGuestInvite(depsFor(world, { mailer }), {
      eventId: INVITE_EVENT_ID,
      inviteId: invite.id,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(out).toEqual({
      inviteId: invite.id,
      sent: true,
      optedOut: false,
      sentAt: world.now,
    });
    const vars = mailer.send.mock.calls[0]![0].template.variables;
    expect(String(vars.inviteUrl)).toContain(mintInviteToken(invite.id, INVITE_SECRET));
  });

  it("reports a failed resend and returns sent: false", async () => {
    const world = createInviteWorld();
    const invite = await seed(world);
    const reportError = vi.fn();
    const out = await resendEventGuestInvite(
      depsFor(world, {
        reportError,
        mailer: makeMailer(async () => {
          throw new Error("bounce");
        }),
      }),
      { eventId: INVITE_EVENT_ID, inviteId: invite.id, actorHumanId: INVITE_ORGANIZER_ID },
    );
    expect(out.sent).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("refuses a revoked invite and an invite of another event", async () => {
    const world = createInviteWorld();
    const invite = await seed(world);
    invite.revokedAt = world.now;
    await expect(
      resendEventGuestInvite(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        inviteId: invite.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });

    invite.revokedAt = null;
    invite.eventId = "66666666-6666-4666-8666-666666666666";
    await expect(
      resendEventGuestInvite(depsFor(world), {
        eventId: INVITE_EVENT_ID,
        inviteId: invite.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "MAGIC_LINK_NOT_FOUND" });
  });
});
