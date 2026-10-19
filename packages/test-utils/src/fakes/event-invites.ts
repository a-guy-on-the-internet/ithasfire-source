import { randomUUID } from "node:crypto";
import { createInviteWorldPauses } from "./event-invite-pauses";

import { hashInviteOptOutEmail } from "@th/core/lib/security/invite-optout-token";

import type { Repos } from "@th/ports/repos";
import type {
  ApplicationFormPurpose,
  ApplicationSubmissionStatus,
  CreateEventApplicationSubmissionInput,
  CreateEventInviteInput,
  EventApplicationSubmissionRecord,
  EventInviteRecord,
  EventRecord,
  EventWaitlistEntryRecord,
  InviteListEntryRecord,
  InviteListRecord,
  ListApplicationSubmissionsInput,
  UpdateEventApplicationSubmissionStatusInput,
} from "@th/ports/repos/events";
import type {
  CreateEventUnlockInput,
  EventUnlockRecord,
} from "@th/ports/repos/event-unlocks";

/**
 * In-memory world for the gated-event invite use cases
 * (packages/core/src/use-cases/events/invites). One shared state backs
 * events, invites, unlocks, ATTEND submissions, contact lists, the org
 * suppression list and the audit log, and the repos enforce the same
 * uniqueness rules the DB does:
 *  - one live SHARED invite per event (`shared_invite_already_live`);
 *  - one live PERSONAL invite per (event, email) (`personal_invite_already_live`);
 *  - one OPEN (PENDING | APPROVED | WAITLISTED) submission per human / guest
 *    email (`duplicate_open_application`);
 *  - the status CAS on updateSubmissionStatus (`conflict`).
 *
 * `tx(fn)` runs `fn` against the same repos with no rollback: tests assert
 * outcomes, and the use cases' own rollback sentinels are covered by those.
 */

export const INVITE_ORG_ID = "10000000-0000-4000-8000-000000000001";
export const INVITE_EVENT_ID = "20000000-0000-4000-8000-000000000002";
export const INVITE_ORGANIZER_ID = "30000000-0000-4000-8000-000000000003";
export const INVITE_VIEWER_ID = "40000000-0000-4000-8000-000000000004";
export const INVITE_STRANGER_ID = "50000000-0000-4000-8000-000000000005";
export const INVITE_NOW = new Date("2026-10-05T12:00:00.000Z");
export const INVITE_SECRET = "s".repeat(48);
export const INVITE_OPT_OUT_SECRET = "o".repeat(48);
export const INVITE_APP_BASE_URL = "https://ithas.fire";

const OPEN_STATUSES: ApplicationSubmissionStatus[] = [
  "PENDING",
  "APPROVED",
  "WAITLISTED",
];

export function makeInviteEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: INVITE_EVENT_ID,
    orgId: INVITE_ORG_ID,
    humanId: null,
    title: "Basement Show",
    slug: "basement-show",
    status: "PUBLISHED",
    gateType: "PASSWORD",
    visibility: "PUBLIC",
    stewardship: "OWNED",
    passwordHash: "set",
    startsAt: new Date("2026-10-10T02:00:00.000Z"),
    endsAt: new Date("2026-10-10T05:00:00.000Z"),
    timezone: "America/Chicago",
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    ...overrides,
  } as unknown as EventRecord;
}

export type InviteWorld = ReturnType<typeof createInviteWorld>;

