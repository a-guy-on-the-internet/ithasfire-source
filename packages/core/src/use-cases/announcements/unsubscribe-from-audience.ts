import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput, describeError } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribe input supports two audience kinds:
 * - **contact_list**: uses `listId` to look up an InviteListEntry.
 * - **waitlist**: uses `eventId` to look up an EventWaitlistEntry and set status to DROPPED.
 */
export const unsubscribeFromAudienceInputSchema = z
  .object({
    /** Discriminator for the audience kind being unsubscribed from. */
    kind: z.enum(["contact_list", "waitlist"]).default("contact_list"),
    /** The invite list to unsubscribe from (contact_list kind). */
    listId: z.string().uuid().optional(),
    /** The event whose waitlist the recipient is on (waitlist kind). */
    eventId: z.string().uuid().optional(),
    /** The email address to unsubscribe. */
    email: z.string().email(),
    /** HMAC token for verifying the request. */
    token: z.string().min(1),
  })
  .strict()
  .refine(
    (d) => {
      if (d.kind === "contact_list") return !!d.listId;
      if (d.kind === "waitlist") return !!d.eventId;
      return false;
    },
    {
      message:
        "listId is required for contact_list; eventId is required for waitlist",
    },
  );

export const unsubscribeFromAudienceOutputSchema = z.object({
  ok: z.literal(true),
});

export type UnsubscribeFromAudienceInput = z.infer<
  typeof unsubscribeFromAudienceInputSchema
>;
export type UnsubscribeFromAudienceOutput = z.infer<
  typeof unsubscribeFromAudienceOutputSchema
>;

