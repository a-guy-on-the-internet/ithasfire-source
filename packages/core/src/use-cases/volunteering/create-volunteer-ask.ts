import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  resolveAskOwnership,
  type AskOwnershipContext,
} from "./_shared/resolve-ask-ownership";
import { createVolunteerAskInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type CreateVolunteerAskDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type CreateVolunteerAskOutput = { askId: string };

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Create a generic volunteer ask against a PLACE | ORG | HUMAN | EVENT
 * subject (generic-volunteering-asks FR-001).
 *
 * - Authz: `resolveAskOwnership` — the ask trust gate — inside the same tx
 *   as the write.
 * - Subject must exist and be active per its own status semantics: places
 *   and orgs must be ACTIVE, humans must not be SUSPENDED/BANNED, events
 *   must not be ARCHIVED.
 * - EVENT subjects: at most ONE ask per event. Friendly pre-check via
 *   `listAsksBySubject`; the raw partial unique index backs the race, whose
 *   loser surfaces the adapter's `{ code: "duplicate_event_ask" }` conflict
 *   untouched (booking-requests open-pair convention).
 * - `orgId` is denormalized for org dashboards / fast perms: ORG → the
 *   subject itself; EVENT → the event's org; PLACE → the acting human's
 *   GRANTING org when their access is org-based, else null (an ask created
 *   by a direct human owner is not an org's ask); HUMAN → null.
 * - Status defaults to DRAFT (repo default) — publishing is an explicit
 *   `update-volunteer-ask` transition.
 */
export async function createVolunteerAsk(
  deps: CreateVolunteerAskDeps,
  rawInput: unknown,
): Promise<CreateVolunteerAskOutput> {
  const input = parseInput(createVolunteerAskInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ownership = await resolveAskOwnership(
      tx,
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        orgId: null,
      },
      input.actorHumanId,
    );

    await ensureSubjectAcceptsAsks(tx, input.subjectType, input.subjectId, ownership);

    // One EVENT-subject ask per event — friendly pre-check; the adapter's
    // partial unique index catches the race.
    if (input.subjectType === "EVENT") {
      const existing = await tx.volunteering.listAsksBySubject(
        "EVENT",
        input.subjectId,
      );
      if (existing.length > 0) {
        throw fail("CONFLICT", {
          message: "duplicate_event_ask",
          meta: { reason: "duplicate_event_ask", eventId: input.subjectId },
        });
      }
    }

    const orgId = resolveDenormalizedOrgId(input.subjectType, input.subjectId, ownership);

    const ask = await tx.volunteering.createAsk({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      orgId,
      title: input.title,
      description: input.description ?? null,
      cadence: input.cadence,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      timezone: input.timezone ?? null,
      capacity: input.capacity ?? null,
      autoApprove: input.autoApprove,
      waiverRequired: input.waiverRequired,
      smsOptInEnabled: input.smsOptInEnabled,
      formSchema: input.formSchema,
    });

    await tx.audit.log({
      entity: "volunteer_ask",
      entityId: ask.id,
      action: "created",
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        orgId,
        title: input.title,
        timezone: input.timezone ?? null,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return { askId: ask.id };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Subject liveness gate: an ask can only be posted against a subject that
 * is still operating. Subjects are archived, never hard-deleted (spec risk
 * #3), so this is the create-time half of the orphan-prevention story.
 */
async function ensureSubjectAcceptsAsks(
  tx: TxRepos,
  subjectType: "PLACE" | "ORG" | "HUMAN" | "EVENT",
  subjectId: string,
  ownership: AskOwnershipContext,
): Promise<void> {
  switch (subjectType) {
    case "PLACE": {
      // Loaded (and existence-checked) by the ownership gate.
      if (ownership.place && ownership.place.status !== "ACTIVE") {
        throw fail("CONFLICT", {
          message: "place_not_active",
          meta: { reason: "place_not_active", status: ownership.place.status },
        });
      }
      return;
    }
    case "ORG": {
      const org = await tx.organizations.getById(subjectId);
      if (!org) {
        throw fail("ORGANIZATION_NOT_FOUND");
      }
      if (org.status !== "ACTIVE") {
        throw fail("ORGANIZATION_INACTIVE");
      }
      return;
    }
    case "HUMAN": {
      const human = await tx.humans.getById(subjectId);
      if (!human) {
        throw fail("HUMAN_NOT_FOUND");
      }
      if (human.status === "SUSPENDED" || human.status === "BANNED") {
        throw fail("CONFLICT", {
          message: "human_not_active",
          meta: { reason: "human_not_active", status: human.status },
        });
      }
      return;
    }
    case "EVENT": {
      // Loaded (and existence-checked) by the ownership gate. Mirrors the
      // agreements gate: only ARCHIVED blocks (upsert-agreement-for-event).
      if (ownership.event && ownership.event.status === "ARCHIVED") {
        throw fail("EVENT_ARCHIVED");
      }
      return;
    }
  }
}

function resolveDenormalizedOrgId(
  subjectType: "PLACE" | "ORG" | "HUMAN" | "EVENT",
  subjectId: string,
  ownership: AskOwnershipContext,
): string | null {
  switch (subjectType) {
    case "ORG":
      return subjectId;
    case "EVENT":
      // Non-null: the ownership gate rejects non-org-owned events.
      return ownership.event?.orgId ?? null;
    case "PLACE":
      // The acting human's GRANTING org when their access is org-based —
      // never an arbitrary member of orgIdsWithAccess. A direct human
      // owner creating an ask makes it theirs, not any org's, so no org
      // is stamped even when orgs also have access to the place.
      return ownership.placeAccess?.via === "org"
        ? ownership.placeAccess.orgId
        : null;
    case "HUMAN":
      return null;
  }
}
