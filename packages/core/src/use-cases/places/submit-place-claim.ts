import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import {
  domainMatchesWebsite,
  domainMatchesWebsiteForward,
  emailDomain,
  isFreeEmailDomain,
  isUniqueViolation,
  ownerToPair,
  registrableDomainFromWebsite,
} from "./_shared/claim";
import { notifyAdminsOfClaim } from "./_shared/claim-notifications";
import { assertPlaceClaimable } from "./_shared/claim-eligibility";
import { z } from "zod";
import { fail } from "@th/errors";
import { verifyPlaceDocumentUploads } from "./_shared/verify-place-document-uploads";
import { markForSearchReindex } from "../search/search-reindex-marks";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 5;

/**
 * Anti-squatting cap (FR-004): how many OPEN ownership claims one person may
 * have filed at a time, counting claims for themselves and for any org alike.
 * Each open claim holds its place at PENDING, so the cap bounds how many
 * places one person can freeze.
 */
export const MAX_OPEN_CLAIMS_PER_ACTOR = 20;

const documentSchema = z.object({
  storageKey: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
});

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), humanId: z.string().uuid() }),
  z.object({ kind: z.literal("org"), orgId: z.string().uuid() }),
]);

const proofSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email_domain_match") }),
  z.object({ kind: z.literal("email_challenge"), challengeId: z.string().uuid() }),
  z.object({
    kind: z.literal("document"),
    documents: z.array(documentSchema).min(1).max(MAX_DOCUMENTS),
  }),
]);

export const submitPlaceClaimInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    owner: ownerSchema,
    proof: proofSchema,
    /** Client-supplied idempotency token (optional; a natural key backs it). */
    clientKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export const submitPlaceClaimOutputSchema = z
  .object({
    /** Null on the FR-010 fast-track (no admin request is created). */
    requestId: z.string().uuid().nullable(),
    ownershipId: z.string().uuid(),
    placeVerification: z.enum(["PENDING", "VERIFIED"]),
    /** True when the claim was auto-verified via the trusted-domain fast-track. */
    autoVerified: z.boolean(),
    proofKind: z.enum(["email_domain_match", "email_challenge", "document"]),
    /**
     * How many published, upcoming COMMUNITY listings already name this place
     * (community-listings-at-claimed-venues FR-005/FR-007).
     *
     * IT RIDES BACK ON THE CLAIM BECAUSE THE CLAIMANT CANNOT ASK FOR IT.
     * `getPlaceForEdit` — the other home of this number — gates on
     * `humanIdsWithAccess`, which is built from VERIFIED unrevoked ownerships
     * only. A provisional claimant is not in that set, so on the pending path
     * they would get NOT_RESOURCE_OWNER. Returning it here is one read at the
     * moment the claim is made, on a place the caller has just proven a claim
     * to, and it opens no new authz surface.
     *
     * A DELIBERATE SWALLOW: degrades to 0 rather than failing a committed
     * claim (see `countCommunityListingsSafe`). Zero is the honest floor and
     * the true answer for almost every place until the `placeId` backfill runs.
     */
    /**
     * `.default(0)` IS DEPLOY SAFETY, not laziness. The replay path parses a
     * STORED idempotency payload through this schema, and every record written
     * before this field existed lacks it — so a required field would throw on
     * the first replay of any claim that was in flight across the deploy. The
     * claimant would see an error for a claim that had already succeeded.
     * Defaulting to 0 degrades that replay to "don't ask", which is the same
     * thing an honest count would do for almost every venue today.
     */
    communityListingCount: z.number().int().nonnegative().default(0),
  })
  .strict();

/**
 * What transport puts on the wire. Deliberately NOT `.strict()`: a stored
 * idempotency record written while the output still carried
 * `notificationIntents` (the unparked notice, removed with parking in the
 * 2026-09-25 amendment) must still parse, with the stale key stripped.
 */
export const submitPlaceClaimWireOutputSchema = z.object(
  submitPlaceClaimOutputSchema.shape,
);

export type SubmitPlaceClaimInput = z.infer<typeof submitPlaceClaimInputSchema>;
export type SubmitPlaceClaimOutput = z.infer<
  typeof submitPlaceClaimOutputSchema
>;
export type SubmitPlaceClaimWireOutput = z.infer<
  typeof submitPlaceClaimWireOutputSchema
>;

