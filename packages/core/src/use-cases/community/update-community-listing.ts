import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  CommunityEditableFieldValues,
  EventRecord,
} from "@th/ports/repos/events";
import type { ExactLocationPrivacyReset } from "@th/types";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { EventBody } from "@th/schema";
import {
  eventAttendanceModeSchema,
  eventStatusSchema,
  eventStewardshipSchema,
} from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  GEO_GROUP_FIELDS,
  PLACE_LINK_FIELD,
  parseSuggestionFields,
  snapshotSuggestionBase,
} from "../events/_shared/suggestion-fields";
import { sanitizeEventBody } from "../events/_shared/event-body-sanitizer";
import {
  COMMUNITY_MODERATION_ROLES,
  ensureHeroImageReferenceValid,
  ensureProposedScheduleValid,
  ensureSuggestionTextAllowed,
  resolveCurrentHeroImageId,
  serializeSuggestionFields,
} from "./_shared/suggestion-validation";
import {
  noCommunityEditPostCommit,
  recordCommunityEditApplied,
  type CommunityEditPostCommit,
} from "./_shared/community-edit-applied";
import { suggestionRejection } from "./_shared/suggestion-rejection";
import {
  LINKED_PLACE_PRIVACY,
  resolveListingPlaceLocation,
} from "./_shared/resolve-listing-place";
import { addressVenueChanged, venueMoved } from "./_shared/venue-moved";

