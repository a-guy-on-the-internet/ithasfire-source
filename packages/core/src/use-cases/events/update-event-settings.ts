import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import {
  applyInstructionExemption,
  TN_INSTRUCTION_EXEMPT_SOURCE,
} from "../../lib/tax/instruction-exemption";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import {
  commitPreparedEventTaxRateForRef,
  eventTaxRateLocationRef,
  prepareEventTaxRate,
  type PreparedEventTaxRateForRef,
} from "./_shared/resolve-event-tax-rate";

export const updateEventSettingsInputSchemaBase = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  refundCutoffAt: z.date().nullable().optional(),
  volunteeringEnabled: z.boolean().optional(),
  volunteerAutoApprove: z.boolean().optional(),
  volunteerWaiverRequired: z.boolean().optional(),
  volunteerIntroText: z.string().trim().max(2000).nullable().optional(),
  /**
   * Organizer attestation that admission is for INSTRUCTION only (classes /
   * lessons / courses). Drives the Tennessee instruction-only tax exemption
   * (packages/core/src/lib/tax/instruction-exemption.ts).
   */
  instructionalAdmission: z.boolean().optional(),
});

export const updateEventSettingsInputSchema =
  updateEventSettingsInputSchemaBase.refine(
    (value) =>
      value.refundCutoffAt !== undefined ||
      value.volunteeringEnabled !== undefined ||
      value.volunteerAutoApprove !== undefined ||
      value.volunteerWaiverRequired !== undefined ||
      value.volunteerIntroText !== undefined ||
      value.instructionalAdmission !== undefined,
    { message: "no_changes_specified", path: [] },
  );

export const updateEventSettingsOutputSchema = z.object({
  eventId: z.uuid(),
  refundCutoffAt: z.date().nullable(),
  volunteeringEnabled: z.boolean(),
  volunteerAutoApprove: z.boolean(),
  volunteerWaiverRequired: z.boolean(),
  volunteerIntroText: z.string().nullable(),
  instructionalAdmission: z.boolean(),
});

export type UpdateEventSettingsInput = z.infer<
  typeof updateEventSettingsInputSchema
>;
export type UpdateEventSettingsOutput = z.infer<
  typeof updateEventSettingsOutputSchema
>;

export type UpdateEventSettingsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Tax-rate provider, used to re-resolve the venue's base admission rate when
   * `instructionalAdmission` is toggled so the persisted stamp stays consistent
   * with what checkout charges (see the re-stamp block below). Called BEFORE
   * the transaction, never inside it. Optional/null = no last-chance lookup
   * (cached venue rates still resolve).
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Sentry reporter, forwarded to the tax-rate resolution and used once more on
   * this use case's own re-stamp write. A tax-PROVIDER hiccup never fails the
   * settings update (the lookup helper is non-fatal and yields `null`, which
   * the no-rate branches below handle); what is reported here is a repo fault
   * on the re-stamp, which is then RETHROWN — see the catch block. Guarded so
   * a throwing reporter can never mask the real error.
   */
  reportError?: ReporterPort;
};

