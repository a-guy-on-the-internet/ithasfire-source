import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { ApiKeyRequestRecord } from "@th/ports/repos/api-keys";
import type { StepUpPort } from "@th/ports/step-up";

import { parseInput } from "../../lib/io";
import type { PlatformOwnerEnvironment } from "../../lib/security/platform-owner";
import {
  apiKeyError,
  runApiKeyWrite,
  type ApiKeyErrorCode,
} from "./_shared/errors";
import { sendApiKeyNotice, type NoticeDeps } from "./_shared/notices";
import {
  addDays,
  checkHolderEligibility,
  COLLECT_WINDOW_DAYS,
  decideRight,
  SELF_APPROVAL_MAX_TERM_DAYS,
  SELF_APPROVAL_MIN_TERM_DAYS,
  STEP_UP_MAX_AGE_SECONDS,
} from "./_shared/rules";
import {
  actorFields,
  deriveRequestStatus,
  requestSnapshot,
} from "./_shared/views";
import {
  decideApiKeyRequestInputSchema,
  type ApiKeyRequestStatus,
  type DecideApiKeyRequestOutput,
} from "./schemas";

export type DecideApiKeyRequestDeps = {
  repos: Pick<Repos, "apiKeys" | "humans" | "audit" | "tx">;
  authz: AuthZPort;
  /**
   * The platform owner's environment, resolved ONCE by the composition root
   * with `platformOwnerEnvironment(process.env)` (core never reads the
   * environment). Null = this deployment has no platform owner: nobody may
   * self-approve.
   */
  platformOwnerEnvironment: PlatformOwnerEnvironment | null;
  /**
   * Checks the platform owner's fresh password / passkey proof (FR-003).
   * Required-nullable: a composition root says `null` explicitly when it has
   * no step-up adapter, and then nobody can self-approve.
   */
  stepUp: StepUpPort | null;
  clock?: ClockPort;
} & NoticeDeps;

const USE_CASE = "decideApiKeyRequest";

/**
 * Approve or deny a key request (FR-003 / FR-004).
 *
 * Rights (Key scopes table, `decideRight`): ORG = another OWNER / ADMIN of
 * the request's org, or platform staff when the org has no other live
 * approver; PERSONAL = platform staff; STAFF / PLATFORM_WIDE = staff ADMINs.
 * Nobody decides their own request, with ONE exception: the platform owner
 * approving their own STAFF request with a fresh step-up, a term of 2 to 30
 * days and auto-renew on (FR-003, R21, R30); that approval is recorded as
 * `selfApproved`.
 *
 * Approval re-checks the requester's eligibility (FR-002). A denial needs a
 * reason the requester sees. The decision is a CAS: a request decided,
 * withdrawn, closed for account security or lapsed meanwhile comes back as a
 * typed error, never a second decision. Idempotent: repeating your own
 * decision returns the current status.
 */
