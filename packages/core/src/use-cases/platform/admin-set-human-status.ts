import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import { humanStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { canonicalEmail } from "../../lib/event-edit-rights";
import {
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
  NETWORK_SIGHTING_RETENTION_MS,
} from "../../lib/security/network-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const mutableStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "BANNED"]);

export const adminSetHumanStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    humanId: z.string().uuid(),
    status: mutableStatusSchema,
    reason: plainTextMultilineOptional(500).optional(),
  })
  .strict();

export const adminSetHumanStatusOutputSchema = z
  .object({
    humanId: z.string().uuid(),
    status: humanStatusSchema,
    sessionsInvalidated: z.number().int(),
    apiKeysRevoked: z.number().int(),
    /** BannedIdentity rows written (BANNED only): email + recent networks. */
    bannedIdentitiesRecorded: z.number().int(),
    /** BannedIdentity rows removed (any move off BANNED, and re-bans). */
    bannedIdentitiesRemoved: z.number().int(),
  })
  .strict();

export type AdminSetHumanStatusInput = z.infer<
  typeof adminSetHumanStatusInputSchema
>;
export type AdminSetHumanStatusOutput = z.infer<
  typeof adminSetHumanStatusOutputSchema
>;

export type AdminSetHumanStatusDeps = {
  repos: Pick<
    Repos,
    "humans" | "apiKeys" | "audit" | "bans" | "networkSightings" | "tx"
  >;
  authz: AuthZPort;
  clock: ClockPort;
  /**
   * Root secret (BETTER_AUTH_SECRET) the banned-identity hashes are keyed
   * from (`lib/security/network-identity.ts`). Missing → the ban still
   * applies, but no identity rows are written; that is reported.
   */
  identitySecret: string | null | undefined;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * The identity rows a ban records (ban-that-sticks, 2026-09-29): the hash of
 * the human's canonical email (no expiry — blocks sign-up and email changes)
 * and the hash of every network prefix they signed in from in the last 30
 * days (expires 30 days from now — only FLAGS same-network sign-ups).
 */
async function buildBannedIdentityRows(
  tx: Pick<TxRepos, "networkSightings">,
  input: {
    humanId: string;
    email: string | null;
    secret: string;
    now: Date;
  },
): Promise<
  Array<{
    kind: "EMAIL" | "NETWORK";
    valueHash: string;
    expiresAt: Date | null;
  }>
> {
  const hasher = createNetworkIdentityHasher(input.secret);
  const rows: Array<{
    kind: "EMAIL" | "NETWORK";
    valueHash: string;
    expiresAt: Date | null;
  }> = [];
  const emailHash = hasher.hashEmail(input.email);
  if (emailHash) {
    rows.push({ kind: "EMAIL", valueHash: emailHash, expiresAt: null });
  }
  const networkHashes = await tx.networkSightings.listNetworkHashesForHuman({
    humanId: input.humanId,
    since: new Date(input.now.getTime() - NETWORK_SIGHTING_RETENTION_MS),
  });
  const networkExpiresAt = new Date(
    input.now.getTime() + NETWORK_SIGHTING_RETENTION_MS,
  );
  for (const valueHash of new Set(networkHashes)) {
    rows.push({ kind: "NETWORK", valueHash, expiresAt: networkExpiresAt });
  }
  return rows;
}

/**
 * Statuses that carry the email / network block (owner ruling 2026-09-29):
 * BANNED and SUSPENDED. Only ACTIVE lifts it.
 */
export function isIdentityBlockingStatus(
  status: "ACTIVE" | "SUSPENDED" | "BANNED",
): boolean {
  return status === "BANNED" || status === "SUSPENDED";
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function adminSetHumanStatus(
  deps: AdminSetHumanStatusDeps,
  rawInput: unknown,
): Promise<AdminSetHumanStatusOutput> {
  const logger = deps.logger?.child({ useCase: "adminSetHumanStatus" });

  const execute = async () => {
    const input = parseInput(adminSetHumanStatusInputSchema, rawInput);

    // RBAC: ADMIN only
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Prevent self-suspension/ban
    if (input.actorHumanId === input.humanId) {
      throw fail("CANNOT_CHANGE_OWN_STATUS");
    }

    // Verify target exists
    const target = await deps.repos.humans.getByIdWithIdentity(input.humanId);
    if (!target) {
      throw fail("HUMAN_NOT_FOUND");
    }

    // Wrap mutation + audit in a single transaction
    const result = await deps.repos.tx(async (tx) => {
      // Update status
      await tx.humans.update(input.humanId, { status: input.status });

      // Suspending or banning ends every credential the human holds:
      // sessions AND API keys. API keys are long-lived bearer credentials, so
      // leaving them live let a banned human keep calling the API. Revoked
      // keys stay revoked on reactivation (the human mints new ones).
      let sessionsInvalidated = 0;
      let apiKeysRevoked = 0;
      // Key requests closed for account security (R31): pending and
      // approved-but-uncollected requests, so none can be approved or
      // collected after the ban.
      let apiKeyRequestsClosed = 0;
      if (input.status === "SUSPENDED" || input.status === "BANNED") {
        const sessionResult = await tx.humans.invalidateAllSessions(
          input.humanId,
        );
        sessionsInvalidated = sessionResult.count;
        const keyResult = await tx.apiKeys.revokeAllForHuman({
          humanId: input.humanId,
        });
        apiKeysRevoked = keyResult.count;
        apiKeyRequestsClosed = keyResult.closedRequestCount;
      }

      // Banned identities (the email / network block) exist while the human
      // is BANNED or SUSPENDED (owner ruling 2026-09-29), written in the same
      // tx as the status change, so a rolled-back change leaves no rows. Each
      // move to either status UPSERTS: existing rows are kept and a network
      // row keeps its later expiry, so BANNED↔SUSPENDED and re-bans never lose
      // coverage. Only reactivation (ACTIVE) removes them. Content hiding is a
      // separate, BANNED-only rule (banned-owner.ts in the adapters).
      const blocksIdentity = isIdentityBlockingStatus(input.status);
      const removed = blocksIdentity
        ? { count: 0 }
        : await tx.bans.removeForHuman(input.humanId);
      let bannedIdentitiesRecorded = 0;
      if (blocksIdentity) {
        if (isUsableNetworkIdentitySecret(deps.identitySecret)) {
          const rows = await buildBannedIdentityRows(tx, {
            humanId: input.humanId,
            email: target.identity?.email ?? null,
            secret: deps.identitySecret,
            now: deps.clock.now(),
          });
          if (rows.length > 0) {
            const recorded = await tx.bans.recordForHuman({
              humanId: input.humanId,
              rows,
            });
            bannedIdentitiesRecorded = recorded.count;
          }
        } else {
          // Deliberate degrade: the ban (status, sessions, keys) still
          // applies; only the sign-up block is missing. Loud, not silent.
          const err = new Error("banned_identity_secret_missing");
          logger?.error("admin.setHumanStatus.identity_secret_missing", {
            humanId: input.humanId,
            err,
          });
          try {
            deps.reportError?.(err, {
              tags: { useCase: "adminSetHumanStatus", op: "record_identity" },
              extra: { humanId: input.humanId },
            });
          } catch {
            // A throwing reporter never changes behaviour.
          }
        }
      }
      const bannedIdentitiesRemoved = removed.count;

      // Alt accounts on the banned mailbox (review round 2): every OTHER
      // AuthUser whose email delivers to the same inbox (case, +tag, Gmail
      // dots) is signed out and loses its API keys, in this same tx. They are
      // not banned themselves; the session gate refuses their next sign-in
      // because the mailbox is banned.
      let altAccountsSignedOut = 0;
      let altSessionsInvalidated = 0;
      let altApiKeysRevoked = 0;
      let altApiKeyRequestsClosed = 0;
      const mailbox = blocksIdentity
        ? canonicalEmail(target.identity?.email)
        : null;
      if (mailbox) {
        const alts = (
          await tx.humans.listAuthUsersByCanonicalEmail(mailbox)
        ).filter(
          (a) =>
            a.authUserId !== target.identity?.authUserId &&
            a.humanId !== input.humanId,
        );
        altAccountsSignedOut = alts.length;
        if (alts.length > 0) {
          altSessionsInvalidated = (
            await tx.humans.invalidateSessionsForAuthUsers(
              alts.map((a) => a.authUserId),
            )
          ).count;
          const altHumanIds = [
            ...new Set(
              alts
                .map((a) => a.humanId)
                .filter((id): id is string => id !== null),
            ),
          ];
          for (const humanId of altHumanIds) {
            const altKeys = await tx.apiKeys.revokeAllForHuman({ humanId });
            altApiKeysRevoked += altKeys.count;
            altApiKeyRequestsClosed += altKeys.closedRequestCount;
          }
        }
      }

      // Audit log
      await tx.audit.log({
        entity: "Human",
        entityId: input.humanId,
        action: "admin.setHumanStatus",
        data: {
          actorHumanId: input.actorHumanId,
          previousStatus: target.human.status,
          newStatus: input.status,
          reason: input.reason ?? null,
          sessionsInvalidated,
          apiKeysRevoked,
          apiKeyRequestsClosed,
          bannedIdentitiesRecorded,
          bannedIdentitiesRemoved,
          altAccountsSignedOut,
          altSessionsInvalidated,
          altApiKeysRevoked,
          altApiKeyRequestsClosed,
        },
      });

      return {
        sessionsInvalidated,
        apiKeysRevoked,
        bannedIdentitiesRecorded,
        bannedIdentitiesRemoved,
      };
    });

    return adminSetHumanStatusOutputSchema.parse({
      humanId: input.humanId,
      status: input.status,
      sessionsInvalidated: result.sessionsInvalidated,
      apiKeysRevoked: result.apiKeysRevoked,
      bannedIdentitiesRecorded: result.bannedIdentitiesRecorded,
      bannedIdentitiesRemoved: result.bannedIdentitiesRemoved,
    });
  };

  if (logger) {
    return logger.withTime("adminSetHumanStatus", execute);
  }

  return execute();
}
