import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { apiKeyError, runApiKeyWrite } from "./_shared/errors";
import {
  sendApiKeyNotice,
  type ApiKeyNoticeAudience,
  type NoticeDeps,
} from "./_shared/notices";
import {
  AUTO_RENEW_MIN_TERM_DAYS,
  checkHolderEligibility,
  EXPIRY_DAYS_MAX,
  MAX_KEYS_PER_HOLDER_PER_SUBJECT,
  MAX_KEYS_PER_ORG,
  MAX_REQUESTS_PER_HOLDER_PER_DAY,
  NEVER_EXPIRING_ALLOWED,
  PLATFORM_STAFF_ROLES,
  STAFF_ADMIN_ROLES,
} from "./_shared/rules";
import { actorFields, requestSnapshot } from "./_shared/views";
import { requestApiKeyInputSchema, type RequestApiKeyOutput } from "./schemas";

export type RequestApiKeyDeps = {
  repos: Pick<Repos, "apiKeys" | "humans" | "audit" | "tx">;
  authz: AuthZPort;
} & NoticeDeps;

const USE_CASE = "requestApiKey";

/**
 * Send a key request (FR-001 / FR-002). Who may ask follows the Key scopes
 * table: ORG = a live OWNER / ADMIN of that org; STAFF = a staff role in
 * R28's set; PERSONAL / PLATFORM_WIDE = any verified human. Every requester
 * is ACTIVE with a verified email. The requester is always the future holder
 * (out of scope: asking on someone else's behalf).
 *
 * Caps (FR-011) are read under the repo's advisory lock inside the same
 * transaction that inserts, so two concurrent requests cannot both pass "4".
 * Approvers are told after commit (FR-012); a failed send is reported, not
 * thrown.
 *
 * Session only: a key cannot request a key (FR-008 credentials denylist;
 * the transport enforces it first, this refuses it again).
 */
export async function requestApiKey(
  deps: RequestApiKeyDeps,
  rawInput: unknown,
): Promise<RequestApiKeyOutput> {
  const input = parseInput(requestApiKeyInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");

  const orgId = input.orgId ?? null;
  // ── Shape the schema cannot express alone (the DB CHECKs are the backstop) ──
  if ((input.subject === "ORG") !== (orgId !== null)) {
    throw apiKeyError("api_key_org_required");
  }
  if (input.subject === "PLATFORM_WIDE" && input.access !== "READ") {
    throw apiKeyError("api_key_platform_wide_read_only");
  }
  if (input.expiryDays === null) {
    if (!NEVER_EXPIRING_ALLOWED[input.subject]) {
      throw apiKeyError("api_key_expiry_not_allowed", {
        maxDays: EXPIRY_DAYS_MAX[input.subject],
      });
    }
  } else if (input.expiryDays > EXPIRY_DAYS_MAX[input.subject]) {
    throw apiKeyError("api_key_expiry_not_allowed", {
      maxDays: EXPIRY_DAYS_MAX[input.subject],
    });
  }
  // R30 + FR-009: auto-renew needs a term, of 2 days or more.
  if (
    input.autoRenew &&
    (input.expiryDays === null || input.expiryDays < AUTO_RENEW_MIN_TERM_DAYS)
  ) {
    throw apiKeyError("api_key_auto_renew_needs_term", {
      minDays: AUTO_RENEW_MIN_TERM_DAYS,
    });
  }

  const { created, orgHasApprover } = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const eligibility = await checkHolderEligibility(
          { authz: deps.authz, repos: tx },
          { humanId: input.actorHumanId, subject: input.subject, orgId },
        );
        if (!eligibility.eligible) {
          throw apiKeyError("api_key_request_not_eligible", {
            why: eligibility.why,
          });
        }

        const counts = await tx.apiKeys.lockAndCountForCap({
          holderHumanId: input.actorHumanId,
          subject: input.subject,
          orgId,
        });
        // Abuse limit (orchestrator, not a spec rule): see
        // MAX_REQUESTS_PER_HOLDER_PER_DAY.
        if (counts.holderRequestsLast24h >= MAX_REQUESTS_PER_HOLDER_PER_DAY) {
          throw apiKeyError("api_key_request_rate_limited", {
            limit: MAX_REQUESTS_PER_HOLDER_PER_DAY,
          });
        }
        if (counts.holderCount >= MAX_KEYS_PER_HOLDER_PER_SUBJECT) {
          throw apiKeyError("api_key_cap_reached", {
            limit: MAX_KEYS_PER_HOLDER_PER_SUBJECT,
            active: counts.holderCount,
          });
        }
        if (counts.orgCount !== null && counts.orgCount >= MAX_KEYS_PER_ORG) {
          throw apiKeyError("api_key_org_cap_reached", {
            limit: MAX_KEYS_PER_ORG,
            active: counts.orgCount,
          });
        }

        const request = await tx.apiKeys.createRequest({
          requesterHumanId: input.actorHumanId,
          subject: input.subject,
          orgId,
          access: input.access,
          label: input.label,
          purpose: input.purpose,
          expiryDays: input.expiryDays,
          autoRenew: input.autoRenew,
        });

        await tx.audit.log({
          entity: "api_key_request",
          entityId: request.id,
          action: "api_key_request.created",
          data: {
            ...actorFields(input),
            ...requestSnapshot(request),
          },
          at: request.createdAt,
        });

        // Who decides it (Key scopes table), read before commit so a failed
        // read cannot fail a request that already exists. The ORG fallback is
        // the same SQL as the platform queue (orgHasOtherLiveApprover), so
        // the notice goes where the request is listed.
        const hasApprover =
          request.subject === "ORG" && request.orgId
            ? await tx.apiKeys.orgHasOtherLiveApprover({
                orgId: request.orgId,
                excludeHumanId: request.requesterHumanId,
              })
            : false;
        return { created: request, orgHasApprover: hasApprover };
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );

  let approvers: RequestApiKeyOutput["approvers"];
  let audience: ApiKeyNoticeAudience;
  if (created.subject === "ORG" && created.orgId) {
    approvers = orgHasApprover ? "org_admins" : "platform_staff";
    audience = orgHasApprover
      ? ({
          kind: "org_admins",
          orgId: created.orgId,
          excludeHumanId: created.requesterHumanId,
        } as const)
      : ({ kind: "platform_staff", roles: PLATFORM_STAFF_ROLES } as const);
  } else if (created.subject === "PERSONAL") {
    approvers = "platform_staff";
    audience = { kind: "platform_staff", roles: PLATFORM_STAFF_ROLES } as const;
  } else {
    approvers = "staff_admins";
    audience = { kind: "platform_staff", roles: STAFF_ADMIN_ROLES } as const;
  }

  await sendApiKeyNotice(
    deps,
    {
      kind: "request_submitted",
      audience,
      requesterHumanId: created.requesterHumanId,
      requestId: created.id,
      subject: created.subject,
      orgId: created.orgId,
      access: created.access,
      label: created.label,
    },
    USE_CASE,
  );

  return { requestId: created.id, status: "pending", approvers };
}
