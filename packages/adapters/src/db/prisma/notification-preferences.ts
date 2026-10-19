import type { Prisma } from "@prisma/client";

import type {
  NotificationPreferencesRepo,
  NotificationPreferenceDelta,
  NotificationPreferenceScope,
  NotificationPreferenceScopeKind,
  NotificationPreferenceSnapshot,
  NotificationPreferenceChannelSnapshot,
  NotificationPreferenceEmailChannelSnapshot,
  NotificationEmailFrequency,
} from "@th/ports/repos/notification-preferences";

import type { PrismaClientOrTx } from "./types";

// ─── Default preference values ──────────────────────────────────────────────

const DEFAULT_CHANNEL_SNAPSHOT: NotificationPreferenceChannelSnapshot = {
  transactional: true,
  announcements: true,
  // Reminders default ON — the 24h-before RSVP nudge is the message people
  // actually want. Mirrors `reminders.*DefaultEnabled` in
  // packages/core/src/use-cases/comms/categories.ts.
  reminders: true,
  marketing: true,
  organizerMessages: true,
  // "Bills you're on" (lineup v3 FR-012) defaults ON. Mirrors
  // `billsYoureOn.*DefaultEnabled` in comms/categories.ts.
  billsYoureOn: true,
};

const DEFAULT_EMAIL_SNAPSHOT: NotificationPreferenceEmailChannelSnapshot = {
  ...DEFAULT_CHANNEL_SNAPSHOT,
  frequency: "INSTANT",
};

// SMS is strictly opt-in (TCPA): a human with no stored preference row must
// read as SMS-disabled for every category. Mirrors `smsDefaultEnabled: false`
// in packages/core/src/use-cases/comms/categories.ts — keep the two in sync.
const DEFAULT_SMS_SNAPSHOT: NotificationPreferenceChannelSnapshot = {
  transactional: false,
  announcements: false,
  reminders: false,
  marketing: false,
  organizerMessages: false,
  billsYoureOn: false,
};

