import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type {
  EventRecord,
  EventVisibility,
  EventGateType,
  WaitlistStatus,
  Repos,
} from "@th/ports/repos";
import {
  eventGateTypeSchema,
  eventVisibilitySchema,
  waitlistStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import {
  hashEventPassword,
  isEventPasswordSet,
} from "../../lib/security/event-password";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import {
  eventSearchDocId,
  scrubEventSearchDocIfWithheld,
  scrubSearchDocumentsOrThrow,
} from "../search/privacy-scrub";
import { searchForTx } from "../search/tx-bound-search";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { fail } from "@th/errors";
import {
  plainTextMultilineOptional,
  plainTextOptional,
} from "../../lib/sanitize-plain-text";

const waitlistPatchSchema = z
  .object({
    status: waitlistStatusSchema.optional(),
    publishAt: z.date().nullable().optional(),
    description: plainTextMultilineOptional(2000).nullable().optional(),
    cap: z.number().int().min(1).nullable().optional(),
    emailEnabled: z.boolean().optional(),
    emailSubject: plainTextOptional(200).nullable().optional(),
    emailBody: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .partial()
  .optional();

const passwordSchema = z
  .union([z.string().min(4).max(64), z.literal(null)])
  .optional();

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const updateEventAccessControlsInputSchemaBase = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  visibility: eventVisibilitySchema.optional(),
  gateType: eventGateTypeSchema.optional(),
  password: passwordSchema,
  waitlist: waitlistPatchSchema,
});

export const updateEventAccessControlsInputSchema =
  updateEventAccessControlsInputSchemaBase.refine(
    (value) =>
      value.visibility !== undefined ||
      value.gateType !== undefined ||
      value.password !== undefined ||
      value.waitlist !== undefined,
    {
      message: "no_changes_specified",
      path: [],
    },
  );

export const updateEventAccessControlsOutputSchema = z.object({
  eventId: z.uuid(),
  visibility: eventVisibilitySchema,
  gateType: eventGateTypeSchema,
  waitlistStatus: waitlistStatusSchema,
  waitlistPublishAt: z.date().nullable(),
  waitlistDescription: z.string().nullable(),
  waitlistCap: z.number().int().nullable(),
  waitlistEmailEnabled: z.boolean(),
  waitlistEmailSubject: z.string().nullable(),
  waitlistEmailBody: z.record(z.string(), z.unknown()).nullable(),
  passwordSet: z.boolean(),
});

export type UpdateEventAccessControlsInput = z.infer<
  typeof updateEventAccessControlsInputSchema
>;
export type UpdateEventAccessControlsOutput = z.infer<
  typeof updateEventAccessControlsOutputSchema
>;

export type UpdateEventAccessControlsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The search index. Adding a gate (location becomes label only) or moving
   * off PUBLIC visibility deletes the event's search document before commit,
   * fail-closed, and re-indexes it after. See `search/privacy-scrub.ts`.
   * Omitted = no index to scrub.
   */
  search?: MultiSearchPort;
  /** Reports a failed scrub (before its throw) and a failed post-commit reindex. */
  reportError?: ReporterPort;
};

type UpdateResult = {
  event: EventRecord;
  changed: Record<string, unknown>;
  searchScrubbed: boolean;
  /** Marked for search reindex (a published event's visibility or gate moved). */
  searchMarked: boolean;
};

