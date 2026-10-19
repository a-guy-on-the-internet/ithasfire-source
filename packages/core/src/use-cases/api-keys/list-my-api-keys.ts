import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError } from "./_shared/errors";
import { resolveNames, toKeyView, toRequestView } from "./_shared/views";
import { listMyApiKeysInputSchema, type ListMyApiKeysOutput } from "./schemas";

export type ListMyApiKeysDeps = {
  repos: Pick<Repos, "apiKeys" | "humans">;
  clock?: ClockPort;
  logger?: LoggerPort;
};

/** Rows per list; R15 caps keep real lists far below this. */
export const API_KEY_LIST_LIMIT = 100;

/**
 * The account screen (FR-014, R23a): the caller's keys across every subject
 * (scoped and legacy) and their key requests, each with a derived status. A
 * request closed by a password reset or a ban reads
 * `closed_for_account_security` (R31), never "withdrawn". Only the caller's
 * own rows: both reads filter by the caller's id. Never a hash.
 */
export async function listMyApiKeys(
  deps: ListMyApiKeysDeps,
  rawInput: unknown,
): Promise<ListMyApiKeysOutput> {
  const input = parseInput(listMyApiKeysInputSchema, rawInput);
  // FR-008: the credentials denylist covers API keys, so a key never lists
  // keys (the transport refuses it first).
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");
  const now = deps.clock?.now() ?? new Date();

  const [keys, requests] = await Promise.all([
    deps.repos.apiKeys.listKeysByHolder({
      humanId: input.actorHumanId,
      limit: API_KEY_LIST_LIMIT,
    }),
    deps.repos.apiKeys.listRequestsByRequester({
      requesterHumanId: input.actorHumanId,
      limit: API_KEY_LIST_LIMIT,
    }),
  ]);

  const names = await resolveNames(deps.repos, [
    input.actorHumanId,
    ...keys.flatMap((k) => [k.decidedByHumanId, k.revokedByHumanId]),
    ...requests.map((r) => r.decidedByHumanId),
  ]);

  return {
    keys: keys.map((k) => toKeyView(k, now, names, { canRevoke: true })),
    requests: requests.map((r) =>
      toRequestView(r, now, names, { canDecide: false, canSelfApprove: false }),
    ),
  };
}