/**
 * Direct moderator edit of a community listing — the field-save behind
 * authoring one in the real `EventBuilder`, on a DRAFT **and on a live
 * listing**.
 *
 * WHY THIS EXISTS AT ALL. The repo method it calls,
 * `events.applyCommunityEdit`, already covers every field the builder saves
 * (the FR-007 whitelist IS the builder's field set: title, body, schedule,
 * timezone, the address/geo group, category, hero, age limit). What did NOT
 * exist was a use case that lets a moderator drive it directly: the only three
 * callers were the suggestion queue (`reviewEventEditSuggestion`, which needs
 * a PENDING suggestion row and a conflict check), the hero attach, and the
 * recurrence re-pin. So a moderator authoring a listing had no way to save a
 * field without filing a suggestion against their own draft and approving it.
 *
 * ## PUBLISHED is editable, and why that is not a loosening
 *
 * It USED to stop at the publish line, on the theory that a live listing is
 * "edited through the moderated queue". In practice that meant a moderator
 * fixing a typo on a live listing had to file a PUBLIC suggestion against it
 * and then approve their own suggestion — which the four-eyes rule in
 * `reviewEventEditSuggestion` blocks outright for the actor who submitted it,
 * and which writes a misleading trail when a second moderator rubber-stamps
 * it ("reviewed" when nobody reviewed anything).
 *
 * It was also already inconsistent: LINEUP and TAGS are directly editable on a
 * live listing (`ensureOwnerOrCommunityModerator` is deliberately
 * status-agnostic — those fields are not in `SUGGESTION_EDITABLE_FIELDS`, so a
 * DRAFT-only gate would freeze them forever on publish). The listing's own
 * fields were the odd ones out. Resolved by opening the rest, not by closing
 * lineup and tags.
 *
 * THE PUBLIC SUGGESTION QUEUE IS UNCHANGED. It exists for anonymous and public
 * proposals (FR-006) and still does. This is only about a moderator — someone
 * who would be the one approving that proposal anyway — editing directly.
 *
 * ## What a PUBLISHED edit owes that a DRAFT does not
 *
 * Exactly what the suggestion-approve path owes, run through the SAME code:
 * {@link recordCommunityEditApplied} (FR-018 hold settlement on a schedule
 * move, the FR-008/FR-013 `event_edit.applied` version-history row, and the
 * FR-013 change-notice outbox). Not a second copy — see that module for why
 * a divergent copy is the failure mode that matters here.
 *
 * A DRAFT owes none of it: nobody can see it, nobody can RSVP to it, it holds
 * no calendar line, and it is not in the search index. So the DRAFT path is
 * byte-for-byte what it was — one `community_listing.updated` audit row, no
 * settlement, no notices.
 *
 * AUDIT ROW, and how a direct edit is told apart from an approved proposal:
 * a PUBLISHED edit writes the shared `event_edit.applied` row with
 * `suggestionId: null` (the approve path writes the suggestion's id there).
 * The two facts — "a moderator changed this directly" and "a moderator
 * approved someone's proposal" — are different things to know about a
 * community-maintained listing, so they are distinguishable on the row itself
 * rather than inferred. It does NOT also write `community_listing.updated`:
 * `event_edit.applied` is strictly richer (before/after per field, the
 * material marker) and one save should be one row.
 *
 * SEARCH INDEX: a PUBLISHED direct edit reindexes the listing after commit,
 * and so does the suggestion-approve path it mirrors — both through the same
 * shared pipeline, which owns the decision so a third edit path cannot arrive
 * without it. Best-effort and never fatal: search being down leaves the edit
 * committed and lets the nightly `search.full-reindex` reconcile. NOT gated on
 * the FR-013 `material` flag — that flag is about telling attendees, and a
 * title-only edit is non-material but very much searchable.
 *
 * ## Status boundaries
 *
 * DRAFT and PUBLISHED are editable. CANCELLED / COMPLETED / ARCHIVED are not,
 * and refuse with the same codes the sibling builder surface uses for the same
 * states (`setEventTags`'s `ensureEventAllowsTagMutation`): ARCHIVED →
 * EVENT_ARCHIVED, CANCELLED / COMPLETED → EVENT_NOT_EDITABLE. Those replace
 * the blanket EVENT_NOT_DRAFT this used to throw for all four non-draft
 * states — a code that now names the wrong rule.
 *
 * Validation is the SAME machinery the suggestion pipeline runs, reused rather
 * than reimplemented, so the two can never disagree about what a legal value
 * is: whitelist (`parseSuggestionFields`), body sanitize + embed allowlist
 * (`sanitizeEventBody`), prose content filter (`ensureSuggestionTextAllowed`),
 * cross-field schedule ordering (`ensureProposedScheduleValid`) and the hero
 * reference rules (`ensureHeroImageReferenceValid`).
 *
 * Recurrence is NOT editable here — `updateCommunityRecurrence` owns the
 * schedule (it has to re-expand `EventDate` rows and re-pin `startsAt`).
 *
 * ## The place link (`fields.placeId`) — moderator direct edit only
 *
 * `placeId` rides in `fields` but is NOT a suggestion field: it is taken out
 * of the diff before `parseSuggestionFields` runs (which would reject it, as
 * it does on every public suggestion) and handled here:
 *
 *  - a uuid  → LINK. The place must pass `resolveListingPlaceLocation` (the
 *    same rules as create: exists, ACTIVE, EXACT, full address + pin), and
 *    the place becomes the source of truth: addressText / countryCode /
 *    region / locality / postalCode / lat / lng (and geohash6) follow it.
 *    Only the columns that DIFFER from the row are written. Any address/geo
 *    value the client sent alongside is IGNORED. Re-sending the place the
 *    listing is already linked to is a re-sync, not a link change.
 *  - `null`  → UNLINK. The address columns stay as they are unless the same
 *    diff sends new ones, which are then free text under the normal rules.
 *  - absent  → the link is untouched. On a LINKED listing, a diff that sends
 *    any address/geo field without a `placeId` is refused
 *    (EDIT_SUGGESTION_INVALID_FIELDS, reason `unsupported_fields`, `fields` =
 *    the address fields sent): those values would diverge from the place.
 *    Unlink (`placeId: null`) in the same diff to type a free address.
 *
 * On a PUBLISHED listing a link change goes through the shared pipeline as
 * `placeIdChange`: the `event_edit.applied` row records the placeId
 * before/after (and every address column written), and the listing is
 * reindexed. A move from one linked place to a DIFFERENT place is always
 * material (VENUE_CHANGED notice): places share street lines and pins (three
 * rooms at 1 Cannery Row), and RSVPers must reach the right one. A FIRST link
 * (from a typed address) is material when the venue changed: the pin moves
 * more than 50 m or a pin appears, OR the street line differs
 * (`addressVenueChanged`, passed to the pipeline as its override). A re-sync
 * to the same place is decided by the pin alone
 * (`venueMoved`). Copied address text that names the same street line
 * (formatting, a corrected postcode) is written and audited but tells no one,
 * and so does an unlink at an unchanged address: a false "venue changed"
 * alert trains RSVPers to ignore the real one.
 *
 * A TYPED address edit (unlinked, or unlinking in the same diff) follows the
 * same rule (`typedAddressVenueChanged`): re-picking the same address from
 * the suggestions returns a pin a few metres off and its own formatting,
 * which is saved and audited but sends no VENUE_CHANGED; a different street
 * address is a venue change even with the pin within 50 m (next door, or a
 * reverse geocode of an unchanged pin). This is decided here, not trusted
 * from the client.
 *
 * A link or re-sync also resets the listing's location privacy to the
 * place's (EXACT, no radius, no reveal schedule): a community listing has no
 * privacy setting of its own. Each column that changed is audited.
 *
 * Concurrency: the venue being linked is locked SHARED, then the listing row
 * FOR UPDATE, then the row is read (see the lock-order comment in the tx).
 *
 * Linking is not confirming: no venue-confirmation field is written.
 */

