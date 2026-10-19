import { createHash } from "node:crypto";
import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PlaceRecord,
  PlaceVerificationStatus,
  Repos,
} from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import { getPlaceVerificationEligibility } from "./place-verification-eligibility";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";

const PLACE_VERIFICATION_STATUS_VALUES = [
  "UNVERIFIED",
  "VERIFIED",
  "PENDING",
  "REJECTED",
] as const satisfies readonly PlaceVerificationStatus[];

/**
 * Why the status was set directly, recorded on the audit row so a reader can
 * tell a routine staff flip apart from a deliberate skip of document review.
 *
 * `WAIVED_DOCUMENT_REVIEW` backs the platform "Waive verification" action:
 * the status transition is identical to a plain staff verify, so without this
 * discriminator the two are indistinguishable in `audit_log`. Deliberately a
 * value, not an identifier — `place-waivers.ts` in this same folder is an
 * unrelated concept (venue liability waivers shown at checkout) and no code
 * symbol here is named "waive".
 */
const VERIFICATION_STATUS_REASONS = [
  "STAFF_DIRECT",
  "WAIVED_DOCUMENT_REVIEW",
] as const;

export type VerificationStatusReason =
  (typeof VERIFICATION_STATUS_REASONS)[number];

export const updatePlaceVerificationStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    verificationStatus: z.enum(PLACE_VERIFICATION_STATUS_VALUES),
    clientKey: z.string().min(8),
    /** Machine-readable discriminator for the audit row. Optional: legacy
     *  callers omit it and the audit payload keeps its previous shape. */
    reason: z.enum(VERIFICATION_STATUS_REASONS).optional(),
    /** Optional free-text justification. Sanitized BEFORE the length bound. */
    note: plainTextOptional(280).optional(),
  })
  .strict();

export const updatePlaceVerificationStatusOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    verificationStatus: z.enum(PLACE_VERIFICATION_STATUS_VALUES),
  })
  .strict();

export type UpdatePlaceVerificationStatusInput = z.infer<
  typeof updatePlaceVerificationStatusInputSchema
>;
export type UpdatePlaceVerificationStatusOutput = z.infer<
  typeof updatePlaceVerificationStatusOutputSchema
>;

export type UpdatePlaceVerificationStatusDeps = {
  repos: Repos;
  authz?: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

type StoredUpdatePlaceVerificationStatusRecord = {
  payloadHash: string;
  response: UpdatePlaceVerificationStatusOutput;
};

const STAFF_VERIFIER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

export async function updatePlaceVerificationStatus(
  deps: UpdatePlaceVerificationStatusDeps,
  rawInput: unknown,
): Promise<UpdatePlaceVerificationStatusOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "updatePlaceVerificationStatus",
  });

  const execute = async () => {
    const input = parseInput(
      updatePlaceVerificationStatusInputSchema,
      rawInput,
    );
    return handleUpdatePlaceVerificationStatus(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updatePlaceVerificationStatus", execute);
  }

  return execute();
}

