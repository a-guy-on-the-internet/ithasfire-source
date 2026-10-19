import { randomBytes } from "node:crypto";
import { z } from "zod";

import { authZRoleSchema } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import {
  isUsableDelegateInviteSecret,
  verifyDelegateInviteToken,
  type DelegateInvitePayload,
} from "../../lib/delegate-invite-token";
import { requireInvitedIdentity } from "../../lib/invitee-identity";
import { fail } from "@th/errors";

const delegateRoleSchema = authZRoleSchema.exclude(["OWNER"]);
type DelegateRole = z.infer<typeof delegateRoleSchema>;

/** How long a used nonce is remembered past the token's own expiry. */
export const USED_NONCE_GRACE_SEC = 24 * 60 * 60;

export const acceptDelegateInviteInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    token: z.string().min(1).max(2048),
  })
  .strict();

export const acceptDelegateInviteOutputSchema = z
  .object({
    principalId: z.string().uuid(),
    principalName: z.string().nullable(),
    role: authZRoleSchema,
  })
  .strict();

export type AcceptDelegateInviteInput = z.infer<
  typeof acceptDelegateInviteInputSchema
>;
export type AcceptDelegateInviteOutput = z.infer<
  typeof acceptDelegateInviteOutputSchema
>;

export type AcceptDelegateInviteDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  inviteSecret: string | null;
  /** A grant that landed but whose nonce couldn't be recorded is reported here. */
  reportError?: ReporterPort;
};

export const delegateInviteNonceKey = (nonce: string) =>
  `delegate-invite:nonce:${nonce}`;

/**
 * Shared by accept + preview: everything that can be checked WITHOUT claiming
 * the link. Signature → role → expiry → the signed-in account owns (and has
 * verified) the invited email → not self.
 */
export async function verifyDelegateInviteForActor(
  deps: {
    repos: Pick<Repos, "humans">;
    clock: ClockPort;
    inviteSecret: string | null;
  },
  actorHumanId: string,
  token: string,
): Promise<{ payload: DelegateInvitePayload; role: DelegateRole }> {
  if (!isUsableDelegateInviteSecret(deps.inviteSecret)) {
    throw fail("NOT_CONFIGURED", {
      message: "Delegate invitations are not configured.",
    });
  }

  const payload = verifyDelegateInviteToken(deps.inviteSecret, token);
  const role = payload ? delegateRoleSchema.safeParse(payload.role) : null;
  if (!payload || !role?.success) {
    throw fail("INVITATION_NOT_FOUND");
  }

  if (payload.exp <= deps.clock.now().getTime()) {
    throw fail("INVITATION_EXPIRED", {
      message: "This invitation has expired.",
    });
  }

  await requireInvitedIdentity(deps.repos.humans, actorHumanId, payload.email);

  if (payload.principalId === actorHumanId) {
    throw fail("CANNOT_DELEGATE_TO_SELF");
  }

  return { payload, role: role.data };
}

/**
 * The invited person's side of the delegate consent flow: turns a signed
 * invitation (see `createDelegateInvite`) into a `HumanDelegate` grant with
 * the ACTOR as the delegate, after `verifyDelegateInviteForActor` passes and
 * the link's single-use nonce is claimed.
 *
 * The nonce claim lives for the token's whole remaining lifetime (plus a
 * grace day) from the moment it's taken — NOT a short in-progress TTL — so a
 * crash or a failed `commit` after the grant can never reopen the link.
 * `commit` only upgrades the record to "succeeded"; its failure is reported,
 * not thrown, because the grant already happened. Only a failure BEFORE the
 * grant (the transaction) releases the claim for a retry.
 *
 * An existing delegation is left as-is (role unchanged) — the principal
 * changes roles through `updateDelegateRole`, never through a replayed link.
 */
export async function acceptDelegateInvite(
  deps: AcceptDelegateInviteDeps,
  rawInput: unknown,
): Promise<AcceptDelegateInviteOutput> {
  const input = parseInput(acceptDelegateInviteInputSchema, rawInput);
  const { payload, role } = await verifyDelegateInviteForActor(
    deps,
    input.actorHumanId,
    input.token,
  );

  const now = deps.clock.now();
  const remainingSec = Math.max(
    Math.ceil((payload.exp - now.getTime()) / 1000),
    0,
  );
  const retainSec = remainingSec + USED_NONCE_GRACE_SEC;

  const nonceKey = delegateInviteNonceKey(payload.nonce);
  const ownerToken = randomBytes(16).toString("base64url");
  const claimed = await deps.idempotency.begin(nonceKey, retainSec, ownerToken);
  if (!claimed) {
    throw fail("INVITATION_NOT_PENDING", {
      message: "This invitation has already been accepted.",
      meta: { status: "ACCEPTED" },
    });
  }

  let result: AcceptDelegateInviteOutput;
  try {
    result = await deps.repos.tx(async (tx) => {
      const principal = await tx.humans.getById(payload.principalId);
      if (!principal) {
        throw fail("HUMAN_NOT_FOUND");
      }

      const existing = await tx.humanDelegates.getDelegation({
        principalId: payload.principalId,
        delegateId: input.actorHumanId,
      });
      if (existing) {
        return {
          principalId: principal.id,
          principalName: principal.name,
          role: existing.role,
        };
      }

      await tx.humanDelegates.addDelegate({
        principalId: payload.principalId,
        delegateId: input.actorHumanId,
        role,
      });

      await tx.audit.log({
        entity: "human",
        entityId: payload.principalId,
        action: "human.delegate_added",
        data: {
          actorHumanId: input.actorHumanId,
          targetHumanId: input.actorHumanId,
          role,
          method: "invite_accepted",
        },
        at: now,
      });

      return {
        principalId: principal.id,
        principalName: principal.name,
        role,
      };
    });
  } catch (err) {
    // Nothing was granted: free the claim so a transient failure doesn't burn
    // the link. A failed release is logged (Sentry via pino); the original
    // error is what the caller sees.
    await deps.idempotency
      .release(nonceKey, ownerToken)
      .catch((releaseErr: unknown) => {
        deps.logger?.error("delegates.invite_claim_release_failed", {
          err: releaseErr,
        });
        return false;
      });
    throw err;
  }

  try {
    await deps.idempotency.commit(
      nonceKey,
      { acceptedBy: input.actorHumanId },
      retainSec,
    );
  } catch (commitErr) {
    // The grant happened and the in-progress claim already holds the nonce
    // for the token's full lifetime, so the link stays single-use. Report,
    // don't fail the request.
    deps.logger?.error("delegates.invite_nonce_commit_failed", {
      err: commitErr,
      principalId: result.principalId,
    });
    try {
      deps.reportError?.(commitErr, {
        tags: { useCase: "acceptDelegateInvite", area: "nonce_commit" },
        extra: { principalId: result.principalId },
      });
    } catch {
      // Reporting is best-effort.
    }
  }

  deps.logger?.info("delegates.invite_accepted", {
    principalId: result.principalId,
    delegateId: input.actorHumanId,
  });

  return acceptDelegateInviteOutputSchema.parse(result);
}
