import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventGateType,
  EventVisibility,
  UpsertEventApplicationFormInput as RepoUpsertFormInput,
} from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { anchorEnded } from "./open-calls/_shared/open-call-anchor";
import {
  openCallPayKindSchema,
  payDetailsInputSchema,
} from "./open-calls/_shared/open-call-pay";
import {
  openCallIntroTextSchema,
  toOpenCallOutput,
  writeOpenCall,
} from "./open-calls/_shared/write-open-call";
import { fail } from "@th/errors";

const defaultsSchema = z.object({
  includeName: z.boolean(),
  includeReason: z.boolean(),
  includeSocialLinks: z.boolean(),
});

const introTextSchema = z.string().trim().max(2000).nullable().optional();

/**
 * Base shape without refinements — safe for `.omit()` in tRPC routers
 * (same convention as submit/review).
 *
 * Presence semantics (spec Phase 2): every optional field means
 * "absent = leave the stored value unchanged, null = clear". The question
 * builder and the gate-settings panel write DIFFERENT slices of the form
 * row, so an unconditional write from one must never clobber the other.
 */
export const upsertEventApplicationFormInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  introText: introTextSchema,
  defaults: defaultsSchema.optional(),
  /** Application window start. Null = open immediately. */
  opensAt: z.date().nullable().optional(),
  /**
   * Application window end. Null = never closes. Must be strictly after
   * `opensAt` when both are set (refined below).
   */
  closesAt: z.date().nullable().optional(),
  /** Submission cap. Null = uncapped; when set, at least 1. */
  maxSubmissions: z.number().int().min(1).nullable().optional(),
  /** Instant-approval ("registration with questions") mode. */
  autoApprove: z.boolean().optional(),
});

/**
 * `closesAt` must be strictly after `opensAt`. Applied to the EFFECTIVE
 * (post-merge) pair, never to the raw input alone — see
 * `assertWindowOrdered`.
 */
const windowOrderSchema = z
  .object({
    opensAt: z.date().nullable(),
    closesAt: z.date().nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.opensAt &&
      value.closesAt &&
      value.closesAt.getTime() <= value.opensAt.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "closes_at_must_be_after_opens_at",
      });
    }
  });

/**
 * Open calls v1 (spec FR-001/FR-002): which of the event's forms to write,
 * plus the pay fields an open call carries. Kept OUT of the base above on
 * purpose: the attendee router builds its input from the base, so until the
 * open-call transport lands (step 9) that endpoint keeps writing the ATTEND
 * form only, whatever a client sends.
 *
 *   purpose    — absent = ATTEND (every existing caller);
 *   payKind    — PERFORM only; required on the merged form (core check);
 *   payDetails — PERFORM only; sanitized, blank = null, at most 500 chars.
 */
export const upsertEventApplicationFormPurposeFieldsSchema = z.object({
  purpose: z.enum(["ATTEND", "PERFORM"]).optional(),
  payKind: openCallPayKindSchema.nullable().optional(),
  payDetails: payDetailsInputSchema,
});

export const upsertEventApplicationFormInputSchema =
  upsertEventApplicationFormInputSchemaBase
    .extend(upsertEventApplicationFormPurposeFieldsSchema.shape)
    .superRefine((value, ctx) => {
    if ((value.purpose ?? "ATTEND") === "ATTEND") {
      // The attendee gate has no pay: the fields are an open call's.
      for (const key of ["payKind", "payDetails"] as const) {
        if (value[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "pay_fields_only_on_open_calls",
          });
        }
      }
    } else if (value.autoApprove === true) {
      // An open call never auto-approves: a pick puts an act on the lineup,
      // and only someone with edit rights picks (Q10, Q28).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoApprove"],
        message: "auto_approve_not_on_open_calls",
      });
    }
    // Fast path only — a both-sides-present input is inverted regardless of
    // what is stored. The authoritative check runs against the effective
    // post-merge pair inside the transaction (a PARTIAL update can invert
    // the window without either input value being wrong on its own).
    if (
      value.opensAt &&
      value.closesAt &&
      value.closesAt.getTime() <= value.opensAt.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "closes_at_must_be_after_opens_at",
      });
    }
  });