export const updateCommunityListingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /**
     * Partial whitelisted diff — validated by `parseSuggestionFields`, which
     * rejects unknown keys, an empty diff, and an unpaired lat/lng. Typed
     * `unknown` here for the same reason the submit path does it: the
     * whitelist is one shared parser, not a second schema that can drift.
     */
    fields: z.unknown(),
  })
  .strict();

export const updateCommunityListingOutputSchema = z
  .object({
    event: z
      .object({
        id: z.uuid(),
        title: z.string(),
        slug: z.string().nullable(),
        shortId: z.string().nullable(),
        status: eventStatusSchema,
        attendanceMode: eventAttendanceModeSchema,
        stewardship: eventStewardshipSchema,
        startsAt: z.date(),
        endsAt: z.date().nullable(),
        timezone: z.string(),
      })
      .strict(),
    /** The field names actually written, in whitelist order. */
    updatedFields: z.array(z.string()),
    /**
     * Booking-hold notifications a PUBLISHED edit owes (FR-018: it moved a
     * live listing's start onto a held calendar+date). Server-side only —
     * they name other acts' requests; transport strips them and dispatches
     * post-commit. Always absent on a DRAFT save (a pencil-in takes nothing).
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents + routing hint stay
 * server-side. Built from the omitted `.shape` (not `.omit()` on the strict
 * object) so `.parse(liveResult)` STRIPS the two keys instead of refusing the
 * result with `unrecognized_keys` the first time a listing actually owes one.
 */
export const updateCommunityListingWireOutputSchema = z.object(
  updateCommunityListingOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type UpdateCommunityListingInput = z.infer<
  typeof updateCommunityListingInputSchema
>;
export type UpdateCommunityListingOutput = z.infer<
  typeof updateCommunityListingOutputSchema
>;

export type UpdateCommunityListingDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  /**
   * Best-effort incremental search-index update after a PUBLISHED save
   * commits. Owned by the shared post-apply pipeline (see
   * `_shared/community-edit-applied.ts`), which is why the suggestion-approve
   * path cannot have it while this one does not. No-ops when omitted, and a
   * DRAFT save never reaches it — a draft is not in the index.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /**
   * ReporterPort convention. The ONLY swallow on this path is that post-commit
   * reindex, which `reindexAfterMutation` owns; this is threaded so the
   * swallow stays Sentry-visible rather than silent.
   */
  reportError?: ReporterPort;
};

export async function updateCommunityListing(
  deps: UpdateCommunityListingDeps,
  rawInput: unknown,
): Promise<UpdateCommunityListingOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "updateCommunityListing",
  });

  const execute = async (): Promise<UpdateCommunityListingOutput> => {
    const input = parseInput(updateCommunityListingInputSchema, rawInput);

    // Same actor gate as create/publish (FR-005): COMMUNITY_MODERATOR or
    // platform ADMIN.
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    // The place link is taken out BEFORE the FR-007 whitelist parser, which
    // rejects it (it is not a suggestion field). See the use-case doc.
    const { placeLink, rest } = splitPlaceLink(input.fields);

    // FR-007 whitelist: unknown keys reject the whole payload, empty diffs
    // reject, lat/lng must pair. A diff that carries only a place link is the
    // one legal "empty" field diff.
    const proposed: CommunityEditableFieldValues =
      // `rest` is the record left after the split whenever a link was sent.
      placeLink !== undefined && Object.keys(rest as object).length === 0
        ? {}
        : parseSuggestionFields(rest);

    // Body: schema + embed allowlist + cta href checks; PERSIST THE RETURNED
    // normalized value (sanitizeEventBody contract).
    let content: EventBody | null | undefined;
    if (proposed.content !== undefined) {
      content =
        proposed.content === null ? null : sanitizeBodyOrReject(proposed.content);
      proposed.content = content;
    }

    // Content filter over the prose (NFR-001). The geographic fields are
    // deliberately exempt — see ensureSuggestionTextAllowed.
    await ensureSuggestionTextAllowed({
      contentFilter: deps.contentFilter,
      title: proposed.title,
      content: content ?? null,
    });

    const { event, updatedFields, postCommit } = await deps.repos.tx(
      async (tx) => {
        // LOCK ORDER: venue, then row, then read (see
        // `EventsRepo.lockRows`). (a) The venue being linked, SHARED, before
        // any row lock — the place cascade takes its venue lock first and the
        // rows second, and this order keeps the two from deadlocking. (b) The
        // listing row FOR UPDATE, so a concurrent save (the builder's
        // debounced address save racing a place pick) cannot interleave its
        // read-check-write with this one. (c) Read the row under the lock.
        // Never lock a venue discovered after (b): an unlink or an omitted
        // placeId needs no venue lock, since the refusal rule below reads the
        // locked row.
        if (typeof placeLink === "string") {
          await tx.events.lockLocationsAtPlace({
            placeId: placeLink,
            mode: "shared",
          });
        }
        await tx.events.lockRows({ ids: [input.eventId], mode: "update" });
        const existing = await tx.events.getById(input.eventId);
        if (!existing) {
          throw fail("EVENT_NOT_FOUND");
        }
        if (existing.stewardship !== "COMMUNITY") {
          throw fail("EVENT_NOT_COMMUNITY");
        }
        // DRAFT and PUBLISHED are editable; the three end states are not.
        // Same codes as `setEventTags`'s `ensureEventAllowsTagMutation`, for
        // the same states, so the two builder surfaces refuse a dead listing
        // identically. See the use-case doc.
        ensureListingEditable(existing.status);

        const now = deps.clock.now();
        const live = existing.status === "PUBLISHED";

        // Cross-field schedule check against the listing's EFFECTIVE other
        // bound — a lone endsAt before the current start is still invalid.
        ensureProposedScheduleValid({ proposed, event: existing });

        // Place link → address columns (see the use-case doc). Mutates
        // `proposed` so every step below sees the address actually written.
        const placeLinkOutcome = await applyPlaceLink(tx, {
          existing,
          placeLink,
          proposed,
        });
        const { placeIdChange, privacyReset } = placeLinkOutcome;

        if (typeof proposed.heroImageId === "string") {
          await ensureHeroImageReferenceValid({
            images: tx.images,
            eventId: existing.id,
            heroImageId: proposed.heroImageId,
            // The moderator IS the uploader on the builder path, so their own
            // not-yet-attached upload is referenceable (and attached below).
            submitterHumanId: input.actorHumanId,
          });
        }

        // BEFORE the write, and only on a live listing: the pre-edit snapshot
        // the version-history row's `before` half is read from. The same
        // snapshot the approve path builds (`snapshotSuggestionBase` over the
        // event + its body + its resolved hero image id), so the two produce
        // the same audit shape. A DRAFT writes no such row, so it pays for
        // neither read.
        const beforeSnapshot = live
          ? snapshotSuggestionBase({
              event: existing,
              content: await tx.events.getContent({ eventId: existing.id }),
              heroImageId: await resolveCurrentHeroImageId(tx.images, existing),
            })
          : {};

        // Whitelisted repo write; geohash6 is re-derived adapter-side when the
        // diff moves the pin.
        const writtenFields = serializeSuggestionFields(proposed);
        if (placeIdChange) {
          writtenFields[PLACE_LINK_FIELD] = placeIdChange.after;
        }
        if (privacyReset) {
          for (const [column, change] of Object.entries(privacyReset.changes)) {
            writtenFields[column] = change.after;
          }
        }
        // Nothing to write: re-sending the linked place when the listing
        // already matches it. No write, no audit row, no notice.
        if (Object.keys(writtenFields).length === 0) {
          return {
            event: existing,
            updatedFields: [],
            postCommit: noCommunityEditPostCommit,
          };
        }

        const updated = await tx.events.applyCommunityEdit({
          eventId: existing.id,
          fields: proposed,
          ...(placeIdChange ? { placeId: placeIdChange.after } : {}),
          ...(privacyReset ? { locationPrivacy: privacyReset.reset } : {}),
        });

        // THE SHARED POST-APPLY PIPELINE, on a live listing only: FR-018 hold
        // settlement if the start moved, the FR-008/FR-013 `event_edit.applied`
        // version-history row (with `suggestionId: null` — this was a direct
        // edit, not an approved proposal), and the FR-013 change-notice
        // outbox. The SAME function `reviewEventEditSuggestion` runs after its
        // own apply. Immediately after the write and before anything else, so
        // a settle refusal (open challenge on the new line) rolls the whole
        // save back.
        //
        // A DRAFT keeps the no-op dispatcher: it owes no settlement and it is
        // not in the search index (`buildSearchIndex` only upserts PUBLISHED),
        // so a per-keystroke builder save would otherwise spend a round-trip
        // deleting a document that was never written.
        // A link or re-sync decided the venue change itself; a typed address
        // edit is decided here, by the same rule.
        const venueMovedOverride =
          placeLinkOutcome.venueMoved ??
          typedAddressVenueChanged(existing, proposed);
        let postCommit: CommunityEditPostCommit = noCommunityEditPostCommit;
        if (live) {
          ({ postCommit } = await recordCommunityEditApplied(tx, {
            before: existing,
            after: updated,
            applied: proposed,
            beforeSnapshot,
            actorHumanId: input.actorHumanId,
            now,
            suggestionId: null,
            conflictedFields: [],
            useCaseName: "updateCommunityListing",
            ...(placeIdChange ? { placeIdChange } : {}),
            ...(venueMovedOverride !== undefined
              ? { venueMoved: venueMovedOverride }
              : {}),
            ...(privacyReset
              ? { additionalChanges: privacyReset.changes }
              : {}),
          }));
        }

        // Keep the image `attached` flag coherent in the SAME tx as the hero
        // link, exactly as the suggestion-approve and hero-attach paths do.
        if (typeof proposed.heroImageId === "string") {
          const heroImage = await tx.images.getById(proposed.heroImageId);
          if (heroImage && !heroImage.attached) {
            await tx.images.attach({
              ownerId: existing.id,
              imageIds: [heroImage.id],
              attachedAt: now,
            });
          }
        }

        // DRAFT trail only. A live edit's trail is the richer
        // `event_edit.applied` row the shared pipeline just wrote — one save,
        // one row. Editor attribution lives ONLY in the AuditLog either way:
        // the event row stays ownerless (the same spec decision create is
        // built on).
        if (!live) {
          await tx.audit.log({
            entity: "event",
            entityId: existing.id,
            action: "community_listing.updated",
            data: {
              actorHumanId: input.actorHumanId,
              updatedFields: Object.keys(writtenFields),
              // Serialized (Dates → ISO) so the audit Json round-trips.
              fields: writtenFields,
            },
            at: now,
          });
        }

        return {
          event: updated,
          updatedFields: Object.keys(writtenFields),
          postCommit,
        };
      },
    );

    // THE POST-COMMIT HALF of the shared pipeline: fire the best-effort
    // incremental search reindex on a live listing (a saved title or venue
    // must stop serving stale immediately, not at the next nightly full
    // reindex) and take the FR-018 settlement result off it. Run here, OUTSIDE
    // the tx, because indexing a row the tx might still have rolled back would
    // publish an edit that never happened — and because a slow search backend
    // must not hold this event's row locks. Never throws:
    // `reindexAfterMutation` swallows and reports through `deps.reportError`.
    // A DRAFT save dispatches the no-op.
    const heldDates = postCommit({
      repos: deps.repos,
      clock: deps.clock,
      search: deps.search,
      logger: deps.logger,
      ...(deps.reportError ? { reportError: deps.reportError } : {}),
    });

    scopedLogger?.info("updateCommunityListing.completed", {
      eventId: event.id,
      updatedFields,
    });

    return updateCommunityListingOutputSchema.parse({
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        shortId: event.shortId,
        status: event.status,
        attendanceMode: event.attendanceMode,
        stewardship: event.stewardship,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
      },
      updatedFields,
      ...(heldDates && heldDates.intents.length > 0
        ? {
            notificationIntents: heldDates.intents,
            staffRecipientHint: heldDates.staffRecipientHint,
          }
        : {}),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateCommunityListing", execute);
  }

  return execute();
}

