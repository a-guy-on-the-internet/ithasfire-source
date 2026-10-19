import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TicketTypeTemplateRecord } from "@th/types";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  applyTicketTypeTemplateInputSchema,
  applyTicketTypeTemplateResultSchema,
  type ApplyTicketTypeTemplateInput,
  type ApplyTicketTypeTemplateResult,
  type ApplyTicketTypeTemplateWarning,
} from "./schemas";
import { materializeTemplateEntrySchedule } from "../../lib/ticket-types/template-relative-schedule";
import { requireEventResaleClauseSet } from "../../lib/resale-clause";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import {
  upsertTicketType,
  upsertTicketTypeInputSchema,
  ensureEventExists,
  ensureEventAccessible,
  ensureEventIsEditable,
} from "../ticket-types/upsert-ticket-type";
import { fail, isAppError } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ApplyTicketTypeTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  /**
   * Resolved `resale` feature gate (transport resolves it via
   * getFeatureGates, fail-closed). When false, entries are clamped to
   * `resaleAllowed: false, resaleCapCents: null` before creation — a stored
   * template saved while the gate was ON must not smuggle resale config in
   * while the gate is OFF (mirrors the CREATE clamp in routers/ticket-types.ts).
   */
  resaleEnabled: boolean;
  logger?: LoggerPort;
  /** Forwarded to `upsertTicketType`'s fee-policy scope-walk swallow. */
  reportError?: ReporterPort;
};

interface StoredApplyTicketTypeTemplateResult {
  payloadHash: string;
  response: ApplyTicketTypeTemplateResult;
}