export type UnsubscribeFromAudienceDeps = {
  repos: Repos;
  clock: ClockPort;
  logger: LoggerPort;
  /** HMAC secret for verifying unsubscribe tokens. */
  unsubscribeSecret: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers (shared between use case and email generation)
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "@th/errors";

/**
 * Generate a hex HMAC token for an unsubscribe link.
 * The token signs `{prefix}:{id}:{email}` so it cannot be forged.
 *
 * For contact lists: `generateUnsubscribeToken(secret, listId, email)`
 * For waitlists:     `generateWaitlistUnsubscribeToken(secret, eventId, email)`
 */
export function generateUnsubscribeToken(
  secret: string,
  listId: string,
  email: string,
): string {
  return createHmac("sha256", secret)
    .update(`${listId}:${email.toLowerCase()}`)
    .digest("hex");
}

/**
 * Generate a hex HMAC token for a waitlist unsubscribe link.
 * Uses a distinct prefix so waitlist tokens cannot be confused with contact list tokens.
 */
export function generateWaitlistUnsubscribeToken(
  secret: string,
  eventId: string,
  email: string,
): string {
  return createHmac("sha256", secret)
    .update(`wl:${eventId}:${email.toLowerCase()}`)
    .digest("hex");
}

/**
 * Generate a hex HMAC token for an org-level announcement unsubscribe link.
 *
 * Covers all ticket-holder-derived audiences for a single org. Uses a distinct
 * `org:` prefix so org tokens cannot be confused with contact-list or waitlist
 * tokens. Signs `org:{orgId}:{email}`.
 */
export function generateOrgUnsubscribeToken(
  secret: string,
  orgId: string,
  email: string,
): string {
  return createHmac("sha256", secret)
    .update(`org:${orgId}:${email.toLowerCase()}`)
    .digest("hex");
}

/**
 * Generate a hex HMAC token for a review-prompt weekly-digest unsubscribe link
 * (attendee-prompt-delivery-hygiene FR-005). Uses a distinct `reviewprompts:`
 * prefix so it can't be confused with contact-list / waitlist / org tokens.
 * Signs `reviewprompts:{humanId}:{email}`; no expiry (matches the announcements
 * tokens — the blast radius is one human's review-prompt email only).
 */
export function generateReviewPromptUnsubscribeToken(
  secret: string,
  humanId: string,
  email: string,
): string {
  return createHmac("sha256", secret)
    .update(`reviewprompts:${humanId}:${email.toLowerCase()}`)
    .digest("hex");
}

/**
 * Verify a review-prompt unsubscribe token is valid (constant-time).
 */
export function verifyReviewPromptUnsubscribeToken(
  secret: string,
  humanId: string,
  email: string,
  token: string,
): boolean {
  const expected = generateReviewPromptUnsubscribeToken(secret, humanId, email);
  return constantTimeEqual(expected, token);
}

/**
 * Verify an org-level announcement unsubscribe token is valid (constant-time).
 */
export function verifyOrgUnsubscribeToken(
  secret: string,
  orgId: string,
  email: string,
  token: string,
): boolean {
  const expected = generateOrgUnsubscribeToken(secret, orgId, email);
  return constantTimeEqual(expected, token);
}

/**
 * Verify an unsubscribe token is valid (contact list).
 */
function verifyUnsubscribeToken(
  secret: string,
  listId: string,
  email: string,
  token: string,
): boolean {
  const expected = generateUnsubscribeToken(secret, listId, email);
  return constantTimeEqual(expected, token);
}

/**
 * Verify a waitlist unsubscribe token is valid.
 */
function verifyWaitlistUnsubscribeToken(
  secret: string,
  eventId: string,
  email: string,
  token: string,
): boolean {
  const expected = generateWaitlistUnsubscribeToken(secret, eventId, email);
  return constantTimeEqual(expected, token);
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Compare BYTE lengths, not string .length (UTF-16 code units): a crafted
  // multi-byte token could match `a`'s code-unit length yet differ in bytes,
  // making timingSafeEqual throw RangeError. Both inputs are fixed-length hex
  // HMAC digests, so a length check leaks nothing useful.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process an unsubscribe request. Verifies the HMAC token, then:
 * - **contact_list**: looks up InviteListEntry by list + email and sets `unsubscribedAt`.
 * - **waitlist**: looks up EventWaitlistEntry by event + email and sets status to DROPPED.
 *
 * This is a public (unauthenticated) endpoint — the HMAC token acts as proof
 * of authorization.
 */
export async function unsubscribeFromAudience(
  deps: UnsubscribeFromAudienceDeps,
  rawInput: unknown,
): Promise<UnsubscribeFromAudienceOutput> {
  const input = parseInput(unsubscribeFromAudienceInputSchema, rawInput);

  if (input.kind === "waitlist") {
    return unsubscribeFromWaitlist(
      deps,
      input as typeof input & { eventId: string },
    );
  }

  return unsubscribeFromContactList(
    deps,
    input as typeof input & { listId: string },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact list unsubscribe (original flow)
// ─────────────────────────────────────────────────────────────────────────────

async function unsubscribeFromContactList(
  deps: UnsubscribeFromAudienceDeps,
  input: { listId: string; email: string; token: string },
): Promise<UnsubscribeFromAudienceOutput> {
  const valid = verifyUnsubscribeToken(
    deps.unsubscribeSecret,
    input.listId,
    input.email,
    input.token,
  );
  if (!valid) {
    throw fail("INVALID_UNSUBSCRIBE_TOKEN");
  }

  try {
    const entry = await deps.repos.inviteLists.getEntryByListAndEmail(
      input.listId,
      input.email,
    );

    if (!entry) {
      deps.logger.info("unsubscribe_entry_not_found", {
        listId: input.listId,
        email: input.email,
      });
      return { ok: true };
    }

    if (entry.unsubscribedAt) {
      return { ok: true };
    }

    const now = deps.clock.now();
    await deps.repos.inviteLists.unsubscribeEntry(entry.id, now);

    deps.logger.info("audience_unsubscribed", {
      listId: input.listId,
      entryId: entry.id,
      email: input.email,
    });

    return { ok: true };
  } catch (error) {
    deps.logger.error("unsubscribe_failed", {
      listId: input.listId,
      error: describeError(error),
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Waitlist unsubscribe (sets entry status → DROPPED)
// ─────────────────────────────────────────────────────────────────────────────

async function unsubscribeFromWaitlist(
  deps: UnsubscribeFromAudienceDeps,
  input: { eventId: string; email: string; token: string },
): Promise<UnsubscribeFromAudienceOutput> {
  const valid = verifyWaitlistUnsubscribeToken(
    deps.unsubscribeSecret,
    input.eventId,
    input.email,
    input.token,
  );
  if (!valid) {
    throw fail("INVALID_UNSUBSCRIBE_TOKEN");
  }

  try {
    // Look up the waitlist entry by event + email (either Human.email or contactEmail)
    const entry = await deps.repos.eventWaitlists.findEntry({
      eventId: input.eventId,
      contactEmail: input.email,
    });

    if (!entry) {
      deps.logger.info("waitlist_unsubscribe_entry_not_found", {
        eventId: input.eventId,
        email: input.email,
      });
      return { ok: true };
    }

    if (entry.status === "DROPPED") {
      return { ok: true };
    }

    const now = deps.clock.now();
    await deps.repos.eventWaitlists.updateEntry({
      entryId: entry.id,
      status: "DROPPED",
      updatedAt: now,
    });

    deps.logger.info("waitlist_unsubscribed", {
      eventId: input.eventId,
      entryId: entry.id,
      email: input.email,
    });

    return { ok: true };
  } catch (error) {
    deps.logger.error("waitlist_unsubscribe_failed", {
      eventId: input.eventId,
      error: describeError(error),
    });
    throw error;
  }
}