export type SubmitPlaceClaimDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "places"
    | "placeVerificationRequests"
    | "placeVerificationDocuments"
    | "placeClaimEmailChallenges"
    | "humans"
    | "audit"
    | "authz"
    | "notifications"
    // FR-005/FR-007: the "what am I being asked to accept?" count, returned
    // with the claim result so the success screen can be concrete.
    | "events"
  >;
  authz: Pick<AuthZPort, "hasOrgRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter (repo error convention): the FR-007 community
   * listing count degrades to 0 rather than failing a committed claim, and
   * that swallow MUST be visible in Sentry.
   */
  reportError?: ReporterPort;
  /**
   * HEADs each newly submitted document: key must be this place's, the object
   * must exist, and be no bigger than declared (F11).
   */
  storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
};

/**
 * Self-serve "claim this venue". A signed-in human (for themselves) or an org
 * admin (for their org) claims an unclaimed Place. On a passing proof we, in a
 * single transaction, create a PROVISIONAL PlaceOwnership (verified=false — no
 * edit access), set Place.verification=PENDING, and open an OWNERSHIP_CLAIM
 * request into the platform admin queue. The FR-010 trusted-domain fast-track
 * auto-verifies in one motion and skips the queue.
 *
 * Idempotent per (placeId, ownerType, ownerId). Mirrors submit-place-verification
 * but for NON-owners and supports a HUMAN claimant.
 */
export async function submitPlaceClaim(
  deps: SubmitPlaceClaimDeps,
  rawInput: unknown,
): Promise<SubmitPlaceClaimOutput> {
  const logger = deps.logger?.child({ useCase: "submitPlaceClaim" });

  const execute = async () => {
    const input = parseInput(submitPlaceClaimInputSchema, rawInput);
    const { ownerType, ownerId } = ownerToPair(input.owner);

    // ── Authorize the owner identity ────────────────────────────────────────
    if (input.owner.kind === "human") {
      // A human may only claim FOR THEMSELVES.
      if (input.owner.humanId !== input.actorHumanId) {
        throw fail("HUMAN_MISMATCH");
      }
    } else {
      const perm = await deps.authz.hasOrgRole({
        actorHumanId: input.actorHumanId,
        orgId: input.owner.orgId,
        requiredRoles: [...ORG_ADMIN_ROLES],
      });
      if (!perm.allowed) {
        throw fail("INSUFFICIENT_ROLE");
      }
    }

    // ── Idempotency (natural key on the claim target) ───────────────────────
    const idemKey = `place_claim:${input.placeId}:${ownerType}:${ownerId}`;
    const acquired = await deps.idempotency.begin(idemKey, 60);
    if (!acquired) {
      const prior =
        await deps.idempotency.get<SubmitPlaceClaimWireOutput>(idemKey);
      if (prior) {
        // The stored result is the WIRE shape (see the commit below); parsed
        // through it so a record from before the 2026-09-25 amendment drops
        // its stale `notificationIntents`.
        return submitPlaceClaimOutputSchema.parse(
          submitPlaceClaimWireOutputSchema.parse(prior),
        );
      }
      throw fail("CLAIM_ALREADY_PENDING");
    }

    try {
      const result = await runClaim(deps, input, {
        ownerType,
        ownerId,
        logger,
      });
      // Store the WIRE shape: a replay returns exactly what went out.
      await deps.idempotency.commit(
        idemKey,
        submitPlaceClaimWireOutputSchema.parse(result),
        300,
      );
      return result;
    } catch (err) {
      await deps.idempotency.fail(idemKey, String(err), 30);
      throw err;
    }
  };

  if (logger) {
    return logger.withTime("submitPlaceClaim", execute);
  }
  return execute();
}

/**
 * FR-007's count as a DELIBERATE SWALLOW (repo error convention): the number
 * makes the consent question concrete, but it is decorative relative to the
 * claim itself. A failed count must never fail a claim that has already
 * committed — the claimant would see an error for a claim that succeeded.
 * Degrades to 0 and reports; the log/report pair is guarded so a throwing
 * logger or reporter cannot convert a degraded read into a failed one.
 */
async function countCommunityListingsSafe(
  deps: SubmitPlaceClaimDeps,
  placeId: string,
  now: Date,
): Promise<number> {
  try {
    return await deps.repos.events.countCommunityListingsAtPlace({
      placeId,
      now,
    });
  } catch (err) {
    try {
      deps.logger?.error?.("places.claim_community_listing_count_failed", {
        err,
        placeId,
      });
      deps.reportError?.(err, {
        tags: { useCase: "submitPlaceClaim", step: "countCommunityListings" },
        extra: { placeId },
      });
    } catch {
      // Intentionally empty — see above.
    }
    return 0;
  }
}

