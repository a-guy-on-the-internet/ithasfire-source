import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import { sendApiKeyNotice, type NoticeDeps } from "./_shared/notices";
import { checkHolderEligibility } from "./_shared/rules";
import {
  actorFields,
  effectiveAutoRenew,
  isInRenewWindow,
  keySnapshot,
} from "./_shared/views";
import {
  renewApiKeySelfInputSchema,
  type RenewApiKeySelfOutput,
} from "./schemas";

export type RenewApiKeySelfDeps = {
  repos: Pick<Repos, "apiKeys" | "humans" | "audit" | "tx">;
  authz: AuthZPort;
  clock?: ClockPort;
} & NoticeDeps;

const USE_CASE = "renewApiKeySelf";

/**
 * A key renews ITSELF (FR-009, R7): callable only with a key, and the key
 * making the call is the key renewed. It must be live, scoped, expiring, in
 * its last 7 days, with auto-renew on (the key's switch AND the request's).
 * The new key has the same subject, access, label and term; no approval is
 * needed, but the holder must still qualify for the subject (the role cap,
 * FR-002 / FR-009). The old key's expiry drops to now + 24h (or stays sooner),
 * cut by api_keys_guard, not here. The one exception to the credentials
 * denylist (FR-008).
 *
 * LOST-RESPONSE RISK (for plan step 7, the MCP): the new plaintext exists only
 * in this response. If it is lost in transit, the caller keeps the old key,
 * which now dies within 24h, and cannot renew again (api_keys_guard: one live
 * renewal per approval). The MCP must persist the new key before relying on
 * it, and treat a failed renew as "ask a human for a new request" well before
 * the 24h runs out.
 */
export async function renewApiKeySelf(
  deps: RenewApiKeySelfDeps,
  rawInput: unknown,
): Promise<RenewApiKeySelfOutput> {
  const input = parseInput(renewApiKeySelfInputSchema, rawInput);
  const now = deps.clock?.now() ?? new Date();

  const renewed = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const parent = await tx.apiKeys.getKey({
          keyId: input.actingApiKeyId,
        });
        // The calling key must be the actor's own (authn resolved both from
        // the same row; this refuses a mismatched context).
        if (!parent || parent.humanId !== input.actorHumanId) {
          throw apiKeyError("api_key_not_found");
        }
        if (parent.subject === null || parent.requestId === null) {
          throw apiKeyError("api_key_legacy_key");
        }
        if (
          !effectiveAutoRenew(parent) ||
          parent.expiresAt === null ||
          !isInRenewWindow(parent, now)
        ) {
          throw apiKeyError("api_key_not_renewable");
        }

        const eligibility = await checkHolderEligibility(
          { authz: deps.authz, repos: tx },
          {
            humanId: parent.humanId,
            subject: parent.subject,
            orgId: parent.orgId,
          },
        );
        if (!eligibility.eligible) {
          throw apiKeyError("api_key_holder_no_longer_eligible", {
            why: eligibility.why,
          });
        }

        const outcome = await tx.apiKeys.renew({
          parentKeyId: parent.id,
          holderHumanId: input.actorHumanId,
        });
        if (outcome.status === "not_found") {
          throw apiKeyError("api_key_not_found");
        }
        // The guard cut the parent's expiry; read it back for the caller.
        const after = await tx.apiKeys.getKey({ keyId: parent.id });

        await tx.audit.log({
          entity: "api_key",
          entityId: outcome.record.id,
          action: "api_key.renewed",
          data: {
            ...actorFields(input),
            ...keySnapshot(outcome.record, parent),
            previousKeyExpiresAt: after?.expiresAt
              ? after.expiresAt.toISOString()
              : null,
          },
          at: outcome.record.createdAt,
        });
        return {
          key: outcome.key,
          record: outcome.record,
          previousKeyExpiresAt: after?.expiresAt ?? null,
        };
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );

  const record = renewed.record;
  if (record.subject === "ORG" && record.orgId && record.renewedFromKeyId) {
    await sendApiKeyNotice(
      deps,
      {
        kind: "key_renewed",
        audience: {
          kind: "org_admins",
          orgId: record.orgId,
          excludeHumanId: record.humanId,
        },
        holderHumanId: record.humanId,
        renewedFromKeyId: record.renewedFromKeyId,
        keyId: record.id,
        subject: record.subject,
        orgId: record.orgId,
        label: record.label,
        keyLast4: record.keyLast4,
      },
      USE_CASE,
    );
  }

  return {
    keyId: record.id,
    key: renewed.key,
    keyLast4: record.keyLast4 ?? renewed.key.slice(-4),
    expiresAt: record.expiresAt,
    renewedFromKeyId: record.renewedFromKeyId ?? input.actingApiKeyId,
    previousKeyExpiresAt: renewed.previousKeyExpiresAt,
  };
}
