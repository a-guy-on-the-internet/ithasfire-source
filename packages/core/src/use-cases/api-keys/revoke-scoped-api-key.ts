import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import { sendApiKeyNotice, type NoticeDeps } from "./_shared/notices";
import { revokeRight } from "./_shared/rules";
import { actorFields, keySnapshot } from "./_shared/views";
import {
  revokeScopedApiKeyInputSchema,
  type RevokeScopedApiKeyOutput,
} from "./schemas";

export type RevokeScopedApiKeyDeps = {
  repos: Pick<Repos, "apiKeys" | "audit" | "tx">;
  authz: AuthZPort;
} & NoticeDeps;

const USE_CASE = "revokeScopedApiKey";

/**
 * Revoke a key (FR-010, R9). Replaces the legacy `revokeApiKey`, which the
 * router keeps calling until plan step 5 swaps it for this one.
 *
 * Who: the holder; an OWNER / ADMIN of the key's org (read from the key row,
 * never from input) for an ORG key; a staff ADMIN for any key. Anyone else is
 * told the key does not exist (no IDOR).
 *
 * What: the key's whole approval, i.e. both live keys during a renewal
 * overlap, in one transaction (the repo locks the request row first). The
 * audit row tells the keys that were cut off (`revokedKeyIds`) apart from
 * already-expired keys closed with them (`alsoClosedExpiredKeyIds`). The
 * holder is told when someone else revoked a live key, with the optional
 * reason.
 *
 * Idempotent: an already-revoked key returns `already_revoked`, no new audit
 * row, no notice.
 *
 * Session only (FR-008 credentials denylist).
 */
export async function revokeScopedApiKey(
  deps: RevokeScopedApiKeyDeps,
  rawInput: unknown,
): Promise<RevokeScopedApiKeyOutput> {
  const input = parseInput(revokeScopedApiKeyInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");
  const reason = input.reason ? input.reason : null;

  const result = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const key = await tx.apiKeys.getKey({ keyId: input.keyId });
        if (!key) throw apiKeyError("api_key_not_found");
        const right = await revokeRight(
          { authz: deps.authz },
          input.actorHumanId,
          key,
        );
        if (right === null) throw apiKeyError("api_key_not_found");

        const outcome = await tx.apiKeys.revokeKey({
          keyId: key.id,
          revokedByHumanId: input.actorHumanId,
          reason,
        });
        if (outcome.status === "not_found") {
          throw apiKeyError("api_key_not_found");
        }
        if (outcome.status === "already_revoked") {
          return { key, right, outcome } as const;
        }

        await tx.audit.log({
          entity: "api_key",
          entityId: key.id,
          action: "api_key.revoked",
          data: {
            ...actorFields(input),
            ...keySnapshot(key, key),
            revokedAs: right,
            reason,
            revokedKeyIds: outcome.revokedKeyIds,
            alsoClosedExpiredKeyIds: outcome.alsoClosedExpiredKeyIds,
          },
        });
        return { key, right, outcome } as const;
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );

  const { key, right, outcome } = result;
  if (outcome.status === "already_revoked") {
    return {
      keyId: key.id,
      status: "already_revoked",
      revokedKeyIds: [],
      alsoClosedExpiredKeyIds: [],
    };
  }

  // "Revoked by someone else" (FR-012): only when a live key was cut off.
  if (right !== "holder" && outcome.revokedKeyIds.length > 0) {
    await sendApiKeyNotice(
      deps,
      {
        kind: "key_revoked",
        audience: { kind: "human", humanId: key.humanId },
        revokedBy: right,
        reason,
        revokedKeyIds: outcome.revokedKeyIds,
        keyId: key.id,
        subject: key.subject,
        orgId: key.orgId,
        label: key.label,
        keyLast4: key.keyLast4,
      },
      USE_CASE,
    );
  }

  return {
    keyId: key.id,
    status: "revoked",
    revokedKeyIds: outcome.revokedKeyIds,
    alsoClosedExpiredKeyIds: outcome.alsoClosedExpiredKeyIds,
  };
}