export const upsertEventApplicationFormOutputSchema = z.object({
  eventId: z.string().uuid(),
  formId: z.string().uuid(),
  /**
   * Set on an open call (PERFORM) only. Absent on the attendee form, whose
   * output stays exactly what it was before open calls.
   */
  purpose: z.literal("PERFORM").optional(),
  /** The open-call slice (PERFORM only). */
  openCall: z
    .object({
      publicId: z.string(),
      payKind: openCallPayKindSchema.nullable(),
      payDetails: z.string().nullable(),
      closedAt: z.date().nullable(),
      /** Null = a draft call; "Post call" makes it public (Q41). */
      postedAt: z.date().nullable(),
    })
    .optional(),
  introText: z.string().nullable(),
  defaults: defaultsSchema,
  opensAt: z.date().nullable(),
  closesAt: z.date().nullable(),
  maxSubmissions: z.number().int().nullable(),
  autoApprove: z.boolean(),
  updatedAt: z.date(),
});

export type UpsertEventApplicationFormInput = z.infer<
  typeof upsertEventApplicationFormInputSchema
>;
export type UpsertEventApplicationFormOutput = z.infer<
  typeof upsertEventApplicationFormOutputSchema
>;

export type UpsertEventApplicationFormDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function upsertEventApplicationForm(
  deps: UpsertEventApplicationFormDeps,
  rawInput: unknown,
): Promise<UpsertEventApplicationFormOutput> {
  const input = parseInput(upsertEventApplicationFormInputSchema, rawInput);

  if (input.purpose === "PERFORM") {
    return upsertEventOpenCall(deps, input);
  }

  const { event, form } = await deps.repos.tx(async (tx) => {
    const editableEvent = await ensureActorCanEditEvent(
      tx,
      input.eventId,
      input.actorHumanId,
    );

    if (editableEvent.gateType !== "APPLICATION") {
      throw fail("EVENT_NOT_APPLICATION_GATED");
    }

    await assertWindowOrdered(tx, editableEvent.id, input);

    // Forward only the fields the caller actually sent (absent/undefined =
    // leave unchanged, explicit null = clear), so the adapter's
    // presence-guarded update can distinguish the two.
    const repoInput: RepoUpsertFormInput = {
      eventId: editableEvent.id,
      // The attendee gate's form; open-call posting arrives in its own step.
      purpose: "ATTEND",
      updatedByHumanId: input.actorHumanId,
      ...(input.introText !== undefined ? { introText: input.introText } : {}),
      ...(input.defaults !== undefined ? { defaults: input.defaults } : {}),
      ...(input.opensAt !== undefined ? { opensAt: input.opensAt } : {}),
      ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}),
      ...(input.maxSubmissions !== undefined
        ? { maxSubmissions: input.maxSubmissions }
        : {}),
      ...(input.autoApprove !== undefined
        ? { autoApprove: input.autoApprove }
        : {}),
    };

    const updatedForm = await tx.eventApplications.upsertForm(repoInput);

    await tx.audit.log({
      entity: "event",
      entityId: editableEvent.id,
      action: "event_application_form_upserted",
      data: {
        actorHumanId: input.actorHumanId,
        formId: updatedForm.id,
      },
      at: deps.clock.now(),
    });

    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: editableEvent.id,
      visibility: editableEvent.visibility as EventVisibility,
      gateType: editableEvent.gateType as EventGateType,
      action: "application_form_upserted",
      result: "success",
      actorHumanId: input.actorHumanId,
    });

    return { event: editableEvent, form: updatedForm } as const;
  });

  return upsertEventApplicationFormOutputSchema.parse({
    eventId: event.id,
    formId: form.id,
    introText: form.introText,
    defaults: form.defaults,
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    maxSubmissions: form.maxSubmissions,
    autoApprove: form.autoApprove,
    updatedAt: form.updatedAt,
  });
}

/**
 * The event's open call (PERFORM form). Event edit rights, like the attendee
 * form; unlike it, no attendee gate is needed (a call is for acts, not
 * guests). A cancelled, archived or completed event takes no call
 * (EVENT_NOT_EDITABLE). The shared writer owns one-call-per-night (FR-001),
 * pay (FR-002) and the window check.
 */