export async function decideApiKeyRequest(
  deps: DecideApiKeyRequestDeps,
  rawInput: unknown,
): Promise<DecideApiKeyRequestOutput> {
  const input = parseInput(decideApiKeyRequestInputSchema, rawInput);
  if (input.actingApiKeyId) throw apiKeyError("api_key_session_only");

  const reason = input.reason ?? null;
  if (input.decision === "DENIED" && !reason) {
    throw apiKeyError("api_key_denial_reason_required");
  }
  // A reason is the denial's; an approval carries none (CHECK
  // api_key_requests_denial_reason_shape).
  const denialReason = input.decision === "DENIED" ? reason : null;
  const now = deps.clock?.now() ?? new Date();

  const stepUpVerified = await preflightSelfApproval(deps, input, now);

  const outcome = await runApiKeyWrite(
    () =>
      deps.repos.tx(async (tx) => {
        const request = await tx.apiKeys.getRequest({
          requestId: input.requestId,
        });
        if (!request) throw apiKeyError("api_key_request_not_found");

        const right = await decideRight(
          {
            authz: deps.authz,
            repos: tx,
            platformOwnerEnvironment: deps.platformOwnerEnvironment,
          },
          input.actorHumanId,
          request,
        );
        if (right.kind === "none") {
          throw apiKeyError("api_key_request_not_found");
        }

        // Idempotent repeat: the same decider, the same decision.
        if (
          request.decidedAt !== null &&
          request.decision === input.decision &&
          request.decidedByHumanId === input.actorHumanId
        ) {
          return { request, changed: false } as const;
        }

        let selfApproved = false;
        if (right.kind === "visible_only") {
          throw apiKeyError(
            right.why === "own_request"
              ? "api_key_own_request"
              : "api_key_decide_not_allowed",
          );
        }
        if (right.kind === "self_approval") {
          if (input.decision !== "APPROVED") {
            // Your own pending request is withdrawn, not denied.
            throw apiKeyError("api_key_own_request");
          }
          assertSelfApprovalTerms(request);
          if (!stepUpVerified) {
            // Never approve your own request without a verified proof. The
            // pre-flight skipped it because the request was no longer
            // pending (or it moved since): say what changed; otherwise ask
            // for the step-up.
            throw apiKeyError(
              notPendingCode(deriveRequestStatus(request, now)) ??
                "api_key_step_up_required",
            );
          }
          selfApproved = true;
        }

        if (input.decision === "APPROVED") {
          // FR-002: the requester must still qualify at approval.
          const eligibility = await checkHolderEligibility(
            { authz: deps.authz, repos: tx },
            {
              humanId: request.requesterHumanId,
              subject: request.subject,
              orgId: request.orgId,
            },
          );
          if (!eligibility.eligible) {
            // No `why` for the approver: "inactive" would reveal a ban or a
            // suspension (security review, step 3).
            throw apiKeyError("api_key_requester_no_longer_eligible");
          }
        }

        const decided = await tx.apiKeys.decide({
          requestId: request.id,
          decision: input.decision,
          decidedByHumanId: input.actorHumanId,
          denialReason,
          selfApproved,
        });
        switch (decided.status) {
          case "not_found":
            throw apiKeyError("api_key_request_not_found");
          case "already_decided":
            throw apiKeyError("api_key_request_already_decided");
          case "withdrawn":
            throw apiKeyError(
              decided.request.withdrawalReason === "ACCOUNT_SECURITY"
                ? "api_key_request_closed_for_account_security"
                : "api_key_request_withdrawn",
            );
          case "lapsed":
            throw apiKeyError("api_key_request_lapsed");
          case "decided":
            break;
        }

        await tx.audit.log({
          entity: "api_key_request",
          entityId: decided.request.id,
          action:
            input.decision === "APPROVED"
              ? "api_key_request.approved"
              : "api_key_request.denied",
          data: {
            ...actorFields(input),
            ...requestSnapshot(decided.request),
            via: right.kind === "approver" ? right.via : "self_approval",
            denialReason,
          },
          at: decided.request.decidedAt ?? undefined,
        });
        return { request: decided.request, changed: true } as const;
      }),
    { useCase: USE_CASE, logger: deps.logger },
  );

  const request = outcome.request;
  if (outcome.changed && request.requesterHumanId !== input.actorHumanId) {
    await notifyRequester(deps, request);
  }

  return {
    requestId: request.id,
    status: deriveRequestStatus(request, now),
    selfApproved: request.selfApproved,
  };
}

/**
 * FR-003 with R30: a self-approved key is STAFF (checked by `decideRight`),
 * auto-renews, and its term is 2 to 30 days. The request is fixed once sent,
 * so a request that does not meet these terms is refused, not adjusted.
 */
function assertSelfApprovalTerms(request: ApiKeyRequestRecord): void {
  const days = request.expiryDays;
  if (
    !request.autoRenew ||
    days === null ||
    days < SELF_APPROVAL_MIN_TERM_DAYS ||
    days > SELF_APPROVAL_MAX_TERM_DAYS
  ) {
    throw apiKeyError("api_key_self_approval_terms", {
      minDays: SELF_APPROVAL_MIN_TERM_DAYS,
      maxDays: SELF_APPROVAL_MAX_TERM_DAYS,
    });
  }
}

