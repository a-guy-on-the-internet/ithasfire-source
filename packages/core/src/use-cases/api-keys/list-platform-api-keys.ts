import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ApiKeyRequestRecord } from "@th/ports/repos/api-keys";

import { parseInput } from "../../lib/io";
import {
  isPlatformOwner,
  type PlatformOwnerEnvironment,
} from "../../lib/security/platform-owner";
import { apiKeyError } from "./_shared/errors";
import {
  hasStaffRoleIn,
  PLATFORM_STAFF_ROLES,
  SELF_APPROVAL_MAX_TERM_DAYS,
  SELF_APPROVAL_MIN_TERM_DAYS,
  STAFF_ADMIN_ROLES,
} from "./_shared/rules";
import { resolveNames, toKeyView, toRequestView } from "./_shared/views";
import { API_KEY_LIST_LIMIT } from "./list-my-api-keys";
import {
  listPlatformApiKeysInputSchema,
  type ListPlatformApiKeysOutput,
} from "./schemas";

export type ListPlatformApiKeysDeps = {
  repos: Pick<Repos, "apiKeys" | "humans">;
  authz: AuthZPort;
  /** See DecideApiKeyRequestDeps; null = no platform owner here. */
  platformOwnerEnvironment: PlatformOwnerEnvironment | null;
  clock?: ClockPort;
  logger?: LoggerPort;
};

const DEFAULT_PAGE = 25;

/**
 * The platform "API keys" page (FR-014, R9 "staff see all"): the request
 * queue (PERSONAL, STAFF and PLATFORM_WIDE requests, plus ORG requests whose
 * org has no live approver besides the requester) and every key, paged.
 * Platform staff only.
 *
 * `canDecide` / `canSelfApprove` / `canRevoke` are hints for the buttons;
 * decide and revoke check again. ORG fallbacks are decidable by any platform
 * staff because the queue's SQL is the same rule decide uses
 * (`orgHasOtherLiveApprover`). No create: a key exists only after an
 * approved request (spec lifecycle.platform_page).
 */
export async function listPlatformApiKeys(
  deps: ListPlatformApiKeysDeps,
  rawInput: unknown,
): Promise<ListPlatformApiKeysOutput> {
  const input = parseInput(listPlatformApiKeysInputSchema, rawInput);
  // FR-008: the credentials denylist covers API keys, so a key never lists
  // keys (the transport refuses it first).
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");
  if (!(await hasStaffRoleIn(deps, input.actorHumanId, PLATFORM_STAFF_ROLES))) {
    throw apiKeyError("api_key_list_not_allowed");
  }
  const isStaffAdmin = await hasStaffRoleIn(
    deps,
    input.actorHumanId,
    STAFF_ADMIN_ROLES,
  );
  const isOwner =
    deps.platformOwnerEnvironment !== null &&
    isPlatformOwner(input.actorHumanId, deps.platformOwnerEnvironment);
  const now = deps.clock?.now() ?? new Date();
  const limit = input.limit ?? DEFAULT_PAGE;
  const offset = input.offset ?? 0;

  const [queue, page] = await Promise.all([
    deps.repos.apiKeys.listPlatformQueue({
      subjects: ["PERSONAL", "STAFF", "PLATFORM_WIDE"],
      includeOrgFallbacks: true,
      limit: API_KEY_LIST_LIMIT,
    }),
    deps.repos.apiKeys.listAllKeys({ limit, offset, subject: input.subject }),
  ]);

  const names = await resolveNames(deps.repos, [
    ...page.items.flatMap((k) => [
      k.humanId,
      k.decidedByHumanId,
      k.revokedByHumanId,
    ]),
    ...queue.map((r) => r.requesterHumanId),
  ]);

  const canDecide = (r: ApiKeyRequestRecord): boolean => {
    if (r.requesterHumanId === input.actorHumanId) return false;
    return r.subject === "STAFF" || r.subject === "PLATFORM_WIDE"
      ? isStaffAdmin
      : true;
  };
  const canSelfApprove = (r: ApiKeyRequestRecord): boolean =>
    isOwner &&
    isStaffAdmin &&
    r.requesterHumanId === input.actorHumanId &&
    r.subject === "STAFF" &&
    r.autoRenew &&
    r.expiryDays !== null &&
    r.expiryDays >= SELF_APPROVAL_MIN_TERM_DAYS &&
    r.expiryDays <= SELF_APPROVAL_MAX_TERM_DAYS;

  return {
    queue: queue.map((r) =>
      toRequestView(r, now, names, {
        canDecide: canDecide(r),
        canSelfApprove: canSelfApprove(r),
      }),
    ),
    keys: {
      items: page.items.map((k) =>
        toKeyView(k, now, names, {
          canRevoke: isStaffAdmin || k.humanId === input.actorHumanId,
        }),
      ),
      total: page.total,
      limit,
      offset,
      hasNextPage: offset + page.items.length < page.total,
    },
  };
}