async function handleUpdatePlaceVerificationStatus(
  deps: UpdatePlaceVerificationStatusDeps,
  logger: LoggerPort | undefined,
  input: UpdatePlaceVerificationStatusInput,
): Promise<UpdatePlaceVerificationStatusOutput> {
  const existing = await deps.repos.places.getById(input.placeId);
  if (!existing) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Resolved ONCE and threaded through every downstream decision. Previously
  // this was two independent `hasStaffRole` calls (one inside
  // `ensureActorIsPrivilegedForPlace`, one in the PENDING branch below), which
  // made "is this actor staff?" easy to answer inconsistently in a third
  // place. There is now exactly one source of truth.
  const isStaffVerifier = await actorIsStaffVerifier(
    deps.authz,
    input.actorHumanId,
  );

  await ensureActorIsPrivilegedForPlace(
    deps.repos,
    isStaffVerifier,
    input.actorHumanId,
    existing,
  );

  // When a non-staff actor submits for verification, enforce completeness.
  // Staff (ADMIN/REVIEWER) can bypass this — they set VERIFIED/REJECTED directly.
  if (input.verificationStatus === "PENDING" && !isStaffVerifier) {
    const eligibility = getPlaceVerificationEligibility({
      name: existing.name,
      addressLine1: existing.addressLine1,
      city: existing.city,
      countryCode: existing.countryCode,
      orgIdsWithAccess: existing.orgIdsWithAccess,
      humanIdsWithAccess: existing.humanIdsWithAccess,
    });

    if (!eligibility.eligible) {
      throw {
        code: "invalid_input",
        message: "place_not_eligible_for_verification",
        details: eligibility.reasons,
      } as const;
    }
  }

  if (existing.verificationStatus === input.verificationStatus) {
    return updatePlaceVerificationStatusOutputSchema.parse({
      placeId: existing.id,
      verificationStatus: existing.verificationStatus,
    });
  }

  // ── Open-request guard ────────────────────────────────────────────────
  //
  // This use case ONLY flips `Place.verification` + writes one audit row. It
  // deliberately does not touch `PlaceVerificationRequest`, ownership rows,
  // uploaded documents or `listedInDirectory` — all of which
  // `reviewPlaceVerification` owns.
  //
  // So driving a place to a TERMINAL verification state while a request is
  // still PENDING/IN_REVIEW orphans that request: it stays in the platform
  // queue (`getPlatformVerificationQueue` filters on REQUEST status, not on
  // `Place.verification`), and the next reviewer's Approve/Reject overwrites
  // the decision that was just made here — silently reverting a staff waive,
  // or granting verified ownership + a directory listing on the strength of
  // documents nobody read.
  //
  // Fail closed and steer staff to the real Acknowledge → Approve/Reject
  // path. Enforced HERE rather than in the UI so a raw API call can't reach
  // the state either.
  //
  // Scoped to VERIFIED/REJECTED on purpose: setting PENDING is the org-side
  // submit path and UNVERIFIED is a reset, neither of which pre-empts a
  // decision. Placed AFTER the no-op early return above so a genuinely
  // idempotent re-send keeps returning cleanly rather than newly throwing.
  const isTerminalDecision =
    input.verificationStatus === "VERIFIED" ||
    input.verificationStatus === "REJECTED";

  // ── Terminal decisions are STAFF-ONLY ─────────────────────────────────
  //
  // `ensureActorIsPrivilegedForPlace` above answers a narrower question than
  // it looks like it does: "may this actor touch this place's verification
  // state at all?" It says yes for any ORG_ADMIN_ROLES member of an owning
  // org — which is correct for the org-side submit (`PENDING`) and reset
  // (`UNVERIFIED`) transitions, and catastrophically wrong for the terminal
  // ones. Without this guard an org owner could POST
  // `{ verificationStatus: "VERIFIED" }` and mint their own verified badge
  // with no document ever reviewed. That badge is not cosmetic: it unlocks
  // directory visibility (`listAccessibleByHuman`) and is the precondition
  // `set-place-booking-acceptance.ts` requires before booking can be enabled.
  //
  // Enforced HERE, in the use case, and NOT only by narrowing a transport
  // input schema, so the guarantee survives any future transport — the
  // org-side tRPC procedure that used to reach this path has been deleted,
  // but nothing stops someone adding another one tomorrow.
  //
  // Reuses `INSUFFICIENT_ROLE` (already this path's authorization-refusal
  // code, already FORBIDDEN-mapped and already carrying en+es copy) rather
  // than minting a new catalogue entry for a defense-in-depth branch that no
  // shipped transport can currently reach.
  //
  // Placed AFTER the unchanged-status early return, matching the
  // open-request guard below: re-asserting the status a place ALREADY has
  // writes nothing and escalates nothing, so it stays a clean no-op.
  if (isTerminalDecision && !isStaffVerifier) {
    throw fail("INSUFFICIENT_ROLE");
  }

  // Fast refusal before any claim; re-checked under the claim lock in the tx.
  if (isTerminalDecision) {
    const openRequest = await findOpenVerificationRequest(
      deps.repos.placeVerificationRequests,
      existing.id,
    );
    if (openRequest) {
      throw fail("VERIFICATION_REQUEST_IN_PROGRESS");
    }
  }

  // Sanitization already ran in the schema; an all-whitespace/markup note
  // cleans down to "" and is treated as absent rather than stored empty.
  const note = input.note?.trim() ? input.note.trim() : undefined;

  // ── What the idempotency key does and does NOT protect ────────────────
  //
  // Every shipped client mints `clientKey` fresh per click
  // (`buildFreshClientKey()` → `crypto.randomUUID()`), so two rapid clicks
  // produce two DIFFERENT keys and this record never collides. The key
  // therefore provides NO double-submit protection here — it only makes a
  // literal retry of the SAME request (same key, e.g. a network-level replay)
  // safe, and turns a same-key-different-payload send into a loud conflict
  // instead of a silent second write.
  //
  // Double-submit is guarded by the UI (`disabled` while the mutation is
  // pending) plus the `existing.verificationStatus === input.verificationStatus`
  // early return above, which makes a second successful flip a no-op. Do not
  // assume this key is the guard.
  //
  // `reason`/`note` are folded into the hash for that same-key-replay case;
  // there is no legitimate retry-with-edited-note flow, so widening the hash
  // costs nothing.
  const payloadHash = buildPayloadHash({
    placeId: input.placeId,
    verificationStatus: input.verificationStatus,
    reason: input.reason,
    note,
  });
  const idemKey = buildIdempotencyKey(input.placeId, input.clientKey);

  const replay =
    await deps.idempotency.get<StoredUpdatePlaceVerificationStatusRecord>(
      idemKey,
    );
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const claimed = await deps.idempotency.begin(idemKey, 300);
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredUpdatePlaceVerificationStatusRecord>(
        idemKey,
      );
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const at = deps.clock.now();
    await deps.repos.tx(async (tx) => {
      // The claim lock serialises this with claim submit and verification
      // review, which take it too; under it, the open-request guard above is
      // re-checked, so a request filed between that read and here is caught.
      await tx.places.lockPlaceForClaim(existing.id);
      if (isTerminalDecision) {
        const openRequest = await findOpenVerificationRequest(
          tx.placeVerificationRequests,
          existing.id,
        );
        if (openRequest) {
          throw fail("VERIFICATION_REQUEST_IN_PROGRESS");
        }
      }

      // Compare-and-set of `verification` alone. Rebuilding the row from
      // `existing` (read before this transaction) would overwrite a
      // moderator's concurrent name/address/pin edit; the CAS on `from`
      // keeps the audit's `from` true.
      const { changed } = await tx.places.setVerificationStatus({
        placeId: existing.id,
        from: existing.verificationStatus,
        to: input.verificationStatus,
      });
      if (!changed) {
        // The status moved since the read. Re-read under the lock: already
        // at the target is the same outcome this call asked for (a no-op,
        // like the early return above: no audit row, no mark). Anything else
        // is refused, never written over. No custom `message`, so the wire
        // message is the code and the web shows the `errors.conflict` copy.
        const current = await tx.places.getById(existing.id);
        if (current?.verificationStatus === input.verificationStatus) {
          return;
        }
        throw fail("CONFLICT", {
          meta: {
            reason: "place_verification_changed",
            placeId: existing.id,
            expected: existing.verificationStatus,
          },
        });
      }

      await tx.audit.log({
        entity: "place",
        entityId: existing.id,
        action: "verification_status_updated",
        data: {
          actorHumanId: input.actorHumanId,
          from: existing.verificationStatus,
          to: input.verificationStatus,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(note ? { note } : {}),
        },
        at,
      });

      // The place's search document shows its status/verification (a
      // non-ACTIVE place is removed from search by the reindex).
      await markForSearchReindex(tx, [{ kind: "place", id: existing.id }], at);
    });

    const response = updatePlaceVerificationStatusOutputSchema.parse({
      placeId: existing.id,
      verificationStatus: input.verificationStatus,
    });

    logger?.info("places.update_verification_status", {
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
      from: existing.verificationStatus,
      to: response.verificationStatus,
    });

    await deps.idempotency.commit<StoredUpdatePlaceVerificationStatusRecord>(
      idemKey,
      { payloadHash, response },
    );
    return response;
  } catch (error) {
    await deps.idempotency.fail(idemKey, describeError(error));
    throw asKnownError("update_place_verification_status", error);
  }
}