export async function updateEventSettings(
  deps: UpdateEventSettingsDeps,
  rawInput: unknown,
): Promise<UpdateEventSettingsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateEventSettings" });

  const execute = async () => {
    const input = parseInput(updateEventSettingsInputSchema, rawInput);

    // The re-stamp's tax-rate READ, including any provider round trip (a live
    // HTTP call, up to 5s), runs before the transaction so it never holds a
    // Postgres connection. Only when the flag is being toggled.
    const preparedTaxRate =
      input.instructionalAdmission !== undefined
        ? await prepareInstructionalTaxRestamp(
            deps,
            {
              eventId: input.eventId,
              actorHumanId: input.actorHumanId,
              instructionalAdmission: input.instructionalAdmission,
            },
            scopedLogger,
          )
        : null;

    const result = await deps.repos.tx(async (tx) => {
      const accessible = await ensureActorCanEditEvent(
        tx,
        input.eventId,
        input.actorHumanId,
      );
      const now = deps.clock.now();

      // LOCKS for the re-stamp, venue first and row second, HERE, before any
      // event-row write below (the order `EventsRepo.lockRows` documents).
      // Taken whenever the flag is SENT, not only when the unlocked read above
      // says it changes: whether it changes is decided on the locked re-read.
      // A save that does not send the flag never touches the stamp and takes
      // neither.
      //
      // 1. SHARED place-location lock on the venue the event points at.
      //    `upsertPlace` takes it EXCLUSIVE before it moves a venue and caches
      //    the new address's rate, and holds it while it rewrites the event
      //    rows at that venue: a settings save that row-locked this event
      //    first and then waited for the lock could deadlock it. Held to
      //    commit, so the venue cannot move between the re-stamp's re-read of
      //    the row and the stamp.
      // 2. FOR UPDATE on the event row, then the re-read everything below acts
      //    on. The venue lock pins the venue's ADDRESS, not WHICH venue the
      //    event points at: an event save that re-points it (taking the shared
      //    lock on the NEW venue only) could otherwise commit between
      //    `accessible` and the re-stamp, which would then put the old venue's
      //    rate, or an exemption decided on its situs, on an event at the new
      //    one, over the save's stamp.
      const restampLocks = input.instructionalAdmission !== undefined;
      const lockedPlaceId = restampLocks ? (accessible.placeId ?? null) : null;
      let event = accessible;
      if (restampLocks) {
        if (lockedPlaceId) {
          await tx.events.lockLocationsAtPlace({
            placeId: lockedPlaceId,
            mode: "shared",
          });
        }
        await tx.events.lockRows({ ids: [accessible.id], mode: "update" });
        const reRead = await tx.events.getById(accessible.id);
        if (!reRead) {
          throw fail("EVENT_NOT_FOUND");
        }
        if (
          reRead.orgId !== accessible.orgId ||
          reRead.humanId !== accessible.humanId ||
          reRead.stewardship !== accessible.stewardship
        ) {
          // The edit check above was for an owner the row no longer has.
          await ensureActorCanEditEvent(tx, reRead.id, input.actorHumanId);
        }
        event = reRead;
      }

      let current = event;

      // Whether the instructional flag actually changes value — decided on
      // THIS read, which is the one the write below acts on. Gates the
      // re-stamp so re-sending the same value never touches the tax stamp.
      const instructionalChanged =
        input.instructionalAdmission !== undefined &&
        input.instructionalAdmission !== (event.instructionalAdmission ?? false);
      const taxRef = eventTaxRateLocationRef(event);
      // The event now points at a venue this transaction holds no lock on (a
      // save re-pointed it before the row lock was granted). It cannot take
      // that lock now: venue lock after row lock is the order that deadlocks
      // `upsertPlace`. See the re-stamp below.
      const venueUnlocked =
        taxRef?.kind === "place" && taxRef.placeId !== lockedPlaceId;

      if (input.refundCutoffAt !== undefined) {
        current = await tx.events.updateRefundCutoff({
          eventId: current.id,
          refundCutoffAt: input.refundCutoffAt,
        });

        scopedLogger?.info("event_settings", {
          category: "event_settings",
          eventId: current.id,
          action: "refund_cutoff_updated",
          result: "success",
          actorHumanId: input.actorHumanId,
          metadata: {
            refundCutoffAt: input.refundCutoffAt?.toISOString() ?? null,
          },
        });
      }

      if (
        input.volunteeringEnabled !== undefined ||
        input.volunteerAutoApprove !== undefined ||
        input.volunteerWaiverRequired !== undefined ||
        input.volunteerIntroText !== undefined
      ) {
        current = await tx.events.updateVolunteerSettings({
          eventId: current.id,
          volunteeringEnabled: input.volunteeringEnabled,
          volunteerAutoApprove: input.volunteerAutoApprove,
          volunteerWaiverRequired: input.volunteerWaiverRequired,
          volunteerIntroText: input.volunteerIntroText,
        });

        scopedLogger?.info("event_settings", {
          category: "event_settings",
          eventId: current.id,
          action: "volunteer_settings_updated",
          result: "success",
          actorHumanId: input.actorHumanId,
          metadata: {
            volunteeringEnabled: input.volunteeringEnabled,
            volunteerAutoApprove: input.volunteerAutoApprove,
            volunteerWaiverRequired: input.volunteerWaiverRequired,
            volunteerIntroText: input.volunteerIntroText,
          },
        });
      }

      if (input.instructionalAdmission !== undefined) {
        current = await tx.events.updateInstructionalAdmission({
          eventId: current.id,
          instructionalAdmission: input.instructionalAdmission,
        });

        scopedLogger?.info("event_settings", {
          category: "event_settings",
          eventId: current.id,
          action: "instructional_admission_updated",
          result: "success",
          actorHumanId: input.actorHumanId,
          metadata: {
            instructionalAdmission: input.instructionalAdmission,
          },
        });

        // ── Durable tax re-stamp on a real toggle ────────────────────────────
        // Keep the persisted stamp (read by estimate-checkout-tax) consistent
        // with what checkout actually charges. The stamp alone carries no base
        // rate, so we RE-RESOLVE the venue's rate from its location (Place /
        // SavedLocation cached rate, or a last-chance lookup made before this
        // transaction) exactly like save/publish, then apply the exemption
        // with the NEW flag:
        //   • toggle ON  in TN → base rate resolves, exemption zeroes it to
        //     0 / "exempt:tn-instruction".
        //   • toggle OFF        → the real ziptax / CA rate is restored, so we
        //     stop silently under-collecting the "exempt:tn-instruction" stamp.
        //   • ON/OFF outside TN → the normal rate is (re)stamped unchanged.
        // A tax-PROVIDER hiccup never fails the settings update: the lookup
        // helper is non-fatal and the resolution returns `null` for every
        // legitimate no-rate outcome, which the branches below handle (leave
        // a GOOD stamp alone; null the exempt sentinel on toggle-off). A REPO
        // fault is different — it is rethrown and fails the whole save. See
        // the catch block for why the old swallow was the bug.
        //
        // The rate was prepared before this transaction, so the venue may
        // have moved since. Under the lock taken at the top, this re-reads
        // the row and drops a rate looked up for an address it no longer has
        // (resolving from its current cached rate, else `null`); a fresh
        // answer is cached only by compare-and-set. That keeps a moved
        // venue's OLD rate — and an exemption decided on the OLD address's
        // state — out of both the venue cache and this stamp. No provider
        // call in here.
        if (instructionalChanged && venueUnlocked) {
          // The event moved to a venue this transaction holds no lock on, so
          // its rate cannot be read safely here (an unlocked read could be a
          // rate `upsertPlace` is replacing). Whatever wrote the row's stamp
          // did so under the OLD flag. Only one stamp is wrong under the new
          // flag whatever venue wrote it: the exempt sentinel
          // (0 / "exempt:tn-instruction") on a toggle OFF, which checkout's
          // fast path would trust forever. That one is cleared to NULL, so
          // checkout resolves the rate fresh. Any other stamp is a real rate:
          // the moving save's for the new venue, or, on a draft moved by a
          // template apply or series sync (which never restamp), possibly the
          // old venue's, which publish replaces. Checkout applies the TN
          // exemption to a stamped rate itself, so it is left alone: a NULL
          // there would trade a correct rate for the fresh path, which
          // charges 0 when the venue has no cached rate and the provider
          // fails.
          if (
            input.instructionalAdmission === false &&
            current.admissionTaxRateBps === 0 &&
            current.taxRateSource === TN_INSTRUCTION_EXEMPT_SOURCE
          ) {
            await tx.events.updateTaxRate({
              eventId: current.id,
              admissionTaxRateBps: null,
              taxRateSource: null,
            });
            current = {
              ...current,
              admissionTaxRateBps: null,
              taxRateSource: null,
            };
            scopedLogger?.info("event_settings", {
              category: "event_settings",
              eventId: current.id,
              action: "instructional_admission_tax_stamp_cleared",
              result: "success",
              actorHumanId: input.actorHumanId,
              metadata: { reason: "venue_repointed", lockedPlaceId },
            });
          }
        } else if (instructionalChanged) {
          try {
            const taxStamp = await commitPreparedEventTaxRateForRef(
              { clock: deps.clock, reportError: deps.reportError },
              tx,
              taxRef,
              preparedTaxRate,
              scopedLogger,
              { eventId: current.id, source: "update_settings" },
            );
            if (taxStamp) {
              const exempt = applyInstructionExemption({
                instructionalAdmission: input.instructionalAdmission,
                situs: taxStamp.situs,
                rateBps: taxStamp.rateBps,
                source: taxStamp.source,
              });
              await tx.events.updateTaxRate({
                eventId: current.id,
                admissionTaxRateBps: exempt.rateBps,
                taxRateSource: exempt.source,
              });
              current = {
                ...current,
                admissionTaxRateBps: exempt.rateBps,
                taxRateSource: exempt.source,
              };
              scopedLogger?.info("event_settings", {
                category: "event_settings",
                eventId: current.id,
                action: "instructional_admission_tax_restamped",
                result: "success",
                actorHumanId: input.actorHumanId,
                metadata: {
                  admissionTaxRateBps: exempt.rateBps,
                  taxRateSource: exempt.source,
                },
              });
            } else if (
              // Toggle-OFF that FAILED to resolve a real base rate (e.g. an
              // inline-address event whose only source of truth is a ZipTax
              // lookup that returned null) AND whose current stamp is the
              // exempt sentinel (0 / "exempt:tn-instruction"). Leaving it would
              // charge 0/exempt forever on a now-NON-instructional event —
              // checkout's fast path trusts the 0 stamp and never self-heals
              // (self-heal only fires on a NULL stamp). Nulling loses nothing
              // (the exempt 0 was not a real collected rate), and lets
              // resolveCheckoutTax's fresh path re-resolve + self-heal at the
              // next checkout. We do NOT null a real non-zero stamp here — that
              // would be the clobber we're guarding against.
              input.instructionalAdmission === false &&
              current.admissionTaxRateBps === 0 &&
              current.taxRateSource === TN_INSTRUCTION_EXEMPT_SOURCE
            ) {
              await tx.events.updateTaxRate({
                eventId: current.id,
                admissionTaxRateBps: null,
                taxRateSource: null,
              });
              current = {
                ...current,
                admissionTaxRateBps: null,
                taxRateSource: null,
              };
              scopedLogger?.warn("instructional_admission_exempt_stamp_cleared", {
                category: "event_settings",
                eventId: current.id,
                actorHumanId: input.actorHumanId,
                reason: "toggle_off_base_rate_unresolved",
              });
            }
          } catch (err) {
            // Reported, then RETHROWN — the save fails. This used to swallow,
            // and that swallow was a money bug: on a toggle-OFF the flag write
            // above and the audit row below still committed while the stamp
            // stayed at 0 / "exempt:tn-instruction", so a now-taxable event
            // sold at $0 admission tax indefinitely and the organiser was told
            // the save succeeded. `resolveCheckoutTax` trusts ANY non-null
            // stamp, so the self-heal that covers a NULL stamp never fired.
            //
            // Why rethrow rather than fall through to the null-the-sentinel
            // write the branch above performs: what reaches here is a repo
            // fault (the tax-rate resolution rethrows those and returns `null`
            // for every legitimate no-rate case, and the write itself is a
            // plain update), and a failed statement has already condemned
            // this transaction — Postgres would answer a follow-up write with
            // 25P02 and blame the wrong statement, or, with nothing after it,
            // answer COMMIT with a silent ROLLBACK (docs/engineering-standards
            // "Swallowing an error inside a transaction"). Failing the save
            // keeps the flag and the stamp one atomic unit: either both move
            // or neither does, so the exempt sentinel can never outlive the
            // attestation that justified it. The organiser sees an error and
            // retries; nothing that would have committed now fails.
            //
            // `error`, not `warn`: warn is not captured by the Sentry pino
            // integration. The guarded report keeps the tags even though the
            // rethrow also reaches the transport backstop.
            scopedLogger?.error("tax_rate_restamp_failed", {
              eventId: current.id,
              err,
              error: describeError(err),
            });
            try {
              deps.reportError?.(err, {
                tags: { useCase: "updateEventSettings", op: "tax_restamp" },
                extra: { eventId: current.id },
              });
            } catch {
              // A throwing reporter must not replace the real error.
            }
            throw err;
          }
        }
      }

      await tx.audit.log({
        entity: "event",
        entityId: current.id,
        action: "event_settings_updated",
        data: {
          actorHumanId: input.actorHumanId,
          changes: {
            ...(input.refundCutoffAt !== undefined
              ? { refundCutoffAt: input.refundCutoffAt?.toISOString() ?? null }
              : {}),
            ...(input.volunteeringEnabled !== undefined
              ? { volunteeringEnabled: input.volunteeringEnabled }
              : {}),
            ...(input.volunteerAutoApprove !== undefined
              ? { volunteerAutoApprove: input.volunteerAutoApprove }
              : {}),
            ...(input.volunteerWaiverRequired !== undefined
              ? { volunteerWaiverRequired: input.volunteerWaiverRequired }
              : {}),
            ...(input.volunteerIntroText !== undefined
              ? { volunteerIntroText: input.volunteerIntroText }
              : {}),
            ...(input.instructionalAdmission !== undefined
              ? { instructionalAdmission: input.instructionalAdmission }
              : {}),
          },
        },
        at: now,
      });

      return current;
    });

    return updateEventSettingsOutputSchema.parse({
      eventId: result.id,
      refundCutoffAt: result.refundCutoffAt ?? null,
      volunteeringEnabled: result.volunteeringEnabled ?? false,
      volunteerAutoApprove: result.volunteerAutoApprove ?? false,
      volunteerWaiverRequired: result.volunteerWaiverRequired ?? false,
      volunteerIntroText: result.volunteerIntroText ?? null,
      instructionalAdmission: result.instructionalAdmission ?? false,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateEventSettings", execute);
  }

  return execute();
}

/**
 * The instructional re-stamp's tax-rate READ, run before the transaction so
 * the provider round trip never holds a Postgres connection.
 *
 * Gated like the transaction gates the re-stamp, so a save that will not
 * re-stamp spends no paid provider call: the actor must pass the same edit
 * check (it runs again in the transaction, authoritatively), and the flag
 * must actually change. Returns `null` when nothing was prepared; if the
 * transaction then finds a real toggle after all (the flag moved in between),
 * it resolves from the row without the provider.
 *
 * Errors propagate: an access failure is the error the transaction would have
 * thrown first, and a repo fault is reported and rethrown inside
 * `prepareEventTaxRate`.
 */
async function prepareInstructionalTaxRestamp(
  deps: Pick<
    UpdateEventSettingsDeps,
    "repos" | "taxRateLookup" | "clock" | "reportError"
  >,
  input: {
    eventId: string;
    actorHumanId: string;
    instructionalAdmission: boolean;
  },
  logger: LoggerPort | undefined,
): Promise<PreparedEventTaxRateForRef | null> {
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  if (input.instructionalAdmission === (event.instructionalAdmission ?? false)) {
    return null;
  }
  const ref = eventTaxRateLocationRef(event);
  const prepared = await prepareEventTaxRate(
    {
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    deps.repos,
    ref,
    logger,
    { eventId: event.id, source: "update_settings" },
  );
  return { ref, prepared };
}