async function runClaim(
  deps: SubmitPlaceClaimDeps,
  input: SubmitPlaceClaimInput,
  ctx: {
    ownerType: "HUMAN" | "ORGANIZATION";
    ownerId: string;
    logger?: LoggerPort;
  },
): Promise<SubmitPlaceClaimOutput> {
  const { ownerType, ownerId } = ctx;

  // ── Claimable gating (FR-001 / FR-008 / FR-009) ───────────────────────────
  // Shared predicate — identical to the doc-upload presign + CTA eligibility.
  const place = await assertPlaceClaimable(deps, input.placeId);

  // ── Anti-squatting cap (FR-004), early refusal ────────────────────────────
  // Open claims FILED BY the actor, whoever they claimed for: an org admin
  // filing for an org is capped the same as a person filing for themselves.
  // Checked here so a capped actor is refused before any proof work; the
  // provisional path re-checks under the actor lock, which is the binding one.
  // This also refuses a fast-track claim, which opens no claim of its own: a
  // person holding 20 open claims finishes some before claiming more.
  await assertUnderOpenClaimCap(deps.repos, input.actorHumanId);

  // ── Validate the chosen proof + decide fast-track ─────────────────────────
  const now = deps.clock.now();
  let proofMeta: Record<string, unknown>;
  let autoVerify = false;
  const uploadedDocs =
    input.proof.kind === "document" ? input.proof.documents : [];

  if (input.proof.kind === "email_domain_match") {
    const websiteDom = registrableDomainFromWebsite(place.website);
    if (!websiteDom) {
      throw fail("CLAIM_PLACE_HAS_NO_WEBSITE");
    }
    if (isFreeEmailDomain(websiteDom)) {
      throw fail("CLAIM_FREE_EMAIL_NOT_ALLOWED");
    }
    const identity = await deps.repos.humans.getByIdWithIdentity(
      input.actorHumanId,
    );
    if (!identity) {
      throw fail("PLACE_NOT_FOUND", { meta: { role: "claimant_identity" } });
    }
    if (!identity.identity.emailVerified) {
      throw fail("EMAIL_NOT_VERIFIED");
    }
    const claimantDom = emailDomain(identity.identity.email);
    if (!claimantDom) {
      throw fail("CLAIM_EMAIL_DOMAIN_MISMATCH");
    }
    if (isFreeEmailDomain(claimantDom)) {
      throw fail("CLAIM_FREE_EMAIL_NOT_ALLOWED");
    }
    if (!domainMatchesWebsite(claimantDom, websiteDom)) {
      throw fail("CLAIM_EMAIL_DOMAIN_MISMATCH");
    }
    // FR-010 fast-track: only when the website provenance is a trusted import
    // AND the match is forward-direction (email at/under the website domain).
    // A loose reverse match still passes as a provisional claim above, but is
    // never auto-verified without an admin.
    autoVerify =
      place.websiteSource === "TRUSTED_IMPORT" &&
      domainMatchesWebsiteForward(claimantDom, websiteDom);
    proofMeta = {
      kind: "email_domain_match",
      claimantEmailDomain: claimantDom,
      websiteDomain: websiteDom,
      websiteSource: place.websiteSource,
      autoVerified: autoVerify,
    };
  } else if (input.proof.kind === "email_challenge") {
    const challenge = await deps.repos.placeClaimEmailChallenges.getById(
      input.proof.challengeId,
    );
    if (
      !challenge ||
      challenge.placeId !== input.placeId ||
      challenge.humanId !== input.actorHumanId
    ) {
      throw fail("CLAIM_CHALLENGE_NOT_FOUND");
    }
    if (!challenge.verifiedAt) {
      throw fail("CLAIM_CHALLENGE_NOT_VERIFIED");
    }
    // A challenge only ever yields a provisional claim (admin backstop).
    proofMeta = {
      kind: "email_challenge",
      email: challenge.email,
      challengeId: challenge.id,
    };
  } else {
    // document proof — always provisional + admin-reviewed.
    await verifyPlaceDocumentUploads(
      {
        storage: deps.storage,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        placeId: input.placeId,
        documents: uploadedDocs,
        context: "submitPlaceClaim",
      },
    );
    proofMeta = {
      kind: "document",
      documentCount: uploadedDocs.length,
    };
  }

  // ── Fast-track: auto-verify in one motion, no admin queue (FR-010) ────────
  if (autoVerify) {
    const ownershipId = await deps.repos.tx(
      async (tx) => {
      // Serialize concurrent fast-track claimants of the SAME place. Co-ownership
      // is allowed (a place may have several verified owners), so a "one verified
      // owner" unique index can't guard this — an advisory lock does. Held until
      // this tx commits/rolls back; the next waiter then sees the committed owner.
      await tx.places.lockPlaceForClaim(input.placeId);

      // Re-check UNDER the lock: if a competing claim verified an owner while we
      // waited, bail with the friendly collision error (rolls the tx back).
      const raced = await tx.places.getVerifiedOwnershipForPlace(input.placeId);
      if (raced) {
        throw fail("PLACE_ALREADY_CLAIMED");
      }
      const lockedPlace = await readClaimablePlaceUnderLock(tx, input.placeId);

      const ownership = await tx.places.createProvisionalOwnership({
        placeId: input.placeId,
        ownerType,
        ownerId,
        proof: proofMeta,
      });
      await tx.places.verifyOwnership({
        ownershipId: ownership.id,
        reviewerHumanId: null, // SYSTEM auto-verify
        reviewedAt: now,
      });
      await setClaimVerification(tx, lockedPlace, "VERIFIED");
      // A verified place is listed. `changed: false` only means it already
      // was, which is the outcome asked for (and leaves no listing audit).
      const { changed: listed } = await tx.places.setDirectoryListing({
        placeId: input.placeId,
        listedInDirectory: true,
      });
      if (listed) {
        // Same action and data shape setPlaceDirectoryListing writes.
        await tx.audit.log({
          entity: "place",
          entityId: input.placeId,
          action: "place.directory_listed",
          data: {
            previous: false,
            next: true,
            reason: "claim_autoverified",
            actorHumanId: input.actorHumanId,
          },
          at: now,
        });
      }
      // verification and listed_in_directory are on the search document.
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], now);
      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.ownership_claim_autoverified",
        data: {
          placeId: input.placeId,
          ownershipId: ownership.id,
          ownerType,
          ownerId,
          claimantHumanId: input.actorHumanId,
          proof: proofMeta,
        },
        at: now,
      });

      return ownership.id;
      },
    );

    return submitPlaceClaimOutputSchema.parse({
      requestId: null,
      ownershipId,
      placeVerification: "VERIFIED",
      autoVerified: true,
      proofKind: input.proof.kind,
      communityListingCount: await countCommunityListingsSafe(
        deps,
        input.placeId,
        now,
      ),
    });
  }

  // ── Provisional path: create claim + open admin request ───────────────────
  let ownershipId: string;
  let requestId: string;
  try {
    const created = await deps.repos.tx(async (tx) => {
      // Serialize this person's claim submissions and re-count under the
      // lock: the count above was read outside any transaction, so two
      // parallel submits at 19 would both have passed it. Taken before the
      // place lock (the one order every caller uses).
      await tx.places.lockClaimsByActor(input.actorHumanId);
      await assertUnderOpenClaimCap(tx, input.actorHumanId);

      // The same lock the fast-track takes (and the community-moderator
      // edit / archive / restore): the claimable check and the
      // verification CAS's `from` come from a read taken under it.
      await tx.places.lockPlaceForClaim(input.placeId);
      const lockedPlace = await readClaimablePlaceUnderLock(tx, input.placeId);
      const ownership = await tx.places.createProvisionalOwnership({
        placeId: input.placeId,
        ownerType,
        ownerId,
        proof: proofMeta,
      });

      await setClaimVerification(tx, lockedPlace, "PENDING");
      // verification is on the place's search document.
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], now);

      const request = await tx.placeVerificationRequests.create({
        placeId: input.placeId,
        orgId: input.owner.kind === "org" ? input.owner.orgId : null,
        submittedById: input.actorHumanId,
        source: "OWNERSHIP_CLAIM",
        claimantHumanId: input.actorHumanId,
        claimOwnerType: ownerType,
        claimOwnerId: ownerId,
        ownershipId: ownership.id,
      });

      if (uploadedDocs.length > 0) {
        await tx.placeVerificationDocuments.createMany({
          requestId: request.id,
          documents: uploadedDocs.map((d) => ({
            storageKey: d.storageKey,
            fileName: d.fileName,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
          })),
        });
      }

      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.ownership_claim_submitted",
        data: {
          placeId: input.placeId,
          requestId: request.id,
          ownershipId: ownership.id,
          ownerType,
          ownerId,
          claimantHumanId: input.actorHumanId,
          proof: proofMeta,
        },
        at: now,
      });

      return { ownershipId: ownership.id, requestId: request.id };
    });
    ownershipId = created.ownershipId;
    requestId = created.requestId;
  } catch (err) {
    // Lost a race to the "one active OWNERSHIP_CLAIM per place" partial-unique
    // index (place_verification_request_one_active_claim). The tx rolled back
    // (no double claim); map to the friendly conflict for the losing claimant.
    if (isUniqueViolation(err)) {
      throw fail("CLAIM_ALREADY_PENDING");
    }
    throw err;
  }

  // Best-effort, post-commit: notify platform admins a claim is waiting.
  await notifyAdminsOfClaim(deps, {
    placeId: input.placeId,
    placeName: place.name,
    requestId,
    source: "OWNERSHIP_CLAIM",
  });

  return submitPlaceClaimOutputSchema.parse({
    requestId,
    ownershipId,
    placeVerification: "PENDING",
    autoVerified: false,
    proofKind: input.proof.kind,
    communityListingCount: await countCommunityListingsSafe(
      deps,
      input.placeId,
      now,
    ),
  });
}