function buildPayloadHash(input: ApplyTicketTypeTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Copies a template's entries onto an event as real ticket types.
 *
 * Each entry is created through the existing `upsertTicketType` use case (its
 * own tx + idempotency, keyed `tpl:${clientKey}:${index}`) so validation,
 * Stripe checks, status derivation and per-entry audit stay in ONE place.
 * Entries whose name already exists on the event (`@@unique([eventId, name])`)
 * are skipped.
 *
 * FR-016 (ticket-type-packs, adopted by time-based-ticket-pricing FR-011): each
 * entry's RELATIVE `salesOpen` / `salesClose` / `scheduledPriceChange` is
 * materialized into absolute instants against THIS event before creation, and a
 * bound that resolves already-elapsed or inverted is dropped with a per-entry
 * warning in the result rather than creating a born-unsellable or already-past
 * tier. See `lib/ticket-types/template-relative-schedule.ts`. A mid-apply failure leaves earlier entries committed; retrying
 * the same outer clientKey never duplicates them, but note the reporting:
 * the pre-check sees attempt-1's entries on the event and reports them as
 * "skipped" (it shadows the per-entry idempotency replay path, which remains
 * only a backstop against duplicate creates).
 */
export async function applyTicketTypeTemplate(
  deps: ApplyTicketTypeTemplateDeps,
  rawInput: unknown,
): Promise<ApplyTicketTypeTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "applyTicketTypeTemplate",
  });

  const execute = async () => {
    const input = parseInput(applyTicketTypeTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `ticket-type-template:apply:${input.actorHumanId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredApplyTicketTypeTemplateResult>(
        idempotencyKey,
      );
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredApplyTicketTypeTemplateResult>(
          idempotencyKey,
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
      // ONE instant for the whole apply (FR-016 "apply time"). Read before any
      // work so every entry's EVENT_PUBLISH anchor, every already-elapsed
      // judgement and the audit row agree — the same discipline
      // `upsertTicketType` states for its own transaction. Two entries in one
      // template must not resolve `{ EVENT_PUBLISH, 0 }` to instants a
      // round-trip apart.
      const appliedAt = deps.clock.now();

      // Fail-fast validation pass: template + event guards and the
      // skip-existing-name pre-check, before any entry is created.
      const { template, preExistingNames, eventStartsAt } = await deps.repos.tx(
        async (tx) => {
          const loaded = await tx.ticketTypeTemplates.getById(input.templateId);
          if (!loaded) {
            throw fail("TEMPLATE_NOT_FOUND");
          }
          if (loaded.archivedAt) {
            throw fail("TEMPLATE_ARCHIVED");
          }

          // FR-007: the view guard widens to "LIVE platform row, or a row
          // the actor may view" — and to nothing wider. A DRAFT pack's
          // template is indistinguishable from absent; a foreign owned
          // template still 404s inside ensureTemplateOwnerAccess's own
          // denial. Platform rows skip the owner check entirely (there is
          // no owner to derive it from); event access below still gates who
          // can write to the event.
          if (loaded.isPlatform || loaded.ownerId === null) {
            const pack = loaded.packId
              ? await tx.ticketTypeTemplates.getPack(loaded.packId)
              : null;
            if (!loaded.isPlatform || !pack || pack.status !== "LIVE") {
              throw fail("TEMPLATE_NOT_FOUND");
            }
          } else {
            await ensureTemplateOwnerAccess(
              tx,
              loaded.ownerScope,
              loaded.ownerId,
              input.actorHumanId,
              { purpose: "view" },
              scopedLogger,
            );
          }

          const event = await ensureEventExists(tx, input.eventId);
          if (event.attendanceMode === "RSVP") {
            throw fail("EVENT_NOT_TICKETED");
          }
          await ensureEventAccessible(tx, event, input.actorHumanId);
          ensureEventIsEditable(event);

          const existing = new Set<string>();
          for (const entry of loaded.ticketTypes) {
            const match = await tx.tickets.findTicketTypeByName(
              event.id,
              entry.name,
            );
            if (match) {
              existing.add(entry.name.toLowerCase());
            }
          }

          // organiser-resale-share FR-001: an entry that would create a type
          // allowing resale needs the event's resale clause set, which
          // `upsertTicketType` enforces per entry. Checked here, before any
          // entry is created, so the apply is refused whole instead of half
          // way through. (ADJUSTABLE entries are clamped to no resale.)
          const createsResale =
            deps.resaleEnabled &&
            loaded.ticketTypes.some(
              (entry) =>
                entry.resaleAllowed &&
                entry.pricingMode !== "ADJUSTABLE" &&
                !existing.has(entry.name.toLowerCase()),
            );
          if (createsResale) {
            // Event row before RESALE terms (see `requireEventResaleClauseSet`).
            await tx.events.lockRows({ ids: [event.id], mode: "share" });
            await requireEventResaleClauseSet(tx, event);
          }

          return {
            template: loaded,
            preExistingNames: existing,
            // FR-016's EVENT_START anchor. A required column, so the anchor
            // always resolves — there is no "missing event start" case here,
            // unlike the volunteer resolver's nullable EVENT_END.
            eventStartsAt: event.startsAt,
          };
        },
      );

      const result = await createEntries(deps, input, template, {
        preExistingNames,
        target: { eventStartsAt, appliedAt },
      });

      await deps.repos.tx(async (tx) => {
        await tx.audit.log({
          entity: "ticket_type_template",
          entityId: template.id,
          action: "applied",
          data: {
            eventId: input.eventId,
            created: result.created,
            skipped: result.skipped,
            // FR-016 drops are recorded even when empty, so "nothing was
            // dropped" is evidence rather than an absence — the same reasoning
            // the series generator's Q-005 counters are audited under.
            warnings: result.warnings,
            actorHumanId: input.actorHumanId,
          },
          at: appliedAt,
        });
      });

      await deps.idempotency.commit<StoredApplyTicketTypeTemplateResult>(
        idempotencyKey,
        { payloadHash, response: result },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("apply_ticket_type_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("applyTicketTypeTemplate", execute);
  }

  return execute();
}

async function createEntries(
  deps: ApplyTicketTypeTemplateDeps,
  input: ApplyTicketTypeTemplateInput,
  template: TicketTypeTemplateRecord,
  opts: {
    preExistingNames: ReadonlySet<string>;
    /** FR-016 resolution context — one per apply, never per entry. */
    target: { eventStartsAt: Date; appliedAt: Date };
  },
): Promise<ApplyTicketTypeTemplateResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: ApplyTicketTypeTemplateWarning[] = [];

  // ── Pass 1: build and CHECK every entry before creating any ────────────
  // Entries are created one transaction at a time (pass 2), so an entry the
  // write boundary refuses half-way — a stored PWYW minimum above today's cap,
  // say — used to leave the first entries applied and surface a generic
  // "invalid form" 400. Every entry's `upsertTicketType` input is parsed here
  // first; the first one that cannot be created refuses the whole apply, by
  // name, before anything is written.
  const planned: Array<{
    entry: (typeof template.ticketTypes)[number];
    schedule: ReturnType<typeof materializeTemplateEntrySchedule>;
    upsertInput: Parameters<typeof upsertTicketType>[1];
  }> = [];
  for (const [index, entry] of template.ticketTypes.entries()) {
    if (opts.preExistingNames.has(entry.name.toLowerCase())) {
      skipped.push(entry.name);
      continue;
    }

    // FR-016: relative → absolute, against THIS event. An entry with none of
    // the three relative fields yields all-nulls and no drops, which is exactly
    // what this call site sent before the fields existed (NFR-001).
    const schedule = materializeTemplateEntrySchedule(entry, opts.target);
    const upsertInput = {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      name: entry.name,
      description: null,
      priceCents: entry.priceCents,
      pricingMode: entry.pricingMode,
      minimumCents: entry.minimumCents ?? null,
      suggestedCents: entry.suggestedCents ?? null,
      capacity: entry.capacity,
      seatSectionId: null,
      // Gate-off clamp: stored resale config must not apply while the
      // gate is off — see ApplyTicketTypeTemplateDeps.resaleEnabled.
      resaleAllowed: deps.resaleEnabled ? entry.resaleAllowed : false,
      resaleCapCents: deps.resaleEnabled ? (entry.resaleCapCents ?? null) : null,
      transferAllowed: entry.transferAllowed,
      // Materialized FR-011/FR-016 fields. The window bounds are
      // INDEPENDENT and the schedule pair is both-or-neither; both
      // invariants are already guaranteed by
      // `materializeTemplateEntrySchedule`, and `upsertTicketType`
      // re-checks them at the write boundary regardless.
      salesOpenAt: schedule.salesOpenAt,
      salesCloseAt: schedule.salesCloseAt,
      scheduledPriceCents: schedule.scheduledPriceCents,
      scheduledPriceAt: schedule.scheduledPriceAt,
      // Distinct prefix so derived keys can't collide with a
      // user-supplied plain upsertTicketType clientKey.
      clientKey: `tpl:${input.clientKey}:${index}`,
    };
    const checked = upsertTicketTypeInputSchema.safeParse(upsertInput);
    if (!checked.success) {
      throw {
        code: "invalid_input",
        message: "template_entry_invalid",
        // On the wire as `data.meta` — the admin names the entry from it.
        meta: {
          entryName: entry.name,
          reason: checked.error.issues[0]?.message ?? null,
        },
      } as const;
    }
    planned.push({ entry, schedule, upsertInput });
  }

  // ── Pass 2: create ─────────────────────────────────────────────────────
  for (const { entry, schedule, upsertInput } of planned) {
    for (const drop of schedule.drops) {
      warnings.push({ entryName: entry.name, ...drop });
    }

    try {
      await upsertTicketType(
        {
          repos: deps.repos,
          idempotency: deps.idempotency,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        upsertInput,
      );
      created.push(entry.name);
    } catch (error) {
      // Race backstop: a same-name ticket type landed between the pre-check
      // and this entry's tx — treat it as skipped, like the pre-check would.
      if (isAppError(error) && error.code === "TICKET_TYPE_NAME_TAKEN") {
        skipped.push(entry.name);
        // The type was NOT created, so any drop recorded for it above describes
        // nothing that exists. Withdraw it rather than warn about a tier the
        // organizer will not find on the event.
        while (
          warnings.length > 0 &&
          warnings[warnings.length - 1]!.entryName === entry.name
        ) {
          warnings.pop();
        }
        continue;
      }
      throw error;
    }
  }

  return applyTicketTypeTemplateResultSchema.parse({
    created,
    skipped,
    warnings,
  });
}
