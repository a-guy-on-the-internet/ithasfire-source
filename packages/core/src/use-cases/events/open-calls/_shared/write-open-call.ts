import { z } from "zod";

import { fail } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type {
  ApplicationFormDefaults,
  OpenCallAnchor,
  OpenCallFormRecord,
  OpenCallPayKind,
  UpsertOpenCallFormInput,
} from "@th/ports/repos/events";

import { parseInput } from "../../../../lib/io";
import {
  findEventSeriesLink,
  openCallEndedReason,
  type OpenCallAnchorContext,
} from "./open-call-anchor";
import { effectiveOpenCallPaySchema } from "./open-call-pay";
import { plainTextMultilineOptional } from "../../../../lib/sanitize-plain-text";

/**
 * An open call's intro: public on the call page, so sanitized (tags, control
 * and bidi characters stripped) BEFORE the length check; blank = null.
 * Absent = leave unchanged, null = clear. The attendee form's intro keeps
 * its own (unchanged) schema.
 */
export const openCallIntroTextSchema = plainTextMultilineOptional(2000)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

/** The writable fields of an open call (presence semantics: absent = keep). */
export interface OpenCallFields {
  introText?: string | null;
  defaults?: ApplicationFormDefaults;
  opensAt?: Date | null;
  closesAt?: Date | null;
  maxSubmissions?: number | null;
  payKind?: OpenCallPayKind | null;
  payDetails?: string | null;
}

const windowOrderSchema = z
  .object({ opensAt: z.date().nullable(), closesAt: z.date().nullable() })
  .superRefine((value, ctx) => {
    if (
      value.opensAt &&
      value.closesAt &&
      value.closesAt.getTime() <= value.opensAt.getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "closes_at_must_be_after_opens_at",
      });
    }
  });

const pick = <T>(supplied: T | undefined, stored: T): T =>
  supplied !== undefined ? supplied : stored;

/**
 * Create or update an open call, inside the caller's transaction. Auth is the
 * caller's job (event or series edit rights); this owns the rules every
 * anchor shares:
 *
 * FR-001, one call per night. A dated event in a series that has a call
 * shows that call, so it may not get its own (OPEN_CALL_COVERED_BY_SERIES,
 * meta `{seriesId, publicId, posted}`). Drafts count: a draft holds its
 * night until it is posted or discarded (discardOpenCallDraft).
 * The other direction: a series may not open a call while any of its
 * UPCOMING events holds its own (SERIES_OPEN_CALL_CONFLICT, meta names the
 * events). Allowing both would offer the same night twice, through two forms
 * with two dedupe keys, so an act could apply twice for one night. Past
 * events don't conflict: their night is over. Both checks run only when the
 * call is being CREATED (an existing call keeps working), and both run under
 * the series' advisory lock, so a series call and an event call created at
 * the same moment cannot both pass.
 *
 * FR-002, pay. Validated against the MERGED values (input over stored), so a
 * partial update can't leave a FIXED call without details.
 *
 * Window. closesAt must be after opensAt, also on the merged pair.
 */
export async function writeOpenCall(
  tx: TxRepos,
  args: {
    /** The loaded event or series (the caller already checked edit rights). */
    anchorContext: OpenCallAnchorContext;
    actorHumanId: string;
    now: Date;
    fields: OpenCallFields;
  },
): Promise<{ form: OpenCallFormRecord; created: boolean }> {
  const { anchorContext, fields } = args;
  const anchor: OpenCallAnchor =
    anchorContext.kind === "event"
      ? { kind: "event", eventId: anchorContext.event.id }
      : { kind: "series", seriesId: anchorContext.series.id };

  const seriesId =
    anchor.kind === "series"
      ? anchor.seriesId
      : ((await findEventSeriesLink(tx, anchor.eventId))?.seriesId ?? null);
  if (seriesId) {
    await tx.eventApplications.lockSeriesOpenCalls(seriesId);
  }

  const existing = await tx.eventApplications.getOpenCall(anchor);

  if (!existing) {
    // A NEW call needs a night still to come: a past event, or a series with
    // no live occurrence ahead, would post a call nobody can be booked from.
    // Editing an existing call is unaffected.
    const { reason } = await openCallEndedReason(tx, anchorContext, args.now);
    if (reason) {
      throw anchor.kind === "event"
        ? fail("EVENT_NOT_EDITABLE", { meta: { reason } })
        : fail("SERIES_INACTIVE", { meta: { reason } });
    }
  }

  if (!existing && seriesId) {
    if (anchor.kind === "event") {
      const seriesCall = await tx.eventApplications.getOpenCall({
        kind: "series",
        seriesId,
      });
      if (seriesCall) {
        throw fail("OPEN_CALL_COVERED_BY_SERIES", {
          // posted=false: the series call is a draft, whose publicId 404s
          // publicly, so the UI links to the series builder instead.
          meta: {
            seriesId,
            publicId: seriesCall.publicId,
            posted: seriesCall.postedAt !== null,
          },
        });
      }
    } else {
      const conflicts = await tx.eventApplications.listUpcomingEventOpenCallsInSeries({
        seriesId,
        startsAfter: args.now,
      });
      if (conflicts.length > 0) {
        throw fail("SERIES_OPEN_CALL_CONFLICT", {
          meta: {
            seriesId,
            events: conflicts.map((c) => ({
              eventId: c.eventId,
              title: c.eventTitle,
              startsAt: c.eventStartsAt.toISOString(),
            })),
          },
        });
      }
    }
  }

  parseInput(effectiveOpenCallPaySchema, {
    payKind: pick(fields.payKind, existing?.payKind ?? null),
    payDetails: pick(fields.payDetails, existing?.payDetails ?? null),
  });
  parseInput(windowOrderSchema, {
    opensAt: pick(fields.opensAt, existing?.opensAt ?? null),
    closesAt: pick(fields.closesAt, existing?.closesAt ?? null),
  });

  const input: UpsertOpenCallFormInput = {
    anchor,
    updatedByHumanId: args.actorHumanId,
  };
  for (const key of [
    "introText",
    "defaults",
    "opensAt",
    "closesAt",
    "maxSubmissions",
    "payKind",
    "payDetails",
  ] as const) {
    if (fields[key] !== undefined) {
      (input as unknown as Record<string, unknown>)[key] = fields[key];
    }
  }

  const form = await tx.eventApplications.upsertOpenCall(input);
  return { form, created: !existing };
}

/** The open-call slice of a use-case output (null on an ATTEND form). */
export function toOpenCallOutput(form: OpenCallFormRecord) {
  return {
    publicId: form.publicId,
    payKind: form.payKind,
    payDetails: form.payDetails,
    closedAt: form.closedAt,
    postedAt: form.postedAt,
  };
}
