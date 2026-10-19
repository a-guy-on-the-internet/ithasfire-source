import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "@th/test-utils/fakes/idempotency";
import { authzRepoPrototype } from "@th/test-utils/fakes/prototypes/repos";

import {
  sendAnnouncement,
  type SendAnnouncementDeps,
} from "./send-announcement";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const ACTOR_ID = randomUUID();
const EVENT_ID = randomUUID();
const EVENT_SLUG = "org-slug/us/general/the-show--ab12cd";
const TIER_ID = randomUUID();
const LIST_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const FOREIGN_EVENT_ID = randomUUID();
const FOREIGN_TIER_ID = randomUUID();
const FOREIGN_LIST_ID = randomUUID();
const ANNOUNCEMENT_ID = randomUUID();
const NOW = new Date("2026-03-10T12:00:00Z");

function makeMailerMock(): MailerPort {
  return {
    send: vi.fn(async () => ({ result: { success: true, id: "msg_1" } })),
    sendBatch: vi.fn(async () => ({
      ok: true,
      results: [{ success: true, id: "msg_batch_1" }],
    })) as any,
    health: vi.fn(async () => ({ ok: true, vendor: "mock", latencyMs: 0 })),
  };
}

function makeAnnouncementsRepo(overrides?: {
  recipientCount?: number;
  recipients?: Array<{
    email: string;
    name: string | null;
    contactListEntryId: string | null;
    inviteListId: string | null;
    waitlistEntryId?: string | null;
    waitlistEventId?: string | null;
    humanId?: string | null;
  }>;
  latestAnnouncement?: Record<string, unknown> | null;
  anonSuppressed?: Set<string>;
}) {
  return {
    getLatestByAudience: vi.fn(
      async () => overrides?.latestAnnouncement ?? null,
    ),
    countAudienceRecipients: vi.fn(async () => overrides?.recipientCount ?? 3),
    listAudienceRecipientEmails: vi.fn(async () =>
      (
        overrides?.recipients ?? [
          {
            email: "alice@example.com",
            name: "Alice",
            contactListEntryId: null,
            inviteListId: null,
          },
          {
            email: "bob@example.com",
            name: "Bob",
            contactListEntryId: null,
            inviteListId: null,
          },
          {
            email: "carol@example.com",
            name: null,
            contactListEntryId: null,
            inviteListId: null,
          },
        ]
      ).map((r) => ({
        waitlistEntryId: null,
        waitlistEventId: null,
        humanId: null,
        ...r,
      })),
    ),
    create: vi.fn(async (input: any) => ({
      id: ANNOUNCEMENT_ID,
      orgId: input.orgId,
      eventId: input.eventId ?? null,
      subject: input.subject,
      bodyDoc: input.bodyDoc,
      bodyHtml: input.bodyHtml,
      audienceType: input.audienceType,
      audienceRef: input.audienceRef ?? null,
      audienceFilter: input.audienceFilter ?? null,
      excludedContactListId: input.excludedContactListId ?? null,
      recipientCount: input.recipientCount ?? null,
      sentAt: input.sentAt ?? null,
      sentBy: input.sentBy,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    updateRecipientCount: vi.fn(async () => {}),
    insertAnonymousSuppression: vi.fn(async () => {}),
    getAnonymousSuppressedEmails: vi.fn(
      async () => overrides?.anonSuppressed ?? new Set<string>(),
    ),
  };
}

function makeAuditRepo() {
  return {
    log: vi.fn(async () => {}),
  };
}

interface MakeDepsOptions {
  mailer?: MailerPort | null;
  membership?: { role: string } | null;
  recipientCount?: number;
  recipients?: Array<{
    email: string;
    name: string | null;
    contactListEntryId: string | null;
    inviteListId: string | null;
    waitlistEntryId?: string | null;
    waitlistEventId?: string | null;
    humanId?: string | null;
  }>;
  /** Override the return value of `getLatestByAudience` for cooldown tests. */
  latestAnnouncement?: Record<string, unknown> | null;
  idempotencyBeginSequence?: boolean[];
  publicAppUrl?: string;
  unsubscribeSecret?: string;
  senderPhysicalAddress?: string;
  notify?: SendAnnouncementDeps["notify"];
  /** Override the organization's physical address (per-org CAN-SPAM). */
  orgPhysicalAddress?: string | null;
  /** Optional background job enqueue callback. */
  enqueueNotifyJob?: SendAnnouncementDeps["enqueueNotifyJob"];
  /** Map of humanId → announcement-email-enabled for the pref filter. */
  announcementEmailEnabled?: Map<string, boolean>;
  /** Set of lowercased emails suppressed for anonymous recipients. */
  anonSuppressed?: Set<string>;
  /** Mark the deps as running in production (drives fail-closed guards). */
  isProduction?: boolean;
  /** When true, the consent pref lookup rejects (to test fail-closed). */
  failPrefLookup?: boolean;
  /** Actor's identity email verification state (default true). */
  emailVerified?: boolean;
  /** Recipients whose account email is NOT verified (B2; default none). */
  unverifiedHumanIds?: string[];
  /** When true, the verified-recipient lookup rejects. */
  failVerifiedLookup?: boolean;
  /** Extra events in the fake world (e.g. another org's event). */
  extraEvents?: Array<{ id: string; orgId: string | null; humanId: string | null }>;
  /** Extra contact lists in the fake world. */
  extraLists?: Array<{ id: string; ownerType: string; ownerId: string }>;
  /** Ticket type ids per event id (default: EVENT_ID → [TIER_ID]). */
  ticketTypes?: Record<string, string[]>;
}

function makeDeps(options: MakeDepsOptions = {}) {
  const authz = { ...authzRepoPrototype };
  authz.getOrgMembership = vi.fn(async () =>
    options.membership !== undefined ? options.membership : { role: "OWNER" },
  );

  const announcementsRepo = makeAnnouncementsRepo({
    recipientCount: options.recipientCount,
    recipients: options.recipients,
    latestAnnouncement: options.latestAnnouncement,
    anonSuppressed: options.anonSuppressed,
  });

  const notificationPrefsRepo = {
    batchReadAnnouncementEmailEnabled: vi.fn(async () => {
      if (options.failPrefLookup) {
        throw new Error("pref DB unavailable");
      }
      return options.announcementEmailEnabled ?? new Map<string, boolean>();
    }),
    upsert: vi.fn(async () => {}),
    readEffective: vi.fn(async () => ({})),
  };
  const auditRepo = makeAuditRepo();
  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });

  const organizationsRepo = {
    getById: vi.fn(async () => ({
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      status: "ACTIVE",
      defaultLocale: null,
      contactEmail: null,
      physicalAddress: options.orgPhysicalAddress ?? null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      createdAt: NOW,
    })),
  };

  const resourceQuotasMock = {
    getEffectiveQuota: vi.fn(async () => ({
      kind: "ANNOUNCEMENTS_PER_DAY" as const,
      limitValue: 20n,
      currentUsage: 0n,
      isOverride: false,
    })),
    hasPendingExpansionRequest: vi.fn(async () => false),
    incrementUsage: vi.fn(async (input: any) => ({
      id: "usage-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentUsage: 1n,
      updatedAt: NOW,
      createdAt: NOW,
    })),
  };

  const txMock = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    return fn({
      announcements: announcementsRepo,
      audit: auditRepo,
      resourceQuotas: resourceQuotasMock,
    });
  });

  // The in-app action routes by SLUG (an id route 404s on the public page), so
  // the use case resolves the event once per send.
  // Ownership (F4): events/tiers/lists resolve from a small world keyed by id,
  // so a test can name a FOREIGN object and expect the send to be refused.
  const events = new Map<
    string,
    { id: string; slug: string; orgId: string | null; humanId: string | null }
  >([[EVENT_ID, { id: EVENT_ID, slug: EVENT_SLUG, orgId: ORG_ID, humanId: null }]]);
  for (const e of options.extraEvents ?? []) events.set(e.id, { slug: "x", ...e });
  const eventsRepo = {
    getById: vi.fn(async (id: string) => events.get(id) ?? null),
    listTicketTypes: vi.fn(async (eventId: string) =>
      (options.ticketTypes?.[eventId] ?? (eventId === EVENT_ID ? [TIER_ID] : [])).map(
        (id) => ({ id }),
      ),
    ),
  };
  const lists = new Map<string, { id: string; ownerType: string; ownerId: string }>([
    [LIST_ID, { id: LIST_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID }],
  ]);
  for (const l of options.extraLists ?? []) lists.set(l.id, l);
  const inviteListsRepo = {
    getListById: vi.fn(async (id: string) => lists.get(id) ?? null),
  };

  const humansRepo = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR_ID, name: "Actor" },
      identity: {
        email: "actor@example.com",
        emailVerified: options.emailVerified ?? true,
      },
    })),
    listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => {
      if (options.failVerifiedLookup) throw new Error("db down");
      const unverified = new Set(options.unverifiedHumanIds ?? []);
      return [...new Set(ids)].filter((id) => !unverified.has(id));
    }),
  };

  const repos = {
    authz,
    humans: humansRepo,
    announcements: announcementsRepo,
    organizations: organizationsRepo,
    notificationPrefs: notificationPrefsRepo,
    audit: auditRepo,
    events: eventsRepo,
    inviteLists: inviteListsRepo,
    tx: txMock,
  } as any;

  const resolvedMailer =
    options && "mailer" in options
      ? (options.mailer ?? undefined)
      : makeMailerMock();

  const logger = createTestLogger();

  const deps: SendAnnouncementDeps = {
    repos,
    idempotency,
    clock: { now: () => NOW } satisfies ClockPort,
    logger,
    mailer: resolvedMailer,
    publicAppUrl: options.publicAppUrl,
    unsubscribeSecret: options.unsubscribeSecret,
    senderPhysicalAddress: options.senderPhysicalAddress,
    isProduction: options.isProduction,
    notify: options.notify,
    enqueueNotifyJob: options.enqueueNotifyJob,
  };

  return {
    deps,
    logger,
    announcementsRepo,
    notificationPrefsRepo,
    auditRepo,
    idempotency,
    mailer: resolvedMailer,
    eventsRepo,
    inviteListsRepo,
  };
}