/**
 * Which statuses a moderator may save over.
 *
 * DRAFT (authoring) and PUBLISHED (fixing a live listing) are editable. The
 * three end states are not: a CANCELLED, COMPLETED or ARCHIVED listing is a
 * record of something that happened, and rewriting one would rewrite history
 * for everyone already holding a notice about it.
 *
 * Codes are lifted from `setEventTags`'s `ensureEventAllowsTagMutation` — the
 * OTHER builder surface a moderator drives against the same listing — so the
 * same dead listing refuses both the same way. They replace the blanket
 * EVENT_NOT_DRAFT this used to throw for every non-DRAFT status, which now
 * names a rule that no longer exists.
 */
function ensureListingEditable(status: EventRecord["status"]): void {
  if (status === "DRAFT" || status === "PUBLISHED") {
    return;
  }
  if (status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED", { meta: { status } });
  }
  throw fail("EVENT_NOT_EDITABLE", { meta: { status } });
}

const placeLinkSchema = z.uuid().nullable();

/**
 * Takes `placeId` out of the raw `fields` payload. Returns the link
 * (`undefined` = not sent) and the remaining payload for the FR-007 parser.
 * A non-object payload is passed through untouched for that parser to reject.
 */
function splitPlaceLink(raw: unknown): {
  placeLink: string | null | undefined;
  rest: unknown;
} {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Object.prototype.hasOwnProperty.call(raw, PLACE_LINK_FIELD)
  ) {
    return { placeLink: undefined, rest: raw };
  }
  const { [PLACE_LINK_FIELD]: value, ...rest } = raw as Record<
    string,
    unknown
  >;
  if (value === undefined) {
    return { placeLink: undefined, rest };
  }
  const placeLink = parseInput(placeLinkSchema, value);
  if (typeof placeLink === "string") {
    // The place supplies the address: client-sent address/geo is ignored.
    for (const field of GEO_GROUP_FIELDS) {
      delete rest[field];
    }
  }
  return { placeLink, rest };
}

