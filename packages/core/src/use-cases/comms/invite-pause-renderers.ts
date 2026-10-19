import { z } from "zod";

import {
  INVITE_PAUSE_DECIDED_COPY,
  INVITE_PAUSE_OPENED_COPY,
  invitePauseDecidedBody,
  invitePauseOpenedBody,
} from "./copy/invite-pauses";
import type { DirectRendererDefinition } from "./direct-in-app";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// IN-APP-ONLY variants for the invite complaint auto-pause (W4). The producer
// (events/invites/invite-pause-notifications.ts) writes the inbox row itself
// through `buildDirectInAppNotice`, after the pause / decision transaction
// commits. Nothing sends these through `notify`: owner ruling 2026-10-07,
// in-app only.
//
// Registered in `renderers.ts`'s registry; this file imports it for types
// only. Stored payloads are a contract: only ever add optional fields.
// ─────────────────────────────────────────────────────────────────────────────

const ownerKindSchema = z.enum(["ORG", "HUMAN"]);

function inAppOnly(
  variant: string,
  fingerprint: Record<string, unknown>,
  inApp: {
    title: string;
    body: string;
    kind: "INFO" | "SUCCESS" | "WARNING";
    actionLabel: string;
    actionRoute: string;
    metadata: Record<string, string>;
  },
): RenderNotificationResult {
  return {
    category: "transactional",
    fingerprint: { variant, ...fingerprint },
    inApp: {
      title: inApp.title,
      body: inApp.body,
      kind: inApp.kind,
      action: { label: inApp.actionLabel, route: inApp.actionRoute },
      tags: ["invites", "invite-pause"],
      metadata: inApp.metadata,
      expiresAt: null,
      template: null,
    },
  };
}

// ── invite-pause.opened ──────────────────────────────────────────────────────

export const INVITE_PAUSE_OPENED_VARIANT = "invite-pause.opened" as const;

const invitePauseOpenedSchema = z
  .object({
    pauseId: z.string(),
    ownerKind: ownerKindSchema,
    /** The org's name; null for a person (the reader) or a nameless org. */
    organiserName: z.string().nullable(),
    reason: z.enum(["COMPLAINT_COUNT", "COMPLAINT_RATE"]),
    complaintCount: z.number().int().nonnegative(),
    recipientCount: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
    /** The Invited guests panel of the tripping event, or the events list. */
    actionRoute: z.string(),
    /** True when `actionRoute` deep-links an event's Invited guests panel. */
    linksToEvent: z.boolean().optional(),
  })
  .strict();

export const invitePauseOpenedRenderer: DirectRendererDefinition<
  typeof invitePauseOpenedSchema
> = {
  variant: INVITE_PAUSE_OPENED_VARIANT,
  category: "transactional",
  schema: invitePauseOpenedSchema,
  render(input, ctx) {
    const copy = INVITE_PAUSE_OPENED_COPY[ctx.locale];
    return inAppOnly(
      INVITE_PAUSE_OPENED_VARIANT,
      { pauseId: input.pauseId },
      {
        title: copy.title(input),
        body: invitePauseOpenedBody(copy, input),
        kind: "WARNING",
        actionLabel: input.linksToEvent ? copy.actionLabel : copy.eventsListLabel,
        actionRoute: input.actionRoute,
        metadata: { pauseId: input.pauseId, reason: input.reason },
      },
    );
  },
};

// ── invite-pause.decided ─────────────────────────────────────────────────────

export const INVITE_PAUSE_DECIDED_VARIANT = "invite-pause.decided" as const;

const invitePauseDecidedSchema = z
  .object({
    pauseId: z.string(),
    ownerKind: ownerKindSchema,
    organiserName: z.string().nullable(),
    decision: z.enum(["LIFTED", "KEPT"]),
    /** Staff's note, already clipped by the producer. */
    note: z.string().nullable(),
    actionRoute: z.string(),
    /** True when `actionRoute` deep-links an event's Invited guests panel. */
    linksToEvent: z.boolean().optional(),
  })
  .strict();

export const invitePauseDecidedRenderer: DirectRendererDefinition<
  typeof invitePauseDecidedSchema
> = {
  variant: INVITE_PAUSE_DECIDED_VARIANT,
  category: "transactional",
  schema: invitePauseDecidedSchema,
  render(input, ctx) {
    const copy = INVITE_PAUSE_DECIDED_COPY[ctx.locale];
    return inAppOnly(
      INVITE_PAUSE_DECIDED_VARIANT,
      { pauseId: input.pauseId, decision: input.decision },
      {
        title: copy.title(input),
        body: invitePauseDecidedBody(copy, input),
        kind: input.decision === "LIFTED" ? "SUCCESS" : "WARNING",
        actionLabel: input.linksToEvent
          ? copy.actionLabel(input)
          : copy.eventsListLabel,
        actionRoute: input.actionRoute,
        metadata: { pauseId: input.pauseId, decision: input.decision },
      },
    );
  },
};