function validInput(overrides?: Partial<ReturnType<typeof baseInput>>) {
  return { ...baseInput(), ...overrides };
}

function baseInput() {
  return {
    ownerType: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    actorHumanId: ACTOR_ID,
    subject: "Tickets now available!",
    bodyDoc: { type: "doc", content: [] },
    bodyHtml: "<p>Get your tickets now.</p>",
    audienceType: "WAITLIST_SUBSCRIBERS" as const,
    audienceRef: EVENT_ID,
    eventId: EVENT_ID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("sendAnnouncement", () => {
  describe("happy path", () => {
    it("persists the announcement and dispatches emails for WAITLIST_SUBSCRIBERS", async () => {
      const { deps, announcementsRepo, auditRepo, mailer } = makeDeps();

      const result = await sendAnnouncement(deps, validInput());

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(result.sentAt).toEqual(NOW);

      // Verify announcement was created via tx
      expect(announcementsRepo.create).toHaveBeenCalledOnce();
      const createArg = (announcementsRepo.create as Mock).mock.calls[0]![0];
      expect(createArg.audienceType).toBe("WAITLIST_SUBSCRIBERS");
      expect(createArg.audienceRef).toBe(EVENT_ID);
      expect(createArg.orgId).toBe(ORG_ID);
      expect(createArg.recipientCount).toBe(3);

      // Verify audit log
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "announcement",
          action: "announcement.sent",
          data: expect.objectContaining({
            audienceType: "WAITLIST_SUBSCRIBERS",
            recipientCount: 3,
          }),
        }),
      );

      // Verify email dispatch
      expect(mailer!.sendBatch).toHaveBeenCalledOnce();
      const batchArg = (mailer!.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg).toHaveLength(3);
      expect(batchArg[0].to).toEqual({
        to: "alice@example.com",
        name: "Alice",
      });
      expect(batchArg[0].subject).toBe("Tickets now available!");
      expect(batchArg[0].html).toBe("<p>Get your tickets now.</p>");
      expect(batchArg[0].tags).toContain("announcement");
    });

    it("persists the announcement for ALL_TICKET_HOLDERS", async () => {
      const { deps, announcementsRepo } = makeDeps();

      const result = await sendAnnouncement(
        deps,
        validInput({
          audienceType: "ALL_TICKET_HOLDERS",
          audienceRef: undefined,
          eventId: undefined,
        }),
      );

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      const createArg = (announcementsRepo.create as Mock).mock.calls[0]![0];
      expect(createArg.audienceType).toBe("ALL_TICKET_HOLDERS");
    });

    it("persists the announcement for EVENT_TICKET_HOLDERS", async () => {
      const { deps, announcementsRepo } = makeDeps();

      const result = await sendAnnouncement(
        deps,
        validInput({
          audienceType: "EVENT_TICKET_HOLDERS",
          audienceRef: EVENT_ID,
        }),
      );

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      const createArg = (announcementsRepo.create as Mock).mock.calls[0]![0];
      expect(createArg.audienceType).toBe("EVENT_TICKET_HOLDERS");
      expect(createArg.audienceRef).toBe(EVENT_ID);
    });
  });

  describe("RBAC", () => {
    it("throws forbidden when actor has no membership", async () => {
      const { deps } = makeDeps({ membership: null });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("throws forbidden for VIEWER role", async () => {
      const { deps } = makeDeps({ membership: { role: "VIEWER" } });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it.each(["OWNER", "ADMIN", "EDITOR"])("allows %s role", async (role) => {
      const { deps } = makeDeps({ membership: { role } });

      const result = await sendAnnouncement(deps, validInput());
      expect(result.id).toBe(ANNOUNCEMENT_ID);
    });
  });

  describe("input validation", () => {
    it("rejects WAITLIST_SUBSCRIBERS without audienceRef", async () => {
      const { deps } = makeDeps();

      await expect(
        sendAnnouncement(deps, validInput({ audienceRef: undefined })),
      ).rejects.toThrow();
    });

    it("rejects EVENT_TICKET_HOLDERS without audienceRef", async () => {
      const { deps } = makeDeps();

      await expect(
        sendAnnouncement(
          deps,
          validInput({
            audienceType: "EVENT_TICKET_HOLDERS",
            audienceRef: undefined,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects CONTACT_LIST without audienceRef", async () => {
      const { deps } = makeDeps();

      await expect(
        sendAnnouncement(
          deps,
          validInput({ audienceType: "CONTACT_LIST", audienceRef: undefined }),
        ),
      ).rejects.toThrow();
    });

    it("rejects empty subject", async () => {
      const { deps } = makeDeps();

      await expect(
        sendAnnouncement(deps, validInput({ subject: "" })),
      ).rejects.toThrow();
    });

    it("rejects bodyHtml exceeding 150 KB", async () => {
      const { deps } = makeDeps();
      // Build a string that exceeds 150 000 bytes
      const oversizedHtml = "<p>" + "x".repeat(150_001) + "</p>";

      await expect(
        sendAnnouncement(deps, validInput({ bodyHtml: oversizedHtml })),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  // Rate limiting / cooldown is enforced at the transport layer via the
  // `rateLimit` tRPC middleware — see `packages/transport/trpc/src/routers/announcements.ts`.

  describe("recipient cap", () => {
    it("rejects when recipient count exceeds MAX_RECIPIENTS", async () => {
      const { deps } = makeDeps({ recipientCount: 10_001 });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("exceeds the maximum"),
      });
    });

    it("allows exactly MAX_RECIPIENTS", async () => {
      const { deps } = makeDeps({ recipientCount: 10_000 });

      const result = await sendAnnouncement(deps, validInput());
      expect(result.id).toBe(ANNOUNCEMENT_ID);
    });
  });

  describe("idempotency", () => {
    it("returns cached result on duplicate key", async () => {
      const { deps, idempotency } = makeDeps();

      // First call succeeds
      const result1 = await sendAnnouncement(
        deps,
        validInput({ idempotencyKey: "test-idem-key-001" }),
      );

      // Manually commit result so the next call replays
      // (The use case already committed; the fake idempotency port stores it.)

      // Second call with the same key should replay
      const result2 = await sendAnnouncement(
        deps,
        validInput({ idempotencyKey: "test-idem-key-001" }),
      );

      expect(result2.id).toBe(result1.id);
    });
  });

  describe("email dispatch", () => {
    it("skips dispatch when mailer is not configured", async () => {
      const { deps, announcementsRepo } = makeDeps({ mailer: null });

      const result = await sendAnnouncement(deps, validInput());

      // Announcement is still persisted
      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(announcementsRepo.create).toHaveBeenCalledOnce();
      // No mailer calls
    });

    it("skips dispatch when recipient list is empty", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({ mailer, recipients: [] });

      const result = await sendAnnouncement(deps, validInput());

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(mailer.sendBatch).not.toHaveBeenCalled();
    });

    it("does not fail the announcement when email dispatch throws", async () => {
      const mailer = makeMailerMock();
      (mailer.sendBatch as Mock).mockRejectedValueOnce(new Error("SMTP gone"));

      const { deps } = makeDeps({ mailer });

      // Should not throw — dispatch errors are logged but swallowed
      const result = await sendAnnouncement(deps, validInput());

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(deps.logger.error).toHaveBeenCalledWith(
        "announcement_batch_send_failed",
        expect.objectContaining({ announcementId: ANNOUNCEMENT_ID }),
      );
    });

    it("adds List-Unsubscribe headers for contact list recipients", async () => {
      const mailer = makeMailerMock();
      const listId = LIST_ID; // owned by ORG_ID (F4 ownership check)
      const entryId = randomUUID();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "subscriber@example.com",
            name: "Sub",
            contactListEntryId: entryId,
            inviteListId: listId,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "CONTACT_LIST", audienceRef: listId }),
      );

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg).toHaveLength(1);
      expect(batchArg[0].headers).toBeDefined();
      expect(batchArg[0].headers["List-Unsubscribe"]).toContain("unsubscribe");
      expect(batchArg[0].headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
    });

    it("adds List-Unsubscribe headers for waitlist subscribers", async () => {
      const mailer = makeMailerMock();
      const eventId = EVENT_ID; // owned by ORG_ID (F4 ownership check)
      const entryId = randomUUID();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "waitlisted@example.com",
            name: "W",
            contactListEntryId: null,
            inviteListId: null,
            waitlistEntryId: entryId,
            waitlistEventId: eventId,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(
        deps,
        validInput({
          audienceType: "WAITLIST_SUBSCRIBERS",
          audienceRef: eventId,
        }),
      );

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg).toHaveLength(1);
      expect(batchArg[0].headers).toBeDefined();
      expect(batchArg[0].headers["List-Unsubscribe"]).toContain(
        "kind=waitlist",
      );
      expect(batchArg[0].headers["List-Unsubscribe"]).toContain(
        `eventId=${eventId}`,
      );
      expect(batchArg[0].headers["List-Unsubscribe"]).toContain("unsubscribe");
      expect(batchArg[0].headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
    });

    it("does not add unsubscribe headers when secret is absent", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "waitlisted@example.com",
            name: "W",
            contactListEntryId: null,
            inviteListId: null,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        // no unsubscribeSecret
      });

      await sendAnnouncement(deps, validInput());

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg).toHaveLength(1);
      // No headers because unsubscribeSecret is not set
      expect(batchArg[0].headers).toBeUndefined();
    });
  });

  describe("audit logging", () => {
    it("logs all audience metadata in the audit record", async () => {
      const { deps, auditRepo } = makeDeps({ recipientCount: 5 });

      await sendAnnouncement(deps, validInput());

      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "announcement",
          entityId: ANNOUNCEMENT_ID,
          action: "announcement.sent",
          data: expect.objectContaining({
            actorHumanId: ACTOR_ID,
            orgId: ORG_ID,
            subject: "Tickets now available!",
            audienceType: "WAITLIST_SUBSCRIBERS",
            audienceRef: EVENT_ID,
            recipientCount: 5,
          }),
        }),
      );
    });
  });

  describe("CAN-SPAM email footer", () => {
    it("appends visible unsubscribe link to email HTML body", async () => {
      const mailer = makeMailerMock();
      const listId = LIST_ID; // owned by ORG_ID (F4 ownership check)
      const entryId = randomUUID();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "sub@example.com",
            name: "Sub",
            contactListEntryId: entryId,
            inviteListId: listId,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "CONTACT_LIST", audienceRef: listId }),
      );

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].html).toContain("Unsubscribe");
      expect(batchArg[0].html).toContain("unsubscribe?listId=");
    });

    it("includes physical address in footer when configured", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        senderPhysicalAddress: "123 Main St, Anytown, ST 12345",
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(deps, validInput());

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].html).toContain("123 Main St, Anytown, ST 12345");
    });

    it("omits footer when no unsubscribe URL and no physical address", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        // no publicAppUrl, no unsubscribeSecret, no senderPhysicalAddress
      });

      await sendAnnouncement(deps, validInput());

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      // Should be exactly the input HTML with no footer appended
      expect(batchArg[0].html).toBe("<p>Get your tickets now.</p>");
    });
  });

  describe("in-app / push notifications", () => {
    it("dispatches notifications for recipients with humanIds", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const humanId1 = randomUUID();
      const humanId2 = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId: humanId1,
          },
          {
            email: "b@example.com",
            name: "B",
            contactListEntryId: null,
            inviteListId: null,
            humanId: humanId2,
          },
          {
            email: "c@example.com",
            name: "C",
            contactListEntryId: null,
            inviteListId: null,
            humanId: null,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      // Only 2 recipients have humanIds
      expect(notifyMock).toHaveBeenCalledTimes(2);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: humanId1,
          variant: "notification.generic",
        }),
      );
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: humanId2,
          variant: "notification.generic",
        }),
      );
    });

    // B2: an audience Human reached through a ticket or an address may be an
    // unverified account someone else opened under that address.
    it("sends in-app only to verified recipients; the email still goes to every address", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const verified = randomUUID();
      const unverified = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        unverifiedHumanIds: [unverified],
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId: verified,
          },
          {
            email: "b@example.com",
            name: "B",
            contactListEntryId: null,
            inviteListId: null,
            humanId: unverified,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: verified }),
      );
      const sent = (deps.mailer!.sendBatch as ReturnType<typeof vi.fn>).mock
        .calls.flatMap((c) => c[0] as Array<{ to: unknown }>);
      expect(JSON.stringify(sent)).toContain("b@example.com");
    });

    it("enqueues only verified recipients for the background job", async () => {
      const enqueueMock = vi.fn(async () => {});
      const verified = randomUUID();
      const unverified = randomUUID();
      const { deps } = makeDeps({
        enqueueNotifyJob: enqueueMock,
        unverifiedHumanIds: [unverified],
        recipients: [verified, unverified].map((humanId, i) => ({
          email: `r${i}@example.com`,
          name: null,
          contactListEntryId: null,
          inviteListId: null,
          humanId,
        })),
      });

      await sendAnnouncement(deps, validInput());

      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({ humanIds: [verified] }),
      );
    });

    it("a failed verification lookup sends no in-app, is reported, and still succeeds", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const reportError = vi.fn();
      const { deps } = makeDeps({
        notify: notifyMock,
        failVerifiedLookup: true,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId: randomUUID(),
          },
        ],
      });
      (deps as { reportError?: unknown }).reportError = reportError;

      await expect(sendAnnouncement(deps, validInput())).resolves.toBeDefined();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "db down" }),
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "verified_lookup" },
        }),
      );
    });

    it("deduplicates humanIds across recipients", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const humanId = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
          {
            email: "b@example.com",
            name: "B",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      // Same humanId appears twice, but should only notify once
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it("skips notifications when notify dep is absent", async () => {
      const { deps } = makeDeps({
        // no notify
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId: randomUUID(),
          },
        ],
      });

      // Should not throw — just skip
      const result = await sendAnnouncement(deps, validInput());
      expect(result.id).toBe(ANNOUNCEMENT_ID);
    });

    it("does not fail the announcement when a notification dispatch throws", async () => {
      const notifyMock = vi.fn(async () => {
        throw new Error("push service down");
      });
      const { deps } = makeDeps({
        notify: notifyMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId: randomUUID(),
          },
        ],
      });

      const result = await sendAnnouncement(deps, validInput());
      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "announcement_notify_failed",
        expect.objectContaining({ announcementId: ANNOUNCEMENT_ID }),
      );
    });

    it("includes event action link when eventId is present", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const humanId = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
      });

      await sendAnnouncement(deps, validInput({ eventId: EVENT_ID }));

      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            // SLUG route — `/events/<uuid>` 404s on the public page.
            action: { label: "View event", route: `/events/${EVENT_SLUG}` },
          }),
        }),
      );
    });
  });

  describe("background notify dispatch (enqueueNotifyJob)", () => {
    it("enqueues a job instead of calling notify inline when enqueueNotifyJob is provided", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const enqueueMock = vi.fn(async () => {});
      const humanId = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        enqueueNotifyJob: enqueueMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      // Job was enqueued
      expect(enqueueMock).toHaveBeenCalledOnce();
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          announcementId: ANNOUNCEMENT_ID,
          orgId: ORG_ID,
          subject: "Tickets now available!",
          eventId: EVENT_ID,
          humanIds: [humanId],
        }),
      );

      // Inline notify was NOT called
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("falls back to inline notify when enqueue fails", async () => {
      const notifyMock = vi.fn(async () => ({}));
      const enqueueMock = vi.fn(async () => {
        throw new Error("job service down");
      });
      const humanId = randomUUID();
      const { deps } = makeDeps({
        notify: notifyMock,
        enqueueNotifyJob: enqueueMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      // Enqueue was attempted
      expect(enqueueMock).toHaveBeenCalledOnce();

      // Fell back to inline notify
      expect(notifyMock).toHaveBeenCalledOnce();
    });

    it("does not enqueue when there are no humanIds", async () => {
      const enqueueMock = vi.fn(async () => {});
      const { deps } = makeDeps({
        enqueueNotifyJob: enqueueMock,
        recipients: [
          {
            email: "a@example.com",
            name: "A",
            contactListEntryId: null,
            inviteListId: null,
          },
        ],
      });

      await sendAnnouncement(deps, validInput());

      expect(enqueueMock).not.toHaveBeenCalled();
    });
  });

  describe("per-org physical address", () => {
    it("uses the org's physicalAddress when available (overriding platform default)", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        senderPhysicalAddress: "Platform HQ, 999 Global Ave, World 00000",
        orgPhysicalAddress: "Org Office, 42 Event Lane, Cityville 11111",
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(deps, validInput());

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].html).toContain(
        "Org Office, 42 Event Lane, Cityville 11111",
      );
      expect(batchArg[0].html).not.toContain("Platform HQ");
    });

    it("falls back to platform senderPhysicalAddress when org has no address", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        senderPhysicalAddress: "Platform HQ, 999 Global Ave, World 00000",
        orgPhysicalAddress: null,
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
      });

      await sendAnnouncement(deps, validInput());

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].html).toContain(
        "Platform HQ, 999 Global Ave, World 00000",
      );
    });
  });

  describe("E2E-lite: full email structure", () => {
    it("produces a complete email with body, footer, unsubscribe link, headers, and physical address", async () => {
      const mailer = makeMailerMock();
      const listId = LIST_ID; // owned by ORG_ID (F4 ownership check)
      const entryId = randomUUID();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "fan@example.com",
            name: "Fan",
            contactListEntryId: entryId,
            inviteListId: listId,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
        orgPhysicalAddress: "100 Arena Blvd, Suite 200, Eventsville, CA 90210",
      });

      await sendAnnouncement(
        deps,
        validInput({
          audienceType: "CONTACT_LIST",
          audienceRef: listId,
          subject: "Big Show Tomorrow!",
          bodyHtml: "<h1>Don't miss it!</h1><p>Doors open at 7pm.</p>",
        }),
      );

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg).toHaveLength(1);

      const email = batchArg[0];

      // Subject
      expect(email.subject).toBe("Big Show Tomorrow!");

      // Recipient
      expect(email.to).toEqual({ to: "fan@example.com", name: "Fan" });

      // HTML body preserved
      expect(email.html).toContain("<h1>Don't miss it!</h1>");
      expect(email.html).toContain("<p>Doors open at 7pm.</p>");

      // Visible unsubscribe link in footer
      expect(email.html).toContain("Unsubscribe");
      expect(email.html).toContain("unsubscribe?listId=");

      // Physical address in footer
      expect(email.html).toContain(
        "100 Arena Blvd, Suite 200, Eventsville, CA 90210",
      );

      // Footer styling (border-top separator)
      expect(email.html).toContain("border-top:1px solid #e5e7eb");

      // List-Unsubscribe header
      expect(email.headers).toBeDefined();
      expect(email.headers["List-Unsubscribe"]).toContain(
        "https://ithasfire.com/unsubscribe",
      );
      expect(email.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );

      // Metadata
      expect(email.metadata).toEqual({
        source: "announcement",
        announcementId: ANNOUNCEMENT_ID,
        orgId: ORG_ID,
      });
      expect(email.tags).toEqual(["announcement"]);
    });

    it("produces a valid email for waitlist subscribers with waitlist-specific unsubscribe", async () => {
      const mailer = makeMailerMock();
      const eventId = EVENT_ID; // owned by ORG_ID (F4 ownership check)
      const entryId = randomUUID();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "waitlisted@example.com",
            name: "Waiter",
            contactListEntryId: null,
            inviteListId: null,
            waitlistEntryId: entryId,
            waitlistEventId: eventId,
          },
        ],
        publicAppUrl: "https://ithasfire.com",
        unsubscribeSecret: "super-secret-unsubscribe-key-long-enough",
        orgPhysicalAddress: "200 Stage Dr, Nashville, TN 37201",
      });

      await sendAnnouncement(
        deps,
        validInput({
          audienceType: "WAITLIST_SUBSCRIBERS",
          audienceRef: eventId,
          subject: "Tickets released!",
          bodyHtml: "<p>Get yours before they're gone.</p>",
        }),
      );

      const email = (mailer.sendBatch as Mock).mock.calls[0]![0][0];

      // Waitlist-specific unsubscribe
      expect(email.headers["List-Unsubscribe"]).toContain("kind=waitlist");
      expect(email.headers["List-Unsubscribe"]).toContain(`eventId=${eventId}`);

      // Visible unsubscribe link
      expect(email.html).toContain("Unsubscribe");
      expect(email.html).toContain("kind=waitlist");

      // Physical address
      expect(email.html).toContain("200 Stage Dr, Nashville, TN 37201");

      // Original body preserved
      expect(email.html).toContain("Get yours before they're gone.");
    });

    it("produces a minimal email (no footer) when no unsub secret and no address", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        orgPhysicalAddress: null,
        // no publicAppUrl, no unsubscribeSecret, no senderPhysicalAddress
      });

      await sendAnnouncement(
        deps,
        validInput({
          bodyHtml: "<p>Plain announcement.</p>",
        }),
      );

      const email = (mailer.sendBatch as Mock).mock.calls[0]![0][0];

      // No footer appended (no unsub URL, no address)
      expect(email.html).toBe("<p>Plain announcement.</p>");
      expect(email.headers).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Org-level CAN-SPAM unsubscribe (every audience)
  // ───────────────────────────────────────────────────────────────────────────

  describe("org-level unsubscribe (CAN-SPAM for all audiences)", () => {
    const PUBLIC_URL = "https://ithasfire.com";
    const SECRET = "super-secret-unsubscribe-key-long-enough";

    it("emits List-Unsubscribe + a visible footer link for a ticket-holder audience", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "holder@example.com",
            name: "Holder",
            contactListEntryId: null,
            inviteListId: null,
          },
        ],
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "ALL_TICKET_HOLDERS", audienceRef: undefined }),
      );

      const email = (mailer.sendBatch as Mock).mock.calls[0]![0][0];

      // Header present and points at the org-level unsubscribe endpoint.
      expect(email.headers).toBeDefined();
      expect(email.headers["List-Unsubscribe"]).toContain("kind=org");
      expect(email.headers["List-Unsubscribe"]).toContain(`orgId=${ORG_ID}`);
      expect(email.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );

      // Visible CAN-SPAM unsubscribe link in the footer.
      expect(email.html).toContain("Unsubscribe");
      expect(email.html).toContain("kind=org");
    });

    it("contact-list recipient gets BOTH list-specific and org URLs in the header", async () => {
      const mailer = makeMailerMock();
      const listId = LIST_ID; // owned by ORG_ID (F4 ownership check)
      const { deps } = makeDeps({
        mailer,
        recipients: [
          {
            email: "subscriber@example.com",
            name: "Sub",
            contactListEntryId: randomUUID(),
            inviteListId: listId,
          },
        ],
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "CONTACT_LIST", audienceRef: listId }),
      );

      const email = (mailer.sendBatch as Mock).mock.calls[0]![0][0];
      const header: string = email.headers["List-Unsubscribe"];

      // Both the list-specific URL and the org URL are present.
      expect(header).toContain(`listId=${listId}`);
      expect(header).toContain("kind=org");
      expect(header).toContain(`orgId=${ORG_ID}`);
      // Comma-separated, RFC 2369 style: "<a>, <b>".
      expect(header).toMatch(/<[^>]+>,\s*<[^>]+>/);
      // The visible footer prefers the most-specific (list) URL.
      expect(email.html).toContain(`listId=${listId}`);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Preference enforcement before dispatch (Phase 2)
  // ───────────────────────────────────────────────────────────────────────────

  describe("preference-aware dispatch filtering", () => {
    const PUBLIC_URL = "https://ithasfire.com";
    const SECRET = "super-secret-unsubscribe-key-long-enough";

    it("excludes an org-opted-out human and an anon-suppressed email from dispatch and count", async () => {
      const mailer = makeMailerMock();
      const optedOutHumanId = randomUUID();
      const keptHumanId = randomUUID();

      const { deps, announcementsRepo } = makeDeps({
        mailer,
        recipientCount: 3,
        recipients: [
          {
            email: "opted-out@example.com",
            name: "Opted Out",
            contactListEntryId: null,
            inviteListId: null,
            humanId: optedOutHumanId,
          },
          {
            email: "kept@example.com",
            name: "Kept",
            contactListEntryId: null,
            inviteListId: null,
            humanId: keptHumanId,
          },
          {
            email: "anon-suppressed@example.com",
            name: null,
            contactListEntryId: null,
            inviteListId: null,
            humanId: null,
          },
        ],
        announcementEmailEnabled: new Map([
          [optedOutHumanId, false],
          [keptHumanId, true],
        ]),
        anonSuppressed: new Set(["anon-suppressed@example.com"]),
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "ALL_TICKET_HOLDERS", audienceRef: undefined }),
      );

      // Only the kept recipient should remain in the dispatched batch.
      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      const dispatchedEmails = batchArg.map((e: any) => e.to.to);
      expect(dispatchedEmails).toEqual(["kept@example.com"]);
      expect(dispatchedEmails).not.toContain("opted-out@example.com");
      expect(dispatchedEmails).not.toContain("anon-suppressed@example.com");

      // The persisted recipient count reflects the filtered set (1, not 3).
      expect(announcementsRepo.updateRecipientCount).toHaveBeenCalledWith(
        ANNOUNCEMENT_ID,
        1,
      );
    });

    it("keeps humans with no overriding pref row (default enabled)", async () => {
      const mailer = makeMailerMock();
      const humanId = randomUUID();

      const { deps, announcementsRepo } = makeDeps({
        mailer,
        recipients: [
          {
            email: "default@example.com",
            name: "Default",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
        // Empty map → no override → treated as enabled.
        announcementEmailEnabled: new Map(),
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await sendAnnouncement(
        deps,
        validInput({ audienceType: "ALL_TICKET_HOLDERS", audienceRef: undefined }),
      );

      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg.map((e: any) => e.to.to)).toEqual(["default@example.com"]);
      // No recipients dropped → no count rewrite.
      expect(announcementsRepo.updateRecipientCount).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Fail-closed hardening (CAN-SPAM opt-out + consent filter)
  // ───────────────────────────────────────────────────────────────────────────
  describe("fail-closed: unsubscribe URL unavailable", () => {
    const PUBLIC_URL = "https://ithasfire.com";
    const SECRET = "super-secret-unsubscribe-key-long-enough";

    it("throws and does NOT dispatch when in production and opt-out URL config is missing", async () => {
      const mailer = makeMailerMock();
      const { deps, logger } = makeDeps({
        mailer,
        isProduction: true,
        // Deliberately omit publicAppUrl + unsubscribeSecret so no one-click
        // opt-out can be attached.
      });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({
        code: "transient",
        message: expect.stringContaining("unsubscribe URL unavailable"),
      });

      // Critical: we must not have sent any mail without an opt-out.
      expect(mailer.sendBatch).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "announcement_unsubscribe_url_unavailable",
        expect.objectContaining({ announcementId: ANNOUNCEMENT_ID }),
      );
    });

    it("throws in production when only publicAppUrl is set (secret missing)", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        isProduction: true,
        publicAppUrl: PUBLIC_URL,
        // no unsubscribeSecret
      });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({
        code: "transient",
      });
      expect(mailer.sendBatch).not.toHaveBeenCalled();
    });

    it("dispatches normally in production when opt-out config IS present", async () => {
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        isProduction: true,
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await sendAnnouncement(deps, validInput());

      expect(mailer.sendBatch).toHaveBeenCalledOnce();
      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].headers["List-Unsubscribe"]).toBeDefined();
    });

    it("dev carve-out: still sends without opt-out headers when not in production", async () => {
      // Documents the local-dev ergonomics: with isProduction falsy the use
      // case degrades silently (sends with no List-Unsubscribe) so local
      // testing without the secret works.
      const mailer = makeMailerMock();
      const { deps } = makeDeps({
        mailer,
        isProduction: false,
        // no publicAppUrl / unsubscribeSecret
      });

      await sendAnnouncement(deps, validInput());

      expect(mailer.sendBatch).toHaveBeenCalledOnce();
      const batchArg = (mailer.sendBatch as Mock).mock.calls[0]![0];
      expect(batchArg[0].headers).toBeUndefined();
    });
  });

  describe("fail-closed: consent filter failure", () => {
    const PUBLIC_URL = "https://ithasfire.com";
    const SECRET = "super-secret-unsubscribe-key-long-enough";

    it("throws, does NOT dispatch, and logs when the consent pref lookup fails", async () => {
      const mailer = makeMailerMock();
      const humanId = randomUUID();
      const { deps, logger } = makeDeps({
        mailer,
        failPrefLookup: true,
        recipients: [
          {
            email: "someone@example.com",
            name: "Someone",
            contactListEntryId: null,
            inviteListId: null,
            humanId,
          },
        ],
        publicAppUrl: PUBLIC_URL,
        unsubscribeSecret: SECRET,
      });

      await expect(
        sendAnnouncement(
          deps,
          validInput({ audienceType: "ALL_TICKET_HOLDERS", audienceRef: undefined }),
        ),
      ).rejects.toMatchObject({
        code: "transient",
        message: expect.stringContaining("recipient consent filter failed"),
      });

      // Fail-closed: no email is sent to anyone when consent can't be verified.
      expect(mailer.sendBatch).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "announcement_recipient_filter_failed",
        expect.objectContaining({ announcementId: ANNOUNCEMENT_ID }),
      );
    });
  });

  // Security review F4 (2026-09-29): owner access was checked, but the
  // audience was trusted as given — so a sender could reach another owner's
  // buyers, waitlist or contact list. Every reference must be the owner's.
  describe("audience ownership (F4)", () => {
    const FOREIGN = {
      extraEvents: [
        { id: FOREIGN_EVENT_ID, orgId: OTHER_ORG_ID, humanId: null },
      ],
      extraLists: [
        {
          id: FOREIGN_LIST_ID,
          ownerType: "ORGANIZATION",
          ownerId: OTHER_ORG_ID,
        },
      ],
      ticketTypes: {
        [EVENT_ID]: [TIER_ID],
        [FOREIGN_EVENT_ID]: [FOREIGN_TIER_ID],
      },
    };

    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "EVENT_TICKET_HOLDERS on another org's event",
        { audienceType: "EVENT_TICKET_HOLDERS", audienceRef: FOREIGN_EVENT_ID, eventId: undefined },
        "EVENT_NOT_FOUND",
      ],
      [
        "WAITLIST_SUBSCRIBERS on another org's event",
        { audienceType: "WAITLIST_SUBSCRIBERS", audienceRef: FOREIGN_EVENT_ID, eventId: undefined },
        "EVENT_NOT_FOUND",
      ],
      [
        "MULTIPLE_EVENTS with one foreign event among own",
        {
          audienceType: "MULTIPLE_EVENTS",
          audienceRef: undefined,
          eventId: undefined,
          audienceFilter: { eventIds: [EVENT_ID, FOREIGN_EVENT_ID] },
        },
        "EVENT_NOT_FOUND",
      ],
      [
        "EVENT_TICKET_TIER on another org's event",
        {
          audienceType: "EVENT_TICKET_TIER",
          audienceRef: undefined,
          eventId: undefined,
          audienceFilter: { eventId: FOREIGN_EVENT_ID, tierIds: [FOREIGN_TIER_ID] },
        },
        "EVENT_NOT_FOUND",
      ],
      [
        "EVENT_TICKET_TIER with a foreign tier on an own event",
        {
          audienceType: "EVENT_TICKET_TIER",
          audienceRef: undefined,
          eventId: undefined,
          audienceFilter: { eventId: EVENT_ID, tierIds: [TIER_ID, FOREIGN_TIER_ID] },
        },
        "TICKET_TYPE_NOT_FOUND",
      ],
      [
        "CONTACT_LIST owned by another org",
        { audienceType: "CONTACT_LIST", audienceRef: FOREIGN_LIST_ID, eventId: undefined },
        "TARGET_LIST_NOT_FOUND",
      ],
      [
        "an excluded contact list owned by another org",
        {
          audienceType: "ALL_TICKET_HOLDERS",
          audienceRef: undefined,
          eventId: undefined,
          excludedContactListId: FOREIGN_LIST_ID,
        },
        "TARGET_LIST_NOT_FOUND",
      ],
      [
        "an attached eventId owned by another org",
        { audienceType: "ALL_TICKET_HOLDERS", audienceRef: undefined, eventId: FOREIGN_EVENT_ID },
        "EVENT_NOT_FOUND",
      ],
      [
        "an event id that does not exist (same answer as foreign)",
        { audienceType: "EVENT_TICKET_HOLDERS", audienceRef: randomUUID(), eventId: undefined },
        "EVENT_NOT_FOUND",
      ],
    ];

    it.each(cases)("refuses %s, before any audience read or write", async (_label, overrides, code) => {
      const { deps, announcementsRepo, mailer, idempotency } = makeDeps(FOREIGN);

      await expect(
        sendAnnouncement(deps, validInput(overrides as never)),
      ).rejects.toMatchObject({ code });

      expect(announcementsRepo.countAudienceRecipients).not.toHaveBeenCalled();
      expect(announcementsRepo.listAudienceRecipientEmails).not.toHaveBeenCalled();
      expect(announcementsRepo.create).not.toHaveBeenCalled();
      expect(mailer!.sendBatch).not.toHaveBeenCalled();
      expect(idempotency.begin).not.toHaveBeenCalled();
    });

    it("refuses a HUMAN owner targeting an org event that carries their humanId", async () => {
      const { deps } = makeDeps({
        extraEvents: [{ id: FOREIGN_EVENT_ID, orgId: OTHER_ORG_ID, humanId: ACTOR_ID }],
      });

      await expect(
        sendAnnouncement(
          deps,
          validInput({
            ownerType: "HUMAN" as never,
            ownerId: ACTOR_ID,
            audienceType: "EVENT_TICKET_HOLDERS",
            audienceRef: FOREIGN_EVENT_ID,
            eventId: undefined,
          }),
        ),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    });

    it("lets a HUMAN owner reach their own personal event", async () => {
      const PERSONAL_EVENT_ID = randomUUID();
      const { deps, announcementsRepo } = makeDeps({
        extraEvents: [{ id: PERSONAL_EVENT_ID, orgId: null, humanId: ACTOR_ID }],
      });

      await sendAnnouncement(
        deps,
        validInput({
          ownerType: "HUMAN" as never,
          ownerId: ACTOR_ID,
          audienceType: "EVENT_TICKET_HOLDERS",
          audienceRef: PERSONAL_EVENT_ID,
          eventId: PERSONAL_EVENT_ID,
        }),
      );

      expect(announcementsRepo.countAudienceRecipients).toHaveBeenCalledWith(
        expect.objectContaining({ ownerType: "HUMAN", orgId: ACTOR_ID }),
      );
    });

    it("sends when every reference belongs to the owner, and scopes the adapter by owner", async () => {
      const { deps, announcementsRepo, mailer } = makeDeps(FOREIGN);

      const result = await sendAnnouncement(
        deps,
        validInput({
          audienceType: "EVENT_TICKET_TIER",
          audienceRef: undefined,
          eventId: EVENT_ID,
          audienceFilter: { eventId: EVENT_ID, tierIds: [TIER_ID] },
          excludedContactListId: LIST_ID,
        } as never),
      );

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(mailer!.sendBatch).toHaveBeenCalled();
      const scope = expect.objectContaining({
        ownerType: "ORGANIZATION",
        orgId: ORG_ID,
      });
      expect(announcementsRepo.countAudienceRecipients).toHaveBeenCalledWith(scope);
      expect(announcementsRepo.listAudienceRecipientEmails).toHaveBeenCalledWith(scope);
    });

    it("sends to an own CONTACT_LIST", async () => {
      const { deps } = makeDeps(FOREIGN);

      const result = await sendAnnouncement(
        deps,
        validInput({
          audienceType: "CONTACT_LIST",
          audienceRef: LIST_ID,
          eventId: undefined,
        }),
      );
      expect(result.id).toBe(ANNOUNCEMENT_ID);
    });

    it("caps MULTIPLE_EVENTS at 500 event ids", async () => {
      const { deps, eventsRepo } = makeDeps();

      await expect(
        sendAnnouncement(
          deps,
          validInput({
            audienceType: "MULTIPLE_EVENTS",
            audienceRef: undefined,
            eventId: undefined,
            audienceFilter: {
              eventIds: Array.from({ length: 501 }, () => randomUUID()),
            },
          } as never),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(eventsRepo.getById).not.toHaveBeenCalled();
    });
  });

  // CLAUDE.md error-reporting convention: swallowed failures go to reportError.
  describe("reportError on swallowed failures", () => {
    it("reports a recipient-fetch failure and still returns the announcement", async () => {
      const { deps, announcementsRepo } = makeDeps();
      const reportError = vi.fn();
      deps.reportError = reportError;
      const boom = new Error("recipient query failed");
      (announcementsRepo.listAudienceRecipientEmails as Mock).mockRejectedValueOnce(boom);

      const result = await sendAnnouncement(deps, validInput());

      expect(result.id).toBe(ANNOUNCEMENT_ID);
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "recipient_fetch" },
        }),
      );
    });

    it("reports a failed batch send", async () => {
      const { deps, mailer } = makeDeps();
      const reportError = vi.fn();
      deps.reportError = reportError;
      (mailer!.sendBatch as Mock).mockRejectedValueOnce(new Error("provider down"));

      await sendAnnouncement(deps, validInput());

      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "provider down" }),
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "batch_send" },
        }),
      );
    });

    it("reports a failed org address fetch (falls back to the platform address)", async () => {
      const { deps } = makeDeps();
      const reportError = vi.fn();
      deps.reportError = reportError;
      const boom = new Error("org read failed");
      (deps.repos.organizations.getById as Mock).mockRejectedValueOnce(boom);

      await sendAnnouncement(deps, validInput());

      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "org_fetch_for_address" },
        }),
      );
    });

    it("reports a failed recipient-count update after filtering", async () => {
      const { deps, announcementsRepo } = makeDeps({
        anonSuppressed: new Set(["alice@example.com"]),
      });
      const reportError = vi.fn();
      deps.reportError = reportError;
      const boom = new Error("count write failed");
      (announcementsRepo.updateRecipientCount as Mock).mockRejectedValueOnce(boom);

      await sendAnnouncement(deps, validInput());

      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "recipient_count_update" },
        }),
      );
    });

    it("reports failed in-app notifies ONCE per send, with counts", async () => {
      const boom = new Error("notify down");
      const humans = Array.from({ length: 5 }, () => randomUUID());
      const notify = vi.fn(async (input: { humanId: string }) => {
        // Every human but the last fails.
        if (input.humanId !== humans[4]) throw boom;
        return { ok: true };
      });
      const { deps, logger } = makeDeps({
        notify: notify as never,
        recipients: humans.map((humanId, i) => ({
          email: `fan${i}@example.com`,
          name: null,
          contactListEntryId: null,
          inviteListId: null,
          humanId,
        })),
      });
      const reportError = vi.fn();
      deps.reportError = reportError;
      const warn = vi.spyOn(logger, "warn");

      await sendAnnouncement(deps, validInput());

      const notifyReports = reportError.mock.calls.filter(
        (c) => (c[1] as { tags: { site: string } }).tags.site === "notify",
      );
      expect(notifyReports).toHaveLength(1);
      expect(notifyReports[0]).toEqual([
        boom,
        expect.objectContaining({
          tags: { useCase: "sendAnnouncement", site: "notify" },
          extra: expect.objectContaining({ failedCount: 4, notifiedCount: 1 }),
        }),
      ]);
      // The per-human log line stays.
      expect(
        warn.mock.calls.filter((c) => c[0] === "announcement_notify_failed"),
      ).toHaveLength(4);
    });

    it("does not report when every notify succeeds", async () => {
      const { deps } = makeDeps({
        notify: vi.fn(async () => ({ ok: true })) as never,
        recipients: [
          {
            email: "fan@example.com",
            name: null,
            contactListEntryId: null,
            inviteListId: null,
            humanId: randomUUID(),
          },
        ],
      });
      const reportError = vi.fn();
      deps.reportError = reportError;

      await sendAnnouncement(deps, validInput());
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a throwing reporter does not change the outcome", async () => {
      const { deps, announcementsRepo } = makeDeps();
      deps.reportError = vi.fn(() => {
        throw new Error("reporter down");
      });
      (announcementsRepo.listAudienceRecipientEmails as Mock).mockRejectedValueOnce(
        new Error("recipient query failed"),
      );

      const result = await sendAnnouncement(deps, validInput());
      expect(result.id).toBe(ANNOUNCEMENT_ID);
    });
  });

  // Review round 2 (F8): every announcements.* path requires a verified email.
  describe("verified-email gate", () => {
    it("refuses an unverified actor before any audience read, write or send", async () => {
      const { deps, announcementsRepo, mailer, idempotency, eventsRepo } =
        makeDeps({ emailVerified: false });

      await expect(sendAnnouncement(deps, validInput())).rejects.toMatchObject({
        code: "forbidden",
        message: "email_verification_required",
      });
      expect(eventsRepo.getById).not.toHaveBeenCalled();
      expect(announcementsRepo.countAudienceRecipients).not.toHaveBeenCalled();
      expect(announcementsRepo.listAudienceRecipientEmails).not.toHaveBeenCalled();
      expect(announcementsRepo.create).not.toHaveBeenCalled();
      expect(mailer!.sendBatch).not.toHaveBeenCalled();
      expect(idempotency.begin).not.toHaveBeenCalled();
    });
  });
});