/**
 * Single source of truth for "is this actor an ADMIN/REVIEWER verifier?".
 *
 * Fails CLOSED when `authz` is absent: a composition root that forgets to
 * wire the port gets a non-staff actor, never an implicitly-trusted one.
 */
async function actorIsStaffVerifier(
  authz: Pick<AuthZPort, "hasStaffRole"> | undefined,
  actorHumanId: string,
): Promise<boolean> {
  if (!authz) return false;
  const staffCheck = await authz.hasStaffRole({
    actorHumanId,
    requiredRoles: [...STAFF_VERIFIER_ROLES],
  });
  return staffCheck.allowed;
}

/**
 * "May this actor touch this place's verification state AT ALL?" — a
 * deliberately weaker question than "may this actor DECIDE it". Org admins
 * clear this gate so they can submit (`PENDING`) / reset (`UNVERIFIED`); the
 * terminal-decision guard in the caller is what keeps them out of
 * `VERIFIED`/`REJECTED`. Do not treat clearing this as authorization to
 * write a trust state.
 */
async function ensureActorIsPrivilegedForPlace(
  repos: Repos,
  isStaffVerifier: boolean,
  actorHumanId: string,
  place: PlaceRecord,
): Promise<void> {
  // 1) Staff with elevated roles can verify any place
  if (isStaffVerifier) return;

  // 2) Fall back to org-based governance.
  // A personal place can exist, but it can't be marked VERIFIED via this admin tool.
  const orgIds = place.orgIdsWithAccess;
  if (!orgIds.length) {
    throw fail("VERIFICATION_REQUIRES_ORG_OWNER");
  }

  const memberships = await repos.authz.getOrgMemberships({
    orgIds,
    humanId: actorHumanId,
  });

  const isPrivileged = memberships.some((m) =>
    (ORG_ADMIN_ROLES as readonly string[]).includes(m.role),
  );
  if (!isPrivileged) {
    throw fail("INSUFFICIENT_ROLE");
  }
}