/**
 * What applying the place link decided, beyond the address columns it put
 * into the diff.
 */
type PlaceLinkOutcome = {
  /** The link change to record; absent when the link did not change. */
  placeIdChange?: { before: string | null; after: string | null };
  /**
   * Link/re-sync only: whether the venue changed (from one place to
   * another: always; a first link from a typed address:
   * `addressVenueChanged`; a re-sync: `venueMoved`). Passed to the shared
   * pipeline as its materiality override. Absent on unlink and omitted,
   * which keep the name-based rule.
   */
  venueMoved?: boolean;
  /**
   * Link/re-sync only: the location-privacy reset to the place's (EXACT),
   * with the audited before/after of each column that actually changed.
   * Absent when the row already carries the place's privacy.
   */
  privacyReset?: {
    reset: ExactLocationPrivacyReset;
    changes: Record<string, { before: unknown; after: unknown }>;
  };
};

/**
 * A linked listing takes the place's privacy (EXACT; see
 * `ExactLocationPrivacyReset`). Needed when the row is not EXACT or still
 * carries a reveal schedule. An EXACT row's radius is ignored (the column
 * defaults to 500), so it alone does not trigger a reset; when a reset is
 * written, the radius is nulled with it and audited if it changed. The reveal
 * cursor (`addressRevealNotifiedAt`) is cleared with it but NOT audited: it is
 * job bookkeeping, not a listing field, and `EventRecord` does not carry it.
 */
