import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import { sendApiKeyNotice, type NoticeDeps } from "./_shared/notices";
import { checkHolderEligibility } from "./_shared/rules";
import { actorFields, deriveRequestStatus, keySnapshot } from "./_shared/views";
import { collectApiKeyInputSchema, type CollectApiKeyOutput } from "./schemas";

export type CollectApiKeyDeps = {
  repos: Pick<Repos, "apiKeys" | "humans" | "audit" | "tx">;
  authz: AuthZPort;
  clock?: ClockPort;
} & NoticeDeps;

const USE_CASE = "collectApiKey";

/**
 * The holder collects the key of their approved request (FR-005): the key is
 * minted now and its plaintext returned ONCE; only its SHA-256 hash is
 * stored. Only the requester may collect (anyone else: not found). Refused
 * when the request is not approved, already collected, past its 7-day window,
 * withdrawn, or closed for account security (R31, said as such). The holder
 * must still qualify for the subject (FR-002) and be ACTIVE.
 *
 * The plaintext is in the return value and nowhere else: not in the audit
 * row, the org admins' notice, logs or errors.
 *
 * Session only (FR-008: a key cannot mint a key).
 */
export async function collectApiKey(
  deps: CollectApiKeyDeps,
  rawInput: unknown,
): Promise<CollectApiKeyOutput> {
  const input = parseInput(collectApiKeyInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");

  const minted = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const request = await tx.apiKeys.getRequest({
          requestId: input.requestId,
        });
        if (!request || request.requesterHumanId !== input.actorHumanId) {
          throw apiKeyError("api_key_request_not_found");
        }

        // Friendly refusals first; api_keys_guard is the backstop on the DB
        // clock (mapped below).
        const status = deriveRequestStatus(
          request,
          deps.clock?.now() ?? new Date(),
        );
        switch (status) {
          case "ready_to_collect":
            break;
          case "closed_for_account_security":
            throw apiKeyError("api_key_request_closed_for_account_security");
          case "withdrawn":
            throw apiKeyError("api_key_request_withdrawn");
          case "collected":
          case "collect_lapsed":
            throw apiKeyError("api_key_already_collected_or_lapsed");
          case "pending":
          case "lapsed":
          case "denied":
            throw apiKeyError("api_key_request_not_approved");
        }

        const eligibility = await checkHolderEligibility(
          { authz: deps.authz, repos: tx },
          {
            humanId: request.requesterHumanId,
            subject: request.subject,
            orgId: request.orgId,
          },
        );
        if (!eligibility.eligible) {
          throw apiKeyError("api_key_holder_no_longer_eligible", {
            why: eligibility.why,
          });
        }

        const outcome = await tx.apiKeys.collect({
          requestId: request.id,
          holderHumanId: input.actorHumanId,
        });
        if (outcome.status === "not_found") {
          throw apiKeyError("api_key_request_not_found");
        }
        if (outcome.status === "holder_inactive") {
          throw apiKeyError("api_key_holder_inactive");
        }

        await tx.audit.log({
          entity: "api_key",
          entityId: outcome.record.id,
          action: "api_key.collected",
          data: {
            ...actorFields(input),
            ...keySnapshot(outcome.record, request),
          },
          at: outcome.record.createdAt,
        });
        return { key: outcome.key, record: outcome.record };
      }),
    {
      useCase: USE_CASE,
      logger: deps.logger,
      // One collect per request (api_keys_one_collect_per_request): a twin
      // collect that lost the race.
      overrides: { unique_violation: "api_key_already_collected_or_lapsed" },
    },
  );

  const record = minted.record;
  if (record.subject === "ORG" && record.orgId) {
    await sendApiKeyNotice(
      deps,
      {
        kind: "key_collected",
        audience: {
          kind: "org_admins",
          orgId: record.orgId,
          excludeHumanId: record.humanId,
        },
        holderHumanId: record.humanId,
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
    key: minted.key,
    keyLast4: record.keyLast4 ?? minted.key.slice(-4),
    expiresAt: record.expiresAt,
  };
}