/**
 * The platform owner's self-approval step-up, checked ONCE, before the
 * transaction: a deadlock retry of the transaction must not verify (and so
 * spend) the proof again. It runs after the cheap checks (decision, terms,
 * the requester's own eligibility), so a refused decision never spends a
 * proof. Returns whether a proof was verified for THIS request. The
 * transaction re-checks the right and the terms; the CAS settles races.
 *
 * Only the requester's own pending request can reach the step-up, so the
 * eligibility detail (`why`) here goes to the requester, not to an approver.
 */
async function preflightSelfApproval(
  deps: DecideApiKeyRequestDeps,
  input: {
    actorHumanId: string;
    requestId: string;
    decision: "APPROVED" | "DENIED";
    stepUpProof?: string | null;
  },
  now: Date,
): Promise<boolean> {
  if (input.decision !== "APPROVED") return false;
  const request = await deps.repos.apiKeys.getRequest({
    requestId: input.requestId,
  });
  if (
    !request ||
    request.requesterHumanId !== input.actorHumanId ||
    deriveRequestStatus(request, now) !== "pending"
  ) {
    return false;
  }
  const right = await decideRight(
    {
      authz: deps.authz,
      repos: deps.repos,
      platformOwnerEnvironment: deps.platformOwnerEnvironment,
    },
    input.actorHumanId,
    request,
  );
  if (right.kind !== "self_approval") return false;

  assertSelfApprovalTerms(request);
  const eligibility = await checkHolderEligibility(
    { authz: deps.authz, repos: deps.repos },
    {
      humanId: request.requesterHumanId,
      subject: request.subject,
      orgId: request.orgId,
    },
  );
  if (!eligibility.eligible) {
    throw apiKeyError("api_key_requester_no_longer_eligible", {
      why: eligibility.why,
    });
  }

  // FR-003: a password or passkey check within the last 5 minutes, bound to
  // this purpose and this request. Fails closed.
  if (!input.stepUpProof || !deps.stepUp) {
    throw apiKeyError("api_key_step_up_required");
  }
  const { verified } = await deps.stepUp.verifyFresh({
    humanId: input.actorHumanId,
    purpose: "api_key_self_approval",
    requestId: request.id,
    proof: input.stepUpProof,
    maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
  });
  if (!verified) throw apiKeyError("api_key_step_up_required");
  return true;
}

/** The refusal for a request that is no longer pending; null if it is. */
function notPendingCode(status: ApiKeyRequestStatus): ApiKeyErrorCode | null {
  switch (status) {
    case "pending":
      return null;
    case "lapsed":
      return "api_key_request_lapsed";
    case "withdrawn":
      return "api_key_request_withdrawn";
    case "closed_for_account_security":
      return "api_key_request_closed_for_account_security";
    case "denied":
    case "ready_to_collect":
    case "collect_lapsed":
    case "collected":
      return "api_key_request_already_decided";
  }
}

async function notifyRequester(
  deps: DecideApiKeyRequestDeps,
  request: ApiKeyRequestRecord,
): Promise<void> {
  const facts = {
    audience: { kind: "human", humanId: request.requesterHumanId },
    requestId: request.id,
    subject: request.subject,
    orgId: request.orgId,
    access: request.access,
    label: request.label,
  } as const;
  if (request.decision === "APPROVED" && request.decidedAt) {
    await sendApiKeyNotice(
      deps,
      {
        kind: "request_approved",
        ...facts,
        collectBy: addDays(request.decidedAt, COLLECT_WINDOW_DAYS),
      },
      USE_CASE,
    );
  } else if (request.decision === "DENIED" && request.denialReason) {
    await sendApiKeyNotice(
      deps,
      { kind: "request_denied", ...facts, denialReason: request.denialReason },
      USE_CASE,
    );
  }
}