function privacyResetFor(
  existing: EventRecord,
): PlaceLinkOutcome["privacyReset"] {
  const revealAt = existing.addressRevealAt ?? null;
  const revealPreset = existing.addressRevealPreset ?? null;
  if (
    existing.locationMode === "EXACT" &&
    revealAt === null &&
    revealPreset === null
  ) {
    return undefined;
  }
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (existing.locationMode !== "EXACT") {
    changes.locationMode = { before: existing.locationMode, after: "EXACT" };
  }
  if ((existing.locationRadiusMeters ?? null) !== null) {
    changes.locationRadiusMeters = {
      before: existing.locationRadiusMeters,
      after: null,
    };
  }
  if (revealAt !== null) {
    changes.addressRevealAt = { before: revealAt.toISOString(), after: null };
  }
  if (revealPreset !== null) {
    changes.addressRevealPreset = { before: revealPreset, after: null };
  }
  return { reset: LINKED_PLACE_PRIVACY, changes };
}

/**
 * Applies the place link to the diff, inside the transaction (see
 * {@link PlaceLinkOutcome}).
 */
async function applyPlaceLink(
  tx: TxRepos,
  params: {
    existing: EventRecord;
    placeLink: string | null | undefined;
    proposed: CommunityEditableFieldValues;
  },
): Promise<PlaceLinkOutcome> {
  const { existing, placeLink, proposed } = params;
  const linkedNow = existing.placeId ?? null;

  if (placeLink === undefined) {
    if (linkedNow !== null) {
      const sentAddressFields = GEO_GROUP_FIELDS.filter(
        (field) => proposed[field] !== undefined,
      );
      if (sentAddressFields.length > 0) {
        // The address of a linked listing follows its place; editing it alone
        // would make the two disagree. Unlink (placeId: null) to type one.
        throw suggestionRejection("unsupported_fields", sentAddressFields);
      }
    }
    return {};
  }

  if (placeLink === null) {
    return linkedNow === null
      ? {}
      : { placeIdChange: { before: linkedNow, after: null } };
  }

  // Same venue the caller already locked before `lockRows` (lock order:
  // venue, then rows). Re-taking a shared advisory lock the transaction
  // already holds is granted at once; it is never a venue found after the
  // row lock.
  const location = await resolveListingPlaceLocation(tx, placeLink);
  const fromPlace = {
    addressText: location.addressText,
    countryCode: location.countryCode,
    region: location.region,
    locality: location.locality,
    postalCode: location.postalCode,
    lat: location.lat,
    lng: location.lng,
  } satisfies Required<
    Pick<CommunityEditableFieldValues, (typeof GEO_GROUP_FIELDS)[number]>
  >;

  // Write ONLY the address columns that differ from the row. Whether the
  // edit is material (and sends VENUE_CHANGED) is decided by which columns
  // are written, so a link at the listing's current address moves nothing
  // and tells nobody: a false "venue changed" alert trains RSVPers to ignore
  // the real one.
  for (const field of GEO_GROUP_FIELDS) {
    if ((existing[field] ?? null) !== fromPlace[field]) {
      Object.assign(proposed, { [field]: fromPlace[field] });
    }
  }
  // Keep lat/lng paired for the adapter's geohash derivation.
  if (proposed.lat !== undefined || proposed.lng !== undefined) {
    proposed.lat = fromPlace.lat;
    proposed.lng = fromPlace.lng;
  }

  const privacyReset = privacyResetFor(existing);
  return {
    // Re-sending the place the listing is already at is a re-sync, not a
    // link change.
    ...(placeLink === linkedNow
      ? {}
      : { placeIdChange: { before: linkedNow, after: placeLink } }),
    // A move from one place to ANOTHER is always a venue change: places
    // share a street line and a pin (Mercy Lounge, Cannery Hall and The High
    // Watt are all 1 Cannery Row), and RSVPers must reach the right room.
    // A first link (from a typed address) is a venue change when the pin
    // moves > 50 m (or appears) OR the street line differs: linking the place
    // at the address already typed tells no one. A re-sync to the same place
    // is the pin alone: the place's own text being corrected is no move.
    venueMoved:
      placeLink === linkedNow
        ? venueMoved(existing, fromPlace)
        : linkedNow !== null || addressVenueChanged(existing, fromPlace),
    ...(privacyReset ? { privacyReset } : {}),
  };
}