export async function updateEventAccessControls(
  deps: UpdateEventAccessControlsDeps,
  rawInput: unknown,
): Promise<UpdateEventAccessControlsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "updateEventAccessControls",
  });

  const execute = async () => {
    const input = parseInput(updateEventAccessControlsInputSchema, rawInput);

    const { event, searchScrubbed, searchMarked } = await deps.repos.tx(
      async (tx) => {
        const editable = await ensureActorCanEditEvent(
          tx,
          input.eventId,
          input.actorHumanId,
        );
        let current = editable;
        const now = deps.clock.now();
        const modifications: Record<string, unknown> = {};

        if (Object.prototype.hasOwnProperty.call(input, "password")) {
          const passwordValue = input.password ?? null;
          const passwordHash = passwordValue
            ? hashEventPassword(passwordValue)
            : null;
          current = await tx.events.updatePassword({
            eventId: current.id,
            passwordHash,
            passwordUpdatedAt: now,
          });
          modifications.password = passwordValue ? "set" : "cleared";
          scopedLogger?.info("event_gate", {
            category: "event_gate",
            eventId: current.id,
            gateType: current.gateType as EventGateType,
            visibility: current.visibility as EventVisibility,
            action: passwordValue ? "password_set" : "password_cleared",
            result: "success",
            actorHumanId: input.actorHumanId,
          });
        }

        if (input.visibility && input.visibility !== current.visibility) {
          current = await tx.events.updateVisibility({
            eventId: current.id,
            visibility: input.visibility,
          });
          modifications.visibility = {
            from: editable.visibility,
            to: input.visibility,
          };
          scopedLogger?.info("event_gate", {
            category: "event_gate",
            eventId: current.id,
            gateType: current.gateType as EventGateType,
            visibility: current.visibility as EventVisibility,
            action: "visibility_updated",
            result: "success",
            actorHumanId: input.actorHumanId,
          });
        }

        if (input.gateType && input.gateType !== current.gateType) {
          if (
            input.gateType === "PASSWORD" &&
            !isEventPasswordSet(current.passwordHash)
          ) {
            throw fail("PASSWORD_REQUIRED");
          }

          current = await tx.events.updateGateType({
            eventId: current.id,
            gateType: input.gateType,
          });
          modifications.gateType = {
            from: editable.gateType,
            to: input.gateType,
          };
          scopedLogger?.info("event_gate", {
            category: "event_gate",
            eventId: current.id,
            gateType: current.gateType as EventGateType,
            visibility: current.visibility as EventVisibility,
            action: "gate_type_updated",
            result: "success",
            actorHumanId: input.actorHumanId,
          });
        }

        if (input.waitlist) {
          const nextStatus = (input.waitlist.status ??
            current.waitlistStatus) as WaitlistStatus;
          let nextPublishAt =
            input.waitlist.publishAt ?? current.waitlistPublishAt ?? null;
          if (nextStatus === "SCHEDULED") {
            if (!nextPublishAt) {
              throw fail("WAITLIST_PUBLISH_AT_REQUIRED");
            }
          } else if (nextStatus === "DISABLED") {
            nextPublishAt = null;
          }

          const nextDescription = Object.prototype.hasOwnProperty.call(
            input.waitlist,
            "description",
          )
            ? (input.waitlist.description ?? null)
            : (current.waitlistDescription ?? null);
          const nextCap = Object.prototype.hasOwnProperty.call(
            input.waitlist,
            "cap",
          )
            ? (input.waitlist.cap ?? null)
            : (current.waitlistCap ?? null);

          const nextEmailEnabled = Object.prototype.hasOwnProperty.call(
            input.waitlist,
            "emailEnabled",
          )
            ? (input.waitlist.emailEnabled ?? false)
            : (current.waitlistEmailEnabled ?? false);
          const nextEmailSubject = Object.prototype.hasOwnProperty.call(
            input.waitlist,
            "emailSubject",
          )
            ? (input.waitlist.emailSubject ?? null)
            : (current.waitlistEmailSubject ?? null);
          const nextEmailBody = Object.prototype.hasOwnProperty.call(
            input.waitlist,
            "emailBody",
          )
            ? (input.waitlist.emailBody ?? null)
            : (current.waitlistEmailBody ?? null);

          current = await tx.events.updateWaitlistSettings({
            eventId: current.id,
            status: nextStatus,
            publishAt: nextPublishAt,
            description: nextDescription,
            cap: nextCap,
            emailEnabled: nextEmailEnabled,
            emailSubject: nextEmailSubject,
            emailBody: nextEmailBody,
          });

          modifications.waitlist = {
            status: nextStatus,
            publishAt: nextPublishAt,
            cap: nextCap,
            emailEnabled: nextEmailEnabled,
          };

          scopedLogger?.info("event_gate", {
            category: "event_gate",
            eventId: current.id,
            gateType: current.gateType as EventGateType,
            visibility: current.visibility as EventVisibility,
            action: "waitlist_updated",
            result: "success",
            actorHumanId: input.actorHumanId,
            metadata: modifications.waitlist as Record<string, unknown>,
          });
        }

        if (Object.keys(modifications).length > 0) {
          await tx.audit.log({
            entity: "event",
            entityId: current.id,
            action: "event_access_controls_updated",
            data: {
              actorHumanId: input.actorHumanId,
              changes: modifications,
            },
            at: now,
          });
        }

        // ── Search reindex mark ────────────────────────────────────────────
        // A published event's document stamps `isPublic` and its gate, so a
        // change to either — tightening OR loosening — makes it stale. Marked
        // in this transaction (`search/search-reindex-marks.ts`); loosening
        // used to wait for the nightly reindex.
        const searchMarked =
          current.status === "PUBLISHED" &&
          ("visibility" in modifications || "gateType" in modifications);
        if (searchMarked) {
          await markForSearchReindex(
            tx,
            [{ kind: "event", id: current.id }],
            now,
          );
        }

        // ── Search privacy scrub: the LAST step before commit ──────────────
        // Two changes take something out of public search, and for both the
        // old document is what would keep serving it:
        //  · a new gate: the location becomes label only on every public
        //    surface, the index included;
        //  · PUBLIC → anything else: the event becomes link-only, and its
        //    document (stamped `isPublic: true`) still lists it.
        // Delete the document here or fail the update (fail-closed, see
        // `search/privacy-scrub.ts`); the post-commit reindex writes it back
        // with the new gate / `isPublic: false`.
        const leftPublicView =
          editable.visibility === "PUBLIC" && current.visibility !== "PUBLIC";
        const searchScrubbed = leftPublicView
          ? await scrubSearchDocumentsOrThrow(searchForTx(deps.search, tx), {
              docIds: [eventSearchDocId(current.id)],
              useCase: "updateEventAccessControls",
              logger: scopedLogger,
              reportError: deps.reportError,
            })
          : await scrubEventSearchDocIfWithheld({
              search: searchForTx(deps.search, tx),
              places: tx.places,
              before: editable,
              after: current,
              useCase: "updateEventAccessControls",
              logger: scopedLogger,
              reportError: deps.reportError,
            });

        return {
          event: current,
          changed: modifications,
          searchScrubbed,
          searchMarked,
        } satisfies UpdateResult;
      },
    );

    if (searchScrubbed || searchMarked) {
      // Put the (label-only) document back. Best-effort: a failure is
      // reported and leaves the event out of search until the nightly
      // reindex, which is over-private, never a leak.
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        "updateEventAccessControls",
        { kind: "event", id: event.id },
      );
    }

    return updateEventAccessControlsOutputSchema.parse({
      eventId: event.id,
      visibility: event.visibility,
      gateType: event.gateType,
      waitlistStatus: event.waitlistStatus,
      waitlistPublishAt: event.waitlistPublishAt ?? null,
      waitlistDescription: event.waitlistDescription ?? null,
      waitlistCap: event.waitlistCap ?? null,
      waitlistEmailEnabled: event.waitlistEmailEnabled ?? false,
      waitlistEmailSubject: event.waitlistEmailSubject ?? null,
      waitlistEmailBody:
        (event.waitlistEmailBody as Record<string, unknown>) ?? null,
      passwordSet: isEventPasswordSet(event.passwordHash),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateEventAccessControls", execute);
  }

  return execute();
}