export function createInviteWorld(
  opts: { event?: Partial<EventRecord>; now?: Date } = {},
) {
  const now = opts.now ?? INVITE_NOW;
  const events = new Map<string, EventRecord>();
  const event = makeInviteEvent(opts.event);
  events.set(event.id, event);

  const invites: EventInviteRecord[] = [];
  const unlocks = new Map<string, EventUnlockRecord>();
  const submissions: EventApplicationSubmissionRecord[] = [];
  const forms = new Map<
    string,
    { id: string; eventId: string; purpose: ApplicationFormPurpose }
  >();
  const waitlist: EventWaitlistEntryRecord[] = [];
  const memberships = new Map<string, string>([
    [`${INVITE_ORG_ID}:${INVITE_ORGANIZER_ID}`, "ADMIN"],
  ]);
  const verified = new Set<string>([INVITE_ORGANIZER_ID]);
  /** Account email per human (AuthUser.email), for named-guest matching. */
  const accountEmails = new Map<string, string>();
  const lists: InviteListRecord[] = [];
  const entries: InviteListEntryRecord[] = [];
  const suppressed = new Set<string>();
  const audit: Array<{ action: string; data?: unknown }> = [];
  /** Test hooks to inject races. */
  const hooks: {
    beforeRotate?: () => void;
    beforePersonalCreate?: (email: string) => void;
    /** Runs before lockIfLive reads the row (a revoke landing first). */
    beforeLockIfLive?: (id: string) => void;
    /** Runs before lockIfGrantsHold reads the row (a removal landing first). */
    beforeLockIfGrantsHold?: (id: string) => void;
  } = {};
  /**
   * Invite opt-out rows, as `<ORG|HUMAN>:<id>|<hash>` per organiser, or
   * `ALL|<hash>` for "Stop all event invites".
   */
  const optOuts = new Set<string>();
  type OptOutOwner =
    | { kind: "ORG"; orgId: string }
    | { kind: "HUMAN"; humanId: string };
  const optOutHashKey = (owner: OptOutOwner, emailHash: string) =>
    `${owner.kind}:${owner.kind === "ORG" ? owner.orgId : owner.humanId}|${emailHash}`;
  /** Key for an address, hashed the way core hashes it (canonical form). */
  const optOutKey = (owner: OptOutOwner, email: string) =>
    optOutHashKey(owner, hashInviteOptOutEmail(email, INVITE_OPT_OUT_SECRET));
  const optOutAllHashKey = (emailHash: string) => `ALL|${emailHash}`;
  /** Key of the "Stop all event invites" row for an address. */
  const optOutAllKey = (email: string) =>
    optOutAllHashKey(hashInviteOptOutEmail(email, INVITE_OPT_OUT_SECRET));
  /**
   * Track record the allowance reads; flip per test. `scannedHolders` is
   * what `countDistinctDoorScannedHolders` reports (before its cap).
   */
  const trackRecord = { scannedHolders: 0, payout: false, fail: false };
  /**
   * Account creation times, i.e. first sign-in (`humans.getAccountCreatedAt`).
   * A human without an entry was created a year before `now`, so the
   * new-account invite tier stays out of tests that don't ask for it.
   * `fail` makes the lookup throw.
   */
  const accounts = {
    createdAt: new Map<string, Date>(),
    fail: false,
  };

  const unlockKey = (eventId: string, humanId: string) =>
    `${eventId}:${humanId}`;
  const touch = <T extends { updatedAt: Date }>(row: T) => {
    row.updatedAt = now;
    return { ...row };
  };

  const eventInvites = {
    async create(input: CreateEventInviteInput) {
      if (
        input.kind === "SHARED" &&
        invites.some(
          (i) =>
            i.eventId === input.eventId &&
            i.kind === "SHARED" &&
            i.revokedAt === null,
        )
      ) {
        throw { code: "shared_invite_already_live", message: "x" };
      }
      if (input.kind === "PERSONAL") {
        hooks.beforePersonalCreate?.(input.inviteeEmail);
        const email = input.inviteeEmail.trim().toLowerCase();
        if (
          invites.some(
            (i) =>
              i.eventId === input.eventId &&
              i.kind === "PERSONAL" &&
              i.revokedAt === null &&
              i.inviteeEmail === email,
          )
        ) {
          throw { code: "personal_invite_already_live", message: "x" };
        }
      }
      const row: EventInviteRecord = {
        id: input.id ?? randomUUID(),
        eventId: input.eventId,
        kind: input.kind,
        inviteeName: input.kind === "PERSONAL" ? input.inviteeName : null,
        inviteeEmail:
          input.kind === "PERSONAL"
            ? input.inviteeEmail.trim().toLowerCase()
            : null,
        tokenHash: input.tokenHash,
        createdByHumanId: input.createdByHumanId,
        inviteListEntryId:
          input.kind === "PERSONAL" ? (input.inviteListEntryId ?? null) : null,
        metadata: input.metadata ?? {},
        revokedAt: null,
        firstRedeemedAt: null,
        redemptionCount: 0,
        sentAt: input.kind === "PERSONAL" ? (input.sentAt ?? null) : null,
        grantsRevokedAt: null,
        // Strictly increasing so "newest first" is deterministic.
        createdAt: new Date(now.getTime() + invites.length),
        updatedAt: now,
      };
      invites.push(row);
      return { ...row };
    },
    async getById(id: string) {
      const row = invites.find((i) => i.id === id);
      return row ? { ...row } : null;
    },
    async getByTokenHash(tokenHash: string) {
      const row = invites.find((i) => i.tokenHash === tokenHash);
      return row ? { ...row } : null;
    },
    async getLiveShared(eventId: string) {
      const row = invites.find(
        (i) => i.eventId === eventId && i.kind === "SHARED" && !i.revokedAt,
      );
      return row ? { ...row } : null;
    },
    async listByEvent(eventId: string) {
      return invites
        .filter((i) => i.eventId === eventId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((i) => ({ ...i }));
    },
    async findLivePersonalByEmail(eventId: string, email: string) {
      const row = invites.find(
        (i) =>
          i.eventId === eventId &&
          i.kind === "PERSONAL" &&
          !i.revokedAt &&
          i.inviteeEmail === email.trim().toLowerCase(),
      );
      return row ? { ...row } : null;
    },
    async revoke(id: string, at: Date) {
      const row = invites.find((i) => i.id === id);
      if (!row) return null;
      if (!row.revokedAt) row.revokedAt = at;
      return touch(row);
    },
    async recordRedemption(id: string, at: Date) {
      const row = invites.find((i) => i.id === id);
      if (!row) return null;
      row.firstRedeemedAt ??= at;
      row.redemptionCount += 1;
      return touch(row);
    },
    async lockIfLive(id: string) {
      hooks.beforeLockIfLive?.(id);
      const row = invites.find((i) => i.id === id);
      return !!row && row.revokedAt === null;
    },
    async lockIfGrantsHold(id: string) {
      hooks.beforeLockIfGrantsHold?.(id);
      const row = invites.find((i) => i.id === id);
      return !!row && row.grantsRevokedAt === null;
    },
    async revokeSharedGrants(
      eventId: string,
      at: Date,
      opts?: { exceptInviteId?: string },
    ) {
      const rows = invites.filter(
        (i) =>
          i.eventId === eventId &&
          i.kind === "SHARED" &&
          i.id !== opts?.exceptInviteId,
      );
      for (const row of rows) row.grantsRevokedAt ??= at;
      return rows.map((r) => r.id);
    },
    async rotateShared(
      eventId: string,
      next: { id?: string; tokenHash: string; createdByHumanId: string },
      at: Date,
    ) {
      hooks.beforeRotate?.();
      const live = invites.find(
        (i) => i.eventId === eventId && i.kind === "SHARED" && !i.revokedAt,
      );
      let revoked: EventInviteRecord | null = null;
      if (live) {
        live.revokedAt = at;
        revoked = { ...live };
      }
      const created = await eventInvites.create({
        ...next,
        eventId,
        kind: "SHARED",
      });
      return { revoked, created };
    },
    async markSent(id: string, at: Date) {
      const row = invites.find((i) => i.id === id);
      if (!row) return null;
      row.sentAt = at;
      return touch(row);
    },
  };

  const eventUnlocks = {
    async upsert(input: CreateEventUnlockInput) {
      const key = unlockKey(input.eventId, input.humanId);
      const prev = unlocks.get(key);
      const row: EventUnlockRecord = {
        id: prev?.id ?? randomUUID(),
        eventId: input.eventId,
        humanId: input.humanId,
        source: input.source,
        applicationSubmissionId: input.applicationSubmissionId ?? null,
        inviteId: input.inviteId ?? null,
        metadata: input.metadata ?? {},
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      unlocks.set(key, row);
      return { ...row };
    },
    async get(eventId: string, humanId: string) {
      const row = unlocks.get(unlockKey(eventId, humanId));
      return row ? { ...row } : null;
    },
    async isUnlocked(eventId: string, humanId: string) {
      const row = unlocks.get(unlockKey(eventId, humanId));
      return Boolean(row && !row.revokedAt);
    },
    async revoke(eventId: string, humanId: string) {
      const row = unlocks.get(unlockKey(eventId, humanId));
      if (!row) return null;
      row.revokedAt ??= now;
      return { ...row };
    },
    async revokeBySubmission(submissionId: string) {
      let n = 0;
      for (const row of unlocks.values()) {
        if (row.applicationSubmissionId === submissionId && !row.revokedAt) {
          row.revokedAt = now;
          n += 1;
        }
      }
      return n;
    },
    async revokeByInvite(inviteId: string, at: Date) {
      let n = 0;
      for (const row of unlocks.values()) {
        if (row.inviteId === inviteId && !row.revokedAt) {
          row.revokedAt = at;
          n += 1;
        }
      }
      return n;
    },
    async repointInvite(input: {
      eventId: string;
      humanId: string;
      fromInviteIds: ReadonlyArray<string>;
      toInviteId: string;
    }) {
      const row = unlocks.get(unlockKey(input.eventId, input.humanId));
      if (
        !row ||
        row.revokedAt ||
        !row.inviteId ||
        !input.fromInviteIds.includes(row.inviteId)
      ) {
        return false;
      }
      row.inviteId = input.toInviteId;
      return true;
    },
    async listByEventId(eventId: string) {
      return [...unlocks.values()].filter((u) => u.eventId === eventId);
    },
    async listByHumanId(humanId: string) {
      return [...unlocks.values()].filter((u) => u.humanId === humanId);
    },
  };

  const formKey = (eventId: string, purpose: string) => `${eventId}:${purpose}`;
  const formById = (formId: string) =>
    [...forms.values()].find((f) => f.id === formId) ?? null;
  const ensureFormRow = (eventId: string, purpose: ApplicationFormPurpose) => {
    const key = formKey(eventId, purpose);
    let form = forms.get(key);
    if (!form) {
      form = { id: randomUUID(), eventId, purpose };
      forms.set(key, form);
    }
    return form;
  };
  /** Guest emails compare lowercased, like the lower(contactEmail) index. */
  const sameGuest = (a: string | null, b: string | null | undefined) =>
    a !== null && b != null && a.toLowerCase() === b.toLowerCase();

  // One OPEN application per human / guest email per FORM (open calls v1
  // re-keyed the partial unique indexes eventId -> formId).
  const isOpenDuplicate = (
    candidate: Pick<
      EventApplicationSubmissionRecord,
      "id" | "formId" | "humanId" | "contactEmail"
    >,
  ) =>
    submissions.some(
      (s) =>
        s.id !== candidate.id &&
        s.formId === candidate.formId &&
        OPEN_STATUSES.includes(s.status) &&
        (candidate.humanId
          ? s.humanId === candidate.humanId
          : !s.humanId && sameGuest(s.contactEmail, candidate.contactEmail)),
    );

  const eventApplications = {
    async ensureForm(input: { eventId: string; purpose: ApplicationFormPurpose }) {
      return { ...ensureFormRow(input.eventId, input.purpose) };
    },
    async getForm(eventId: string, purpose: ApplicationFormPurpose) {
      const form = forms.get(formKey(eventId, purpose));
      return form ? { ...form } : null;
    },
    async findOpenSubmission(input: {
      formId: string;
      humanId?: string;
      contactEmail?: string;
    }) {
      const row = submissions.find(
        (s) =>
          s.formId === input.formId &&
          OPEN_STATUSES.includes(s.status) &&
          (input.humanId
            ? s.humanId === input.humanId
            : !s.humanId && sameGuest(s.contactEmail, input.contactEmail)),
      );
      return row ? { ...row } : null;
    },
    async createSubmission(input: CreateEventApplicationSubmissionInput) {
      const form = formById(input.formId);
      if (!form || form.eventId !== input.eventId) {
        throw new Error("form_event_mismatch");
      }
      const row: EventApplicationSubmissionRecord = {
        id: randomUUID(),
        formId: form.id,
        purpose: form.purpose,
        eventId: input.eventId,
        humanId: input.humanId ?? null,
        contactEmail: input.contactEmail?.toLowerCase() ?? null,
        contactPhone: input.contactPhone ?? null,
        status: "PENDING",
        answers: input.answers,
        decisionReason: null,
        questionsSnapshot: input.questionsSnapshot ?? {},
        reviewerHumanId: null,
        reviewedAt: null,
        approvalToken: null,
        tokenExpiresAt: null,
        inviteId: input.inviteId ?? null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      } as EventApplicationSubmissionRecord;
      if (isOpenDuplicate(row)) {
        throw { code: "duplicate_open_application", message: "x" };
      }
      submissions.push(row);
      return { ...row };
    },
    async updateSubmissionStatus(
      input: UpdateEventApplicationSubmissionStatusInput,
    ) {
      const row = submissions.find((s) => s.id === input.submissionId);
      if (!row) throw new Error("submission_not_found");
      if (
        (input.expectedFromStatuses &&
          !input.expectedFromStatuses.includes(row.status)) ||
        (Object.prototype.hasOwnProperty.call(input, "expectedInviteId") &&
          row.inviteId !== (input.expectedInviteId ?? null))
      ) {
        throw { code: "conflict", message: "conflict" };
      }
      if (
        OPEN_STATUSES.includes(input.status) &&
        !OPEN_STATUSES.includes(row.status) &&
        isOpenDuplicate(row)
      ) {
        throw { code: "duplicate_open_application", message: "x" };
      }
      row.status = input.status;
      const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
      if (has("reviewerHumanId")) row.reviewerHumanId = input.reviewerHumanId ?? null;
      if (has("reviewedAt")) row.reviewedAt = input.reviewedAt ?? null;
      if (has("approvalToken")) row.approvalToken = input.approvalToken ?? null;
      if (has("tokenExpiresAt")) row.tokenExpiresAt = input.tokenExpiresAt ?? null;
      if (has("decisionReason")) row.decisionReason = input.decisionReason ?? null;
      if (has("inviteId")) row.inviteId = input.inviteId ?? null;
      return touch(row);
    },
    async getSubmissionById(id: string) {
      const row = submissions.find((s) => s.id === id);
      return row ? { ...row } : null;
    },
    async lockApprovedSubmission(input: {
      submissionId: string;
      eventId: string;
      purpose: ApplicationFormPurpose;
      reviewedAt: Date;
    }) {
      const row = submissions.find((s) => s.id === input.submissionId);
      return Boolean(
        row &&
          row.eventId === input.eventId &&
          row.purpose === input.purpose &&
          row.status === "APPROVED" &&
          row.reviewedAt?.getTime() === input.reviewedAt.getTime(),
      );
    },
    async listSubmissions(input: ListApplicationSubmissionsInput) {
      const items = submissions
        .filter(
          (s) =>
            s.eventId === input.eventId &&
            s.purpose === input.purpose &&
            (!input.statuses?.length || input.statuses.includes(s.status)) &&
            (!input.inviteId || s.inviteId === input.inviteId),
        )
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50))
        .map((s) => ({ ...s }));
      return {
        items,
        pageInfo: { total: items.length, limit: input.limit ?? 50, offset: 0 },
      };
    },
  };

  const eventWaitlists = {
    async findEntry(input: {
      eventId: string;
      humanId?: string;
      contactEmail?: string;
      contactPhone?: string;
    }) {
      const row = waitlist.find(
        (w) =>
          w.eventId === input.eventId &&
          (input.humanId
            ? w.humanId === input.humanId
            : input.contactEmail
              ? sameGuest(w.contactEmail, input.contactEmail)
              : w.contactPhone === input.contactPhone),
      );
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },
    async updateEntry(input: {
      entryId: string;
      status?: EventWaitlistEntryRecord["status"];
      metadata?: Record<string, unknown>;
      updatedAt?: Date;
    }) {
      const row = waitlist.find((w) => w.id === input.entryId);
      if (!row) throw new Error("waitlist_entry_not_found");
      if (input.status) row.status = input.status;
      if (input.metadata) row.metadata = input.metadata;
      row.updatedAt = input.updatedAt ?? now;
      return { ...row };
    },
  };

  const pauses = createInviteWorldPauses(invites, events);

  const repos = {
    events: {
      async getById(id: string) {
        const row = events.get(id);
        return row ? { ...row } : null;
      },
    },
    authz: {
      async getOrgMembership(input: { orgId: string; humanId: string }) {
        const role = memberships.get(`${input.orgId}:${input.humanId}`);
        return role ? { role } : null;
      },
      async getHumanDelegation() {
        return null;
      },
    },
    humans: {
      async getById(id: string) {
        return { id, name: id === INVITE_ORGANIZER_ID ? "Org Person" : null };
      },
      async getAccountCreatedAt(id: string) {
        if (accounts.fail) throw new Error("account lookup down");
        return (
          accounts.createdAt.get(id) ??
          new Date(now.getTime() - 365 * 86_400_000)
        );
      },
      async getByIdWithIdentity(id: string) {
        return {
          human: { id },
          identity: {
            email: accountEmails.get(id) ?? null,
            emailVerified: verified.has(id),
          },
        };
      },
      async batchLookupHumanIdsByEmail(emails: string[]) {
        const out = new Map<string, string>();
        for (const [humanId, email] of accountEmails) {
          if (emails.includes(email)) out.set(email, humanId);
        }
        return out;
      },
    },
    organizations: {
      async getById(id: string) {
        return id === INVITE_ORG_ID ? { id, name: "Stub Collective" } : null;
      },
    },
    eventInvites,
    eventInvitePauses: pauses.repo,
    eventInviteOptOuts: {
      async add(input: { owner: OptOutOwner; emailHash: string }) {
        const key = optOutHashKey(input.owner, input.emailHash);
        const created = !optOuts.has(key);
        optOuts.add(key);
        return { created };
      },
      async addForAllOrganisers(input: { emailHash: string }) {
        const key = optOutAllHashKey(input.emailHash);
        const created = !optOuts.has(key);
        optOuts.add(key);
        return { created };
      },
      async standing(input: { owner: OptOutOwner; emailHash: string }) {
        if (optOuts.has(optOutAllHashKey(input.emailHash))) return "ALL";
        if (optOuts.has(optOutHashKey(input.owner, input.emailHash))) {
          return "ORGANISER";
        }
        return null;
      },
      async listOptedOut(input: {
        owner: OptOutOwner | null;
        emailHashes: ReadonlyArray<string>;
      }) {
        const owner = input.owner;
        return new Set(
          input.emailHashes.filter(
            (h) =>
              optOuts.has(optOutAllHashKey(h)) ||
              (owner !== null && optOuts.has(optOutHashKey(owner, h))),
          ),
        );
      },
    },
    tickets: {
      async countDistinctDoorScannedHolders(input: { cap: number }) {
        if (trackRecord.fail) throw new Error("scan lookup down");
        return Math.min(trackRecord.scannedHolders, input.cap);
      },
    },
    payoutItems: {
      async subjectHasTransferredPayout() {
        if (trackRecord.fail) throw new Error("payout lookup down");
        return trackRecord.payout;
      },
    },
    eventUnlocks,
    eventApplications,
    eventWaitlists,
    inviteLists: {
      async getListById(id: string) {
        return lists.find((l) => l.id === id) ?? null;
      },
      async listEntries(input: {
        inviteListId: string;
        limit?: number;
        offset?: number;
      }) {
        const all = entries.filter((e) => e.inviteListId === input.inviteListId);
        const offset = input.offset ?? 0;
        return all.slice(offset, offset + (input.limit ?? 50));
      },
    },
    announcements: {
      async getAnonymousSuppressedEmails(input: { emails: string[] }) {
        return new Set(
          input.emails
            .map((e) => e.toLowerCase())
            .filter((e) => suppressed.has(e)),
        );
      },
    },
    audit: {
      async log(entry: { action: string; data?: unknown }) {
        audit.push(entry);
      },
    },
    async tx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(repos);
    },
  };

  const addList = (
    ownerId: string = INVITE_ORG_ID,
    rows: Array<Partial<InviteListEntryRecord>> = [],
  ) => {
    const list = {
      id: randomUUID(),
      ownerType: "ORGANIZATION",
      ownerId,
      name: "Regulars",
      description: null,
      passwordHint: null,
      contactCount: rows.length,
      lastImportAt: null,
      createdAt: now,
      updatedAt: now,
    } as InviteListRecord;
    lists.push(list);
    for (const r of rows) {
      entries.push({
        id: randomUUID(),
        inviteListId: list.id,
        humanId: null,
        contactEmail: null,
        contactPhone: null,
        displayName: null,
        notes: null,
        tags: [],
        lastInvitedAt: null,
        metadata: {},
        importId: null,
        consentSource: null,
        consentRecordedAt: null,
        unsubscribedAt: null,
        createdAt: now,
        updatedAt: now,
        ...r,
      } as InviteListEntryRecord);
    }
    return list;
  };

  return {
    now,
    event: events.get(event.id) as EventRecord,
    events,
    invites,
    unlocks,
    submissions,
    waitlist,
    /** The event's form of `purpose` (created on first use), for seeding. */
    formFor: (purpose: ApplicationFormPurpose) =>
      ensureFormRow(event.id, purpose),
    memberships,
    verified,
    accountEmails,
    suppressed,
    optOuts,
    optOutKey,
    optOutAllKey,
    pauses,
    trackRecord,
    accounts,
    audit,
    hooks,
    addList,
    repos: repos as unknown as Repos,
    clock: { now: () => now },
  };
}