const DEFAULT_SNAPSHOT: NotificationPreferenceSnapshot = {
  in_app: { ...DEFAULT_CHANNEL_SNAPSHOT },
  email: { ...DEFAULT_EMAIL_SNAPSHOT },
  push: { ...DEFAULT_CHANNEL_SNAPSHOT },
  sms: { ...DEFAULT_SMS_SNAPSHOT },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function scopeToWhere(
  humanId: string,
  scope: NotificationPreferenceScope,
): {
  humanId: string;
  scopeKind: NotificationPreferenceScopeKind;
  orgId: string;
  eventId: string;
} {
  return {
    humanId,
    scopeKind: scope.kind,
    orgId: scope.kind === "ORG" ? scope.orgId : "",
    eventId: scope.kind === "EVENT" ? scope.eventId : "",
  };
}

function applyDelta(
  base: NotificationPreferenceSnapshot,
  delta: NotificationPreferenceDelta,
): NotificationPreferenceSnapshot {
  const result: NotificationPreferenceSnapshot = JSON.parse(
    JSON.stringify(base),
  );

  // Apply category-level overrides (these set all channels for a category)
  if (delta.categories) {
    for (const [cat, val] of Object.entries(delta.categories) as [
      string,
      boolean,
    ][]) {
      if (result.in_app) (result.in_app as any)[cat] = val;
      if (result.email) (result.email as any)[cat] = val;
      if (result.push) (result.push as any)[cat] = val;
      if (result.sms) (result.sms as any)[cat] = val;
    }
  }

  // Apply per-channel overrides
  if (delta.channels) {
    for (const [ch, chDelta] of Object.entries(delta.channels)) {
      if (!chDelta) continue;
      const target = result[ch as keyof NotificationPreferenceSnapshot];
      if (!target) continue;
      for (const [key, val] of Object.entries(chDelta)) {
        if (key === "frequency" && ch === "email") {
          (target as NotificationPreferenceEmailChannelSnapshot).frequency =
            val as NotificationEmailFrequency;
        } else if (typeof val === "boolean") {
          (target as any)[key] = val;
        }
      }
    }
  }

  return result;
}

// ─── Delta merging ──────────────────────────────────────────────────────────

/** Deep-merge a new partial delta into an existing one (both are sparse). */
function mergeDelta(
  base: NotificationPreferenceDelta,
  next: NotificationPreferenceDelta,
): NotificationPreferenceDelta {
  const result: NotificationPreferenceDelta = JSON.parse(JSON.stringify(base));

  if (next.categories) {
    result.categories = { ...result.categories, ...next.categories };
  }

  if (next.channels) {
    if (!result.channels) result.channels = {};
    for (const [ch, chDelta] of Object.entries(next.channels)) {
      if (!chDelta) continue;
      const existing = (result.channels as any)[ch] ?? {};
      (result.channels as any)[ch] = { ...existing, ...chDelta };
    }
  }

  return result;
}

// ─── Repo ───────────────────────────────────────────────────────────────────

export function makeNotificationPreferencesRepo(
  p: PrismaClientOrTx,
): NotificationPreferencesRepo {
  return {
    async upsert(input) {
      const where = scopeToWhere(input.humanId, input.scope);
      const newDelta = input.delta ?? {};

      // Read the existing row so we can merge deltas instead of overwriting.
      const existing = await p.notificationPreference.findUnique({
        where: {
          humanId_scopeKind_orgId_eventId: {
            humanId: where.humanId,
            scopeKind: where.scopeKind,
            orgId: where.orgId,
            eventId: where.eventId,
          },
        },
        select: { delta: true },
      });

      const baseDelta = existing ? parseDelta(existing.delta) : {};
      const merged = mergeDelta(baseDelta, newDelta);

      await p.notificationPreference.upsert({
        where: {
          humanId_scopeKind_orgId_eventId: {
            humanId: where.humanId,
            scopeKind: where.scopeKind,
            orgId: where.orgId,
            eventId: where.eventId,
          },
        },
        create: {
          humanId: where.humanId,
          scopeKind: where.scopeKind,
          orgId: where.orgId,
          eventId: where.eventId,
          delta: merged as unknown as Prisma.InputJsonValue,
        },
        update: {
          delta: merged as unknown as Prisma.InputJsonValue,
        },
      });
    },

    async readEffective(input) {
      const where = scopeToWhere(input.humanId, input.scope);

      const row = await p.notificationPreference.findUnique({
        where: {
          humanId_scopeKind_orgId_eventId: {
            humanId: where.humanId,
            scopeKind: where.scopeKind,
            orgId: where.orgId,
            eventId: where.eventId,
          },
        },
        select: { delta: true },
      });

      if (!row) {
        return JSON.parse(JSON.stringify(DEFAULT_SNAPSHOT));
      }

      const delta = parseDelta(row.delta);
      return applyDelta(DEFAULT_SNAPSHOT, delta);
    },

    async batchReadAnnouncementEmailEnabled(input) {
      const result = new Map<string, boolean>();
      if (input.humanIds.length === 0) return result;

      // Default everyone to enabled; only the rows we read can flip to false.
      for (const id of input.humanIds) result.set(id, true);

      // Single query over the relevant GLOBAL + ORG(orgId) rows.
      //
      // NOTE: EVENT-level opt-in override (which `readEffective` supports via
      // cascade) is intentionally deferred to a future iteration — announcement
      // dispatch only consults GLOBAL and ORG scopes for now.
      const rows = await p.notificationPreference.findMany({
        where: {
          humanId: { in: input.humanIds },
          OR: [
            { scopeKind: "GLOBAL" },
            { scopeKind: "ORG", orgId: input.orgId },
          ],
        },
        select: { humanId: true, delta: true },
      });

      for (const row of rows) {
        const snapshot = applyDelta(DEFAULT_SNAPSHOT, parseDelta(row.delta));
        if (snapshot.email?.announcements === false) {
          result.set(row.humanId, false);
        }
      }

      return result;
    },
  };
}

function parseDelta(raw: Prisma.JsonValue): NotificationPreferenceDelta {
  if (!raw) return {};
  // Handle double-encoded strings left by the previous bug.
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as unknown as NotificationPreferenceDelta;
      }
    } catch {
      // malformed – fall through
    }
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as unknown as NotificationPreferenceDelta;
}
