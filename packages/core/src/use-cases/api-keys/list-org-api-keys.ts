import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError } from "./_shared/errors";
import { isOrgKeyAdmin } from "./_shared/rules";
import { resolveNames, toKeyView, toRequestView } from "./_shared/views";
import { API_KEY_LIST_LIMIT } from "./list-my-api-keys";
import {
  listOrgApiKeysInputSchema,
  type ListOrgApiKeysOutput,
} from "./schemas";

export type ListOrgApiKeysDeps = {
  repos: Pick<Repos, "apiKeys" | "humans">;
  authz: AuthZPort;
  clock?: ClockPort;
  logger?: LoggerPort;
};

/**
 * The org settings "API keys" screen (FR-014, R9, R23d, R24): every key on
 * the org, all holders, and the org's waiting requests. OWNERs / ADMINs of
 * the org only. The caller may decide every waiting request except their own
 * (`canDecide`); their own still shows, so they can see it is waiting. Never
 * a hash.
 */
export async function listOrgApiKeys(
  deps: ListOrgApiKeysDeps,
  rawInput: unknown,
): Promise<ListOrgApiKeysOutput> {
  const input = parseInput(listOrgApiKeysInputSchema, rawInput);
  // FR-008: the credentials denylist covers API keys, so a key never lists
  // keys (the transport refuses it first).
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");
  if (!(await isOrgKeyAdmin(deps, input.actorHumanId, input.orgId))) {
    throw apiKeyError("api_key_list_not_allowed");
  }
  const now = deps.clock?.now() ?? new Date();

  const [keys, queue] = await Promise.all([
    deps.repos.apiKeys.listKeysByOrg({
      orgId: input.orgId,
      limit: API_KEY_LIST_LIMIT,
    }),
    deps.repos.apiKeys.listOrgQueue({
      orgId: input.orgId,
      limit: API_KEY_LIST_LIMIT,
    }),
  ]);

  const names = await resolveNames(deps.repos, [
    ...keys.flatMap((k) => [k.humanId, k.decidedByHumanId, k.revokedByHumanId]),
    ...queue.map((r) => r.requesterHumanId),
  ]);

  return {
    keys: keys.map((k) => toKeyView(k, now, names, { canRevoke: true })),
    queue: queue.map((r) =>
      toRequestView(r, now, names, {
        canDecide: r.requesterHumanId !== input.actorHumanId,
        canSelfApprove: false,
      }),
    ),
  };
}