/**
 * The venue-change override for a TYPED address edit: the diff carries
 * address fields and no place link decided it. Same rule as a link to a
 * different place (`addressVenueChanged`): the pin moves more than 50 m (or
 * appears or disappears) OR the street line differs. Text naming the same
 * street line (formatting, a corrected postcode) tells no one; a different
 * street address does, even at the same pin.
 *
 * `undefined` (keep the shared pipeline's name-based rule: any address field
 * written is a venue change) in the two cases the pin cannot speak for the
 * address:
 *  - the diff sends address fields WITHOUT re-sending the pin: the text may
 *    name a different building while the pin stays put. The builder always
 *    sends the pin with the address; another client gets the cautious rule.
 *  - neither the row nor the diff has a pin: there is nothing to measure.
 */
function typedAddressVenueChanged(
  existing: EventRecord,
  proposed: CommunityEditableFieldValues,
): boolean | undefined {
  const sendsAddress = GEO_GROUP_FIELDS.some(
    (field) => proposed[field] !== undefined,
  );
  if (!sendsAddress) return undefined;
  // `parseSuggestionFields` pairs lat/lng, so one being sent means both are.
  if (proposed.lat === undefined || proposed.lng === undefined) {
    return undefined;
  }
  const before = {
    lat: existing.lat,
    lng: existing.lng,
    addressText: existing.addressText,
    postalCode: existing.postalCode,
  };
  // A field the diff does not send keeps its stored value.
  const after = {
    lat: proposed.lat,
    lng: proposed.lng,
    addressText:
      proposed.addressText !== undefined
        ? proposed.addressText
        : existing.addressText,
    postalCode:
      proposed.postalCode !== undefined
        ? proposed.postalCode
        : existing.postalCode,
  };
  const hasPin = (pin: { lat: unknown; lng: unknown }) =>
    typeof pin.lat === "number" && typeof pin.lng === "number";
  if (!hasPin(before) && !hasPin(after)) return undefined;
  return addressVenueChanged(before, after);
}

/**
 * `sanitizeEventBody` throws the generic `invalid_input` shape; this surface
 * promotes it to the typed EDIT_SUGGESTION_INVALID_FIELDS code so the builder
 * gets the SAME stable error family the propose surface gets for a
 * field-level rejection (mirrors `submit-event-edit-suggestion`).
 */
function sanitizeBodyOrReject(value: unknown): EventBody {
  try {
    return sanitizeEventBody(value);
  } catch (error) {
    throw suggestionRejection("invalid_body", ["content"], { cause: error });
  }
}
