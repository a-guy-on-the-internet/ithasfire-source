import { randomUUID } from "node:crypto";

import type {
  EventInvitePauseListItem,
  EventInvitePauseOwner,
  EventInvitePauseRecord,
  EventInvitePausesRepo,
} from "@th/ports/repos/event-invite-pauses";

/**
 * In-memory EventInvitePausesRepo (invite complaint auto-pause, W4) with the
 * adapter's semantics: complaints unique on providerEventId, at most one
 * open pause per owner, conditional review/decision updates.
 *
 * Recipient counts come from `state.recipients` unless a `countRecipients`
 * callback is given (the invite world wires its own invites in).
 */
export function createFakeEventInvitePauses(
  opts: {
    countRecipients?: (owner: EventInvitePauseOwner, since: Date) => number;
    ownerNames?: Map<string, string>;
  } = {},
) {
  const complaints: Array<{
    providerEventId: string;
    owner: EventInvitePauseOwner;
    eventId: string | null;
    emailHash: string;
    sentAt: Date | null;
    occurredAt: Date;
  }> = [];
  const pauses: EventInvitePauseRecord[] = [];
  const state = {
    /** Used when no `countRecipients` callback is given. */
    recipients: 0,
    /** Make getOpenPause throw (send-time lookup outage). */
    failGetOpen: false,
    /**
     * Make recordComplaint throw this (DB outage, or a constraint error
     * shaped like Prisma's). Null = no failure.
     */
    failRecord: null as unknown,
    /** Owner keys locked, in order. */
    locks: [] as string[],
  };

  const key = (owner: EventInvitePauseOwner) =>
    owner.kind === "ORG" ? `ORG:${owner.orgId}` : `HUMAN:${owner.humanId}`;
  const same = (a: EventInvitePauseOwner, b: EventInvitePauseOwner) =>
    key(a) === key(b);
  const copy = (p: EventInvitePauseRecord): EventInvitePauseRecord => ({
    ...p,
    owner: { ...p.owner },
  });

  const repo: EventInvitePausesRepo = {
    async lockOwner(owner) {
      state.locks.push(key(owner));
    },
    async recordComplaint(input) {
      if (state.failRecord) throw state.failRecord;
      if (complaints.some((c) => c.providerEventId === input.providerEventId)) {
        return { created: false };
      }
      complaints.push({ ...input });
      return { created: true };
    },
    async countDistinctComplainants({ owner, since }) {
      // Counted by the send the complaint is about (sentAt), else its own time.
      return new Set(
        complaints
          .filter(
            (c) => same(c.owner, owner) && (c.sentAt ?? c.occurredAt) >= since,
          )
          .map((c) => c.emailHash),
      ).size;
    },
    async countInviteRecipients({ owner, since }) {
      return opts.countRecipients
        ? opts.countRecipients(owner, since)
        : state.recipients;
    },
    async getOpenPause(owner) {
      if (state.failGetOpen) throw new Error("pause lookup down");
      const open = pauses.find((p) => same(p.owner, owner) && !p.liftedAt);
      return open ? copy(open) : null;
    },
    async getLatestPause(owner) {
      const mine = pauses
        .filter((p) => same(p.owner, owner))
        .sort(
          (a, b) =>
            b.pausedAt.getTime() - a.pausedAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      return mine[0] ? copy(mine[0]) : null;
    },
    async getLastLiftedAt(owner) {
      const lifts = pauses
        .filter((p) => same(p.owner, owner) && p.liftedAt)
        .map((p) => p.liftedAt!.getTime());
      return lifts.length > 0 ? new Date(Math.max(...lifts)) : null;
    },
    async getLatestComplaintEventId(owner) {
      const latest = complaints
        .filter((c) => same(c.owner, owner) && c.eventId)
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
      return latest?.eventId ?? null;
    },
    async openPause(input) {
      if (pauses.some((p) => same(p.owner, input.owner) && !p.liftedAt)) {
        throw Object.assign(new Error("invite_pause_already_open"), {
          code: "invite_pause_already_open",
        });
      }
      const row: EventInvitePauseRecord = {
        id: randomUUID(),
        owner: { ...input.owner },
        reason: input.reason,
        complaintCount: input.complaintCount,
        recipientCount: input.recipientCount,
        pausedAt: input.pausedAt,
        reviewRequestedAt: null,
        reviewRequestNote: null,
        decision: null,
        decidedAt: null,
        decidedByHumanId: null,
        decisionNote: null,
        liftedAt: null,
      };
      pauses.push(row);
      return copy(row);
    },
    async getById(id) {
      const row = pauses.find((p) => p.id === id);
      return row ? copy(row) : null;
    },
    async requestReview({ id, note, at }) {
      const row = pauses.find((p) => p.id === id);
      if (!row || row.liftedAt || row.reviewRequestedAt) return null;
      row.reviewRequestedAt = at;
      row.reviewRequestNote = note;
      return copy(row);
    },
    async decide({ id, decision, note, decidedByHumanId, at }) {
      const row = pauses.find((p) => p.id === id);
      if (!row || row.liftedAt) return null;
      row.decision = decision;
      row.decidedAt = at;
      row.decidedByHumanId = decidedByHumanId;
      row.decisionNote = note;
      if (decision === "LIFTED") {
        row.liftedAt = at;
      } else {
        row.reviewRequestedAt = null;
        row.reviewRequestNote = null;
      }
      return copy(row);
    },
    async list({ status, limit, offset }) {
      const rows = pauses.filter((p) =>
        status === "AWAITING_REVIEW"
          ? !p.liftedAt && p.reviewRequestedAt
          : status === "OPEN"
            ? !p.liftedAt
            : Boolean(p.liftedAt),
      );
      // The adapter's order (ties by id).
      const t = (d: Date | null) => d?.getTime() ?? 0;
      const byId = (a: EventInvitePauseRecord, b: EventInvitePauseRecord) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      rows.sort((a, b) =>
        status === "AWAITING_REVIEW"
          ? t(a.reviewRequestedAt) - t(b.reviewRequestedAt) || byId(a, b)
          : status === "OPEN"
            ? t(a.pausedAt) - t(b.pausedAt) || byId(a, b)
            : t(b.liftedAt) - t(a.liftedAt) || byId(b, a),
      );
      return rows.slice(offset, offset + limit).map(
        (p): EventInvitePauseListItem => ({
          ...copy(p),
          ownerName: opts.ownerNames?.get(key(p.owner)) ?? null,
        }),
      );
    },
  };

  /** Seed a pause directly (tests of status / review / decide). */
  const seedPause = (
    owner: EventInvitePauseOwner,
    patch: Partial<EventInvitePauseRecord> = {},
  ): EventInvitePauseRecord => {
    const row: EventInvitePauseRecord = {
      id: randomUUID(),
      owner,
      reason: "COMPLAINT_COUNT",
      complaintCount: 3,
      recipientCount: 400,
      pausedAt: new Date("2026-10-01T12:00:00.000Z"),
      reviewRequestedAt: null,
      reviewRequestNote: null,
      decision: null,
      decidedAt: null,
      decidedByHumanId: null,
      decisionNote: null,
      liftedAt: null,
      ...patch,
    };
    pauses.push(row);
    return row;
  };

  return { repo, complaints, pauses, state, seedPause };
}

/**
 * The pause fake for the invite test world: recipients = DISTINCT addresses
 * of the world's PERSONAL invites of the owner's events whose (last) send is
 * at or after the cutoff (an org-owned event belongs to the org).
 */
export function createInviteWorldPauses(
  invites: ReadonlyArray<{
    eventId: string;
    kind: string;
    inviteeEmail: string | null;
    sentAt: Date | null;
  }>,
  events: ReadonlyMap<string, { orgId: string | null; humanId: string | null }>,
) {
  return createFakeEventInvitePauses({
    countRecipients: (owner, since) =>
      new Set(
        invites
          .filter((i) => {
            const ev = events.get(i.eventId);
            if (!ev || i.kind !== "PERSONAL" || !i.sentAt || i.sentAt < since) {
              return false;
            }
            return owner.kind === "ORG"
              ? ev.orgId === owner.orgId
              : !ev.orgId && ev.humanId === owner.humanId;
          })
          .map((i) => (i.inviteeEmail ?? "").toLowerCase()),
      ).size,
  });
}

export type FakeEventInvitePauses = ReturnType<typeof createFakeEventInvitePauses>;