async function upsertEventOpenCall(
  deps: UpsertEventApplicationFormDeps,
  input: UpsertEventApplicationFormInput,
): Promise<UpsertEventApplicationFormOutput> {
  // The call's intro is public (the call page), so it is sanitized here; the
  // attendee form's intro keeps the base schema's trim + max, unchanged.
  const { introText } = parseInput(
    z.object({ introText: openCallIntroTextSchema }),
    { introText: input.introText },
  );

  const { event, form, created } = await deps.repos.tx(async (tx) => {
    const editableEvent = await ensureActorCanEditEvent(
      tx,
      input.eventId,
      input.actorHumanId,
    );
    if (anchorEnded({ kind: "event", event: editableEvent })) {
      throw fail("EVENT_NOT_EDITABLE", { meta: { status: editableEvent.status } });
    }

    const now = deps.clock.now();
    const written = await writeOpenCall(tx, {
      anchorContext: { kind: "event", event: editableEvent },
      actorHumanId: input.actorHumanId,
      now,
      fields: {
        introText,
        defaults: input.defaults,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
        maxSubmissions: input.maxSubmissions,
        payKind: input.payKind,
        payDetails: input.payDetails,
      },
    });

    await tx.audit.log({
      entity: "event",
      entityId: editableEvent.id,
      action: written.created ? "open_call_created" : "open_call_updated",
      data: {
        actorHumanId: input.actorHumanId,
        formId: written.form.id,
        payKind: written.form.payKind,
      },
      at: now,
    });

    return { event: editableEvent, ...written } as const;
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    eventId: event.id,
    formId: form.id,
    action: created ? "created" : "updated",
    actorHumanId: input.actorHumanId,
  });

  return upsertEventApplicationFormOutputSchema.parse({
    eventId: event.id,
    formId: form.id,
    purpose: "PERFORM",
    openCall: toOpenCallOutput(form),
    introText: form.introText,
    defaults: form.defaults,
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    maxSubmissions: form.maxSubmissions,
    autoApprove: form.autoApprove,
    updatedAt: form.updatedAt,
  });
}

/**
 * Validate the window against the EFFECTIVE post-merge pair.
 *
 * The adapter's update is presence-guarded, so a PARTIAL update can invert a
 * stored window without either supplied value being wrong on its own:
 * `{ closesAt: 2026-09-01 }` against a stored `opensAt: 2026-10-01` would
 * otherwise persist a window that can never be open — the gate shows
 * "Applications open 1 Oct", submit throws APPLICATION_WINDOW_NOT_OPEN, and
 * the moment that instant passes it is already CLOSED. Validating only the
 * input pair (the schema's fast path) cannot see this.
 *
 * The stored row is read INSIDE the caller's transaction, so the value
 * validated is the value written against.
 *
 * Skipped entirely when the input can't invert anything: if neither side is
 * supplied there is nothing to check, and if BOTH are supplied the schema
 * already decided (no stored value survives the merge).
 */
async function assertWindowOrdered(
  tx: Pick<TxRepos, "eventApplications">,
  eventId: string,
  input: Pick<UpsertEventApplicationFormInput, "opensAt" | "closesAt">,
): Promise<void> {
  const opensSupplied = input.opensAt !== undefined;
  const closesSupplied = input.closesAt !== undefined;

  if (opensSupplied === closesSupplied) {
    // Neither supplied (nothing changes) or both supplied (already checked).
    return;
  }

  // Clearing the supplied side can never invert the window.
  const suppliedValue = opensSupplied ? input.opensAt : input.closesAt;
  if (suppliedValue === null) {
    return;
  }

  const stored = await tx.eventApplications.getForm(eventId, "ATTEND");
  if (!stored) {
    // No row yet: the create path writes exactly what was supplied, and a
    // single supplied side cannot be inverted.
    return;
  }

  parseInput(windowOrderSchema, {
    opensAt: opensSupplied ? input.opensAt : stored.opensAt,
    closesAt: closesSupplied ? input.closesAt : stored.closesAt,
  });
}