async function assertUnderOpenClaimCap(
  repos: Pick<Repos, "placeVerificationRequests">,
  actorHumanId: string,
) {
  const open =
    await repos.placeVerificationRequests.countOpenClaimsByClaimant(
      actorHumanId,
    );
  if (open >= MAX_OPEN_CLAIMS_PER_ACTOR) {
    throw fail("CLAIM_LIMIT_REACHED");
  }
}

/**
 * The place as it is NOW, read inside the claim's transaction after
 * `lockPlaceForClaim`. `assertPlaceClaimable` ran before the transaction
 * (and before the document checks), so its refusals are repeated here on the
 * fresh row, same codes: a place archived or suspended meanwhile is
 * PLACE_NOT_CLAIMABLE, one a staff waive verified meanwhile is
 * PLACE_ALREADY_CLAIMED, one another claim made PENDING is
 * CLAIM_ALREADY_PENDING. What survives is UNVERIFIED or REJECTED, and that
 * status is the `from` of the claim's CAS.
 */
async function readClaimablePlaceUnderLock(
  tx: Pick<Repos, "places">,
  placeId: string,
) {
  const place = await tx.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Only an ACTIVE place is claimable here: one archived OR suspended while
  // the claim waited for the lock is refused, never written back.
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_CLAIMABLE");
  }
  // The verification half of assertPlaceClaimable, in its order. Without it
  // the CAS below would take a VERIFIED `from` and demote the place to
  // PENDING, or hand it to this claimant on the fast-track.
  if (place.verificationStatus === "VERIFIED") {
    throw fail("PLACE_ALREADY_CLAIMED");
  }
  if (place.verificationStatus === "PENDING") {
    throw fail("CLAIM_ALREADY_PENDING");
  }
  return place;
}

