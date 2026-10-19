import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import type { NoticeDeps } from "./_shared/notices";
import { deciderStillHoldsRole, revokeRight } from "./_shared/rules";
import { actorFields, keySnapshot } from "./_shared/views";
import {
  setApiKeyAutoRenewInputSchema,
  type SetApiKeyAutoRenewOutput,
} from "./schemas";

export type SetApiKeyAutoRenewDeps = {
  repos: Pick<Repos, "apiKeys" | "audit" | "tx">;
  authz: AuthZPort;
} & Pick<NoticeDeps, "logger">;

const USE_CASE = "setApiKeyAutoRenew";

/**
 * Auto-renew has two switches (FR-009, auth.prisma ApiKey comment):
 *
 *  - The HOLDER's, on the key: on or off. Switching on needs the request's
 *    switch on (`request_disallows` otherwise) and a live key.
 *  - The APPROVER's, on the request: off only, and final (the request guard
 *    refuses switching it back on), so the holder cannot undo it. It also
 *    switches off every unrevoked key on the request. "Approver" here is the
 *    human who decided the request WHILE they still hold a role that could
 *    decide it (`deciderStillHoldsRole`), or anyone who may revoke the key
 *    (an OWNER / ADMIN of an ORG key's org, a staff ADMIN): switching off
 *    renewal is less than revoking, so whoever may revoke may also stop it.
 *
 * Anyone else is told the key does not exist (no IDOR). Session only.
 * Idempotent: an unchanged switch returns `changed: false`, no audit row.
 */
export async function setApiKeyAutoRenew(
  deps: SetApiKeyAutoRenewDeps,
  rawInput: unknown,
): Promise<SetApiKeyAutoRenewOutput> {
  const input = parseInput(setApiKeyAutoRenewInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");

  return runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx): Promise<SetApiKeyAutoRenewOutput> => {
        const key = await tx.apiKeys.getKey({ keyId: input.keyId });
        if (!key) throw apiKeyError("api_key_not_found");

        const right = await revokeRight(
          { authz: deps.authz },
          input.actorHumanId,
          key,
        );
        // The decider keeps the switch-off only while they still hold a
        // role that could decide this key; a former approver has no right
        // over it, and is told it does not exist.
        const isDecider =
          right === null &&
          key.decidedByHumanId !== null &&
          key.decidedByHumanId === input.actorHumanId &&
          (await deciderStillHoldsRole(
            { authz: deps.authz },
            input.actorHumanId,
            key,
          ));
        if (right === null && !isDecider) {
          throw apiKeyError("api_key_not_found");
        }
        if (key.subject === null || key.requestId === null) {
          throw apiKeyError("api_key_legacy_key");
        }

        if (right === "holder") {
          const outcome = await tx.apiKeys.setKeyAutoRenew({
            keyId: key.id,
            autoRenew: input.autoRenew,
          });
          switch (outcome.status) {
            case "not_found":
              throw apiKeyError("api_key_not_found");
            case "not_live":
              throw apiKeyError("api_key_not_live");
            case "request_disallows":
              throw apiKeyError("api_key_auto_renew_not_allowed");
            case "unchanged":
              return {
                keyId: key.id,
                switchedOn: "key",
                changed: false,
                autoRenew:
                  outcome.record.autoRenew && key.requestAutoRenew === true,
              };
            case "updated":
              break;
          }
          await tx.audit.log({
            entity: "api_key",
            entityId: key.id,
            action: input.autoRenew
              ? "api_key.auto_renew_on"
              : "api_key.auto_renew_off",
            data: {
              ...actorFields(input),
              ...keySnapshot(outcome.record, key),
              switch: "key",
            },
          });
          return {
            keyId: key.id,
            switchedOn: "key",
            changed: true,
            autoRenew:
              outcome.record.autoRenew && key.requestAutoRenew === true,
          };
        }

        // The approver's switch: off only, written to the request.
        if (input.autoRenew) {
          throw apiKeyError("api_key_auto_renew_not_allowed");
        }
        const outcome = await tx.apiKeys.switchOffRequestAutoRenew({
          requestId: key.requestId,
        });
        if (outcome.status === "not_found") {
          throw apiKeyError("api_key_not_found");
        }
        if (outcome.status === "unchanged") {
          return {
            keyId: key.id,
            switchedOn: "request",
            changed: false,
            autoRenew: false,
          };
        }
        await tx.audit.log({
          entity: "api_key_request",
          entityId: key.requestId,
          action: "api_key_request.auto_renew_off",
          data: {
            ...actorFields(input),
            ...keySnapshot(key, key),
            switch: "request",
            switchedOffAs: right ?? "decider",
            switchedOffKeyIds: outcome.keyIds,
          },
        });
        return {
          keyId: key.id,
          switchedOn: "request",
          changed: true,
          autoRenew: false,
        };
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );
}
