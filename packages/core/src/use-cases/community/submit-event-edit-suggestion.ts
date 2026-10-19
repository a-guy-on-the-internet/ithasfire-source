import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventBody } from "@th/schema";
import { eventEditSuggestionRecordSchema } from "@th/schema";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

import { parseInput } from "../../lib/io";
import {
  parseSuggestionFields,
  snapshotSuggestionBase,
} from "../events/_shared/suggestion-fields";
import { sanitizeEventBody } from "../events/_shared/event-body-sanitizer";
import {
  ensureCommunitySuggestibleEvent,
  ensureHeroImageReferenceValid,
  ensureProposedScheduleValid,
  ensureSuggestionTextAllowed,
  resolveCurrentHeroImageId,
  serializeSuggestionFields,
} from "./_shared/suggestion-validation";
import { notifySuggestionSubmitted } from "./_shared/suggestion-notifications";
import { suggestionRejection } from "./_shared/suggestion-rejection";
import type { ReporterPort } from "@th/ports/reporter";
import {
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
  type NetworkIdentityHasher,
} from "../../lib/security/network-identity";

/**
 * FR-006/FR-007 + NFR-001 (community-managed-event-listings spec): ANYONE —
 * including anonymous visitors — submits a whitelisted field diff against a
 * PUBLISHED PUBLIC **COMMUNITY-stewarded** event. (Product decision
 * 2026-07-20 reversed FR-006's original universal scope: OWNED events no
 * longer accept suggestions — open suggestions on owned events invite
 * trolling — and collapse to EVENT_NOT_FOUND like drafts/private events.)
 * The suggestion NEVER mutates the event; it lands
 * PENDING for the event's approver side (FR-008) together with a
 * base-version snapshot used for conflict detection at approve (FR-009).
 *
 * Soft per-IP cap (NFR-001): when the transport supplies a client IP, more
 * than {@link MAX_PENDING_PER_IP_24H} PENDING suggestions created from that
 * IP in the last 24h reject with the platform's existing `RATE_LIMITED`
 * code. The IP is never stored: the cap counts a keyed hash of it
 * (`hashSuggestionIp`, its own HKDF key), which the retention job clears after
 * ~30 days. No usable secret → no hash → no cap (reported), as with no IP.
 * `RATE_LIMITED` maps to TOO_MANY_REQUESTS at the tRPC boundary. It is a soft
 * anti-flooding cap, not a bot gate — nothing is public until approved.
 */

