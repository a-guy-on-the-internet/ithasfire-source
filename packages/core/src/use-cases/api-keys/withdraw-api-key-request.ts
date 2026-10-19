import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import {
  actorFields,
  deriveRequestStatus,
  requestSnapshot,
} from "./_shared/views";
import {
  withdrawApiKeyRequestInputSchema,
  type WithdrawApiKeyRequestOutput,
} from "./schemas";

export type WithdrawApiKeyRequestDeps = {
  repos: Pick<Repos, "apiKeys" | "audit" | "tx">;
  clock?: ClockPort;
  logger?: LoggerPort;
};

const USE_CASE = "withdrawApiKeyRequest";

/**
 * The requester withdraws their undecided request (FR-004): pending, or
 * lapsed and undecided (harmless; it only skips the lapse notice). Only the
 * requester: the repo's CAS matches `requester_human_id`, and anyone else is
 * told the request does not exist (no IDOR). A decided request cannot be
 * withdrawn (an approved key is revoked instead).
 *
 * Idempotent: an already-withdrawn request returns its status without a new
 * audit row; one closed for account security (R31) says so, never "you
 * withdrew".
 */
export async function withdrawApiKeyRequest(
  deps: WithdrawApiKeyRequestDeps,
  rawInput: unknown,
): Promise<WithdrawApiKeyRequestOutput> {
  const input = parseInput(withdrawApiKeyRequestInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");

  const request = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const outcome = await tx.apiKeys.withdraw({
          requestId: input.requestId,
          requesterHumanId: input.actorHumanId,
        });
        switch (outcome.status) {
          case "not_found":
            throw apiKeyError("api_key_request_not_found");
          case "already_decided":
            throw apiKeyError("api_key_request_already_decided");
          case "already_withdrawn":
            return outcome.request;
          case "withdrawn":
            break;
        }
        await tx.audit.log({
          entity: "api_key_request",
          entityId: outcome.request.id,
          action: "api_key_request.withdrawn",
          data: {
            ...actorFields(input),
            ...requestSnapshot(outcome.request),
          },
          at: outcome.request.withdrawnAt ?? undefined,
        });
        return outcome.request;
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );

  return {
    requestId: request.id,
    status: deriveRequestStatus(request, deps.clock?.now() ?? new Date()),
  };
}