/**
 * The claim changes the place's `verification` column and nothing else
 * (the fast-track also lists it, through `setDirectoryListing`). It used to
 * rebuild the whole row through `places.upsert`, which wrote a NULL
 * `addrLine1` / `country` back as "" (an ownerless community place can have
 * neither) and rewrote name, address, pin and status from a read. Now one
 * column moves, compare-and-set on the status read under the claim lock
 * (UNVERIFIED or REJECTED: `readClaimablePlaceUnderLock` refused the rest).
 *
 * A lost CAS means a writer that skips the claim lock (a settings toggle
 * that still rebuilds the whole row through `places.upsert`, or the place
 * editor, which writes verification back from its read) moved the row
 * between that read and this write. The row is re-checked as claimable: VERIFIED,
 * PENDING or no longer ACTIVE is refused with the same code a claim arriving
 * now would get, never accepted as "already there". A row still claimable
 * moved between UNVERIFIED and REJECTED: CONFLICT. Either way the claim
 * rolls back (CONFLICT shows the "refresh and try again" copy).
 */
async function setClaimVerification(
  tx: Pick<Repos, "places">,
  lockedPlace: NonNullable<Awaited<ReturnType<Repos["places"]["getById"]>>>,
  to: "PENDING" | "VERIFIED",
) {
  const { changed } = await tx.places.setVerificationStatus({
    placeId: lockedPlace.id,
    from: lockedPlace.verificationStatus,
    to,
  });
  if (changed) return;
  // Throws PLACE_NOT_FOUND / PLACE_NOT_CLAIMABLE / PLACE_ALREADY_CLAIMED /
  // CLAIM_ALREADY_PENDING for a row that is no longer claimable.
  await readClaimablePlaceUnderLock(tx, lockedPlace.id);
  throw fail("CONFLICT", {
    meta: {
      reason: "place_verification_changed",
      placeId: lockedPlace.id,
      expected: lockedPlace.verificationStatus,
    },
  });
}