function buildIdempotencyKey(placeId: string, clientKey: string): string {
  return `places.update-verification.${placeId}.${clientKey}`;
}

function buildPayloadHash(input: {
  placeId: string;
  verificationStatus: PlaceVerificationStatus;
  reason?: VerificationStatusReason;
  note?: string;
}): string {
  // `JSON.stringify` drops undefined members, so a caller that omits
  // reason/note hashes byte-identically to the pre-reason shape — an
  // in-flight idempotency record written by the old code still replays.
  const payload = JSON.stringify({
    placeId: input.placeId,
    verificationStatus: input.verificationStatus,
    reason: input.reason,
    note: input.note,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The open (PENDING / IN_REVIEW) request a terminal staff decision must not
 * pre-empt: an org's verification submission OR an ownership claim.
 * `getActiveForPlace` returns ORG_SUBMISSION rows only, so with it alone an
 * open claim did not trip the guard: staff could set VERIFIED under a
 * pending claim, and rejecting that claim later demoted the staff-verified
 * place. The claim is refused the same way, with the same code; staff decide
 * it through the review queue instead.
 */
async function findOpenVerificationRequest(
  requests: Pick<
    Repos["placeVerificationRequests"],
    "getActiveForPlace" | "getActiveClaimForPlace"
  >,
  placeId: string,
) {
  return (
    (await requests.getActiveForPlace(placeId)) ??
    (await requests.getActiveClaimForPlace(placeId))
  );
}