export const MAX_PENDING_PER_IP_24H = 25;
const IP_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const submitEventEditSuggestionInputSchema = z
  .object({
    eventId: z.uuid(),
    /** Null/omitted = anonymous submission (transport supplies from ctx). */
    submitterHumanId: z.uuid().nullable().optional(),
    submitterIp: z.string().trim().min(1).max(64).nullable().optional(),
    /** Whitelisted proposed values — validated via parseSuggestionFields. */
    fields: z.unknown(),
    note: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export const submitEventEditSuggestionOutputSchema = z
  .object({
    suggestion: eventEditSuggestionRecordSchema,
  })
  .strict();

export type SubmitEventEditSuggestionInput = z.infer<
  typeof submitEventEditSuggestionInputSchema
>;
export type SubmitEventEditSuggestionOutput = z.infer<
  typeof submitEventEditSuggestionOutputSchema
>;

export type SubmitEventEditSuggestionDeps = {
  repos: Repos;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  /** Root secret (BETTER_AUTH_SECRET) the IP-hash key is derived from. */
  identitySecret?: string | null;
  /** Prebuilt hasher for `identitySecret` (built from it when absent). */
  hasher?: NetworkIdentityHasher | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Keyed hash of the submitter's IP, or null (no IP, not an IP, or no usable
 * secret — the last is reported: the flood cap is off without it).
 */
function submitterIpHashFor(
  deps: SubmitEventEditSuggestionDeps,
  rawIp: string | null,
): string | null {
  if (!rawIp) return null;
  if (!isUsableNetworkIdentitySecret(deps.identitySecret)) {
    const err = new Error("edit_suggestion_ip_hash_secret_missing");
    deps.logger?.error("submitEventEditSuggestion.ip_hash_secret_missing", {
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "submitEventEditSuggestion", op: "hash_ip" },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return null;
  }
  const hasher =
    deps.hasher ?? createNetworkIdentityHasher(deps.identitySecret);
  return hasher.hashSuggestionIp(rawIp);
}

export async function submitEventEditSuggestion(
  deps: SubmitEventEditSuggestionDeps,
  rawInput: unknown,
): Promise<SubmitEventEditSuggestionOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "submitEventEditSuggestion",
  });

  const execute = async (): Promise<SubmitEventEditSuggestionOutput> => {
    const input = parseInput(submitEventEditSuggestionInputSchema, rawInput);
    const submitterHumanId = input.submitterHumanId ?? null;
    // The raw IP is hashed here and dropped; only the hash is counted/stored.
    const submitterIpHash = submitterIpHashFor(deps, input.submitterIp ?? null);
    const note = normalizeOptionalNote(input.note);
    const now = deps.clock.now();

    // Whitelist + value validation (FR-007): unknown keys reject the whole
    // payload; empty diffs reject; lat/lng must pair.
    const proposed = parseSuggestionFields(input.fields);

    // Soft per-IP cap (NFR-001) — checked before any other read so a flooder
    // can't use the endpoint as an existence oracle either.
    if (submitterIpHash) {
      const pendingFromIp =
        await deps.repos.eventEditSuggestions.countPendingByIp({
          submitterIpHash,
          since: new Date(now.getTime() - IP_CAP_WINDOW_MS),
        });
      if (pendingFromIp >= MAX_PENDING_PER_IP_24H) {
        throw fail("RATE_LIMITED", {
          meta: {
            scope: "event_edit_suggestions",
            windowHours: 24,
            max: MAX_PENDING_PER_IP_24H,
          },
        });
      }
    }

    // Target must be a PUBLISHED PUBLIC COMMUNITY event; everything else —
    // including OWNED events — 404s (COMMUNITY-only, revised FR-006).
    const event = ensureCommunitySuggestibleEvent(
      await deps.repos.events.getById(input.eventId),
    );

    // Body: schema + embed allowlist + cta href checks. The NORMALIZED body
    // replaces the raw proposal in the stored fields (sanitizeEventBody
    // contract) — a typed code so the anon surface gets a stable error.
    let content: EventBody | null | undefined;
    if (proposed.content !== undefined) {
      content =
        proposed.content === null ? null : sanitizeBodyOrReject(proposed.content);
      proposed.content = content;
    }

    // Content filter on the prose (NFR-001). The address fields are
    // deliberately exempt — see ensureSuggestionTextAllowed.
    await ensureSuggestionTextAllowed({
      contentFilter: deps.contentFilter,
      title: proposed.title,
      note,
      content: content ?? null,
    });

    // Cross-field schedule check against the event's effective bounds.
    ensureProposedScheduleValid({ proposed, event });

    // heroImageId reference rules (attached, or the submitter's own upload).
    if (typeof proposed.heroImageId === "string") {
      await ensureHeroImageReferenceValid({
        images: deps.repos.images,
        eventId: event.id,
        heroImageId: proposed.heroImageId,
        submitterHumanId,
      });
    }

    // Base-version snapshot for FR-009 conflict detection at approve.
    const baseContent = await deps.repos.events.getContent({
      eventId: event.id,
    });
    const baseHeroImageId = await resolveCurrentHeroImageId(
      deps.repos.images,
      event,
    );
    const baseVersion = snapshotSuggestionBase({
      event,
      content: baseContent,
      heroImageId: baseHeroImageId,
    });

    const storedFields = serializeSuggestionFields(proposed);

    const suggestion = await deps.repos.tx(async (tx) => {
      const created = await tx.eventEditSuggestions.create({
        eventId: event.id,
        submitterHumanId,
        submitterIpHash,
        fields: storedFields,
        baseVersion,
        note,
      });

      await tx.audit.log({
        entity: "event_edit_suggestion",
        entityId: created.id,
        action: "event_edit_suggestion.created",
        data: {
          eventId: event.id,
          submitterHumanId,
          anonymous: submitterHumanId === null,
          proposedFields: Object.keys(storedFields),
          note,
        },
        at: now,
      });

      return created;
    });

    // Close the approver-side feedback loop (Requirement A). Best-effort and
    // AFTER commit — we never notify about a suggestion that rolled back, and a
    // notification failure never fails the submission.
    await notifySuggestionSubmitted(deps, { event, suggestion });

    return submitEventEditSuggestionOutputSchema.parse({ suggestion });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("submitEventEditSuggestion", execute);
  }

  return execute();
}

/**
 * sanitizeEventBody throws the generic `invalid_input` shape; the suggestion
 * surface promotes it to the typed EDIT_SUGGESTION_INVALID_FIELDS code so
 * clients (incl. the anonymous propose surface) get one stable error family
 * for every field-level rejection.
 */
function sanitizeBodyOrReject(value: unknown): EventBody {
  try {
    return sanitizeEventBody(value);
  } catch (error) {
    throw suggestionRejection("invalid_body", ["content"], { cause: error });
  }
}

function normalizeOptionalNote(note: string | undefined): string | null {
  if (!note) return null;
  const normalized = note.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}
