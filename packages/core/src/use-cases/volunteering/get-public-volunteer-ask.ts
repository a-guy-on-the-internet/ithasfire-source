import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerAskCadence } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { isAskOwnerWithheld } from "./_shared/ask-owner-withheld";
import { askOffersTextReminders } from "./_shared/signup-reminder-anchor";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicVolunteerAskInputSchema = z
  .object({
    askId: z.string().uuid(),
  })
  .strict();

export type GetPublicVolunteerAskInput = z.infer<
  typeof getPublicVolunteerAskInputSchema
>;

/**
 * Publicly visible lifecycle states. DRAFT and ARCHIVED collapse to
 * `not_found` (no existence oracle); PAUSED and CLOSED are deliberately
 * readable so a shared signup link renders a friendly "not taking
 * signups right now" page instead of a hard 404 — the submit use case
 * independently refuses non-OPEN asks, so exposing the status here can
 * never open a signup path.
 */
export type PublicVolunteerAskStatus = "OPEN" | "PAUSED" | "CLOSED";

// Public DTO — intentionally narrower than `VolunteerAskRecord`. We strip
// the polymorphic subject (`subjectType`/`subjectId`), the denormalized
// `orgId`, `autoApprove`, and timestamps: none of them are needed to render
// the public signup page, and the subject/org ids would leak ownership
// internals to unauthenticated viewers (mirrors how the event public roles
// read strips admin-only fields).
export type PublicVolunteerAsk = {
  id: string;
  title: string;
  description: string | null;
  status: PublicVolunteerAskStatus;
  cadence: VolunteerAskCadence;
  startsAt: Date | null;
  endsAt: Date | null;
  /** IANA zone the window was stated in; null = not stated (older asks). */
  timezone: string | null;
  /** Soft cap across the whole ask — UI indicator only. */
  capacity: number | null;
  waiverRequired: boolean;
  /**
   * The organiser's old switch; gates nothing since 2026-10-17
   * (volunteer-ask-reminders R5). Read `textRemindersOffered` instead.
   */
  smsOptInEnabled: boolean;
  /**
   * A signup on this ask gets reminders, so the form may offer the text
   * opt-in (`askOffersTextReminders`, FR-001): one-time, with a start.
   */
  textRemindersOffered: boolean;
  /** Application questions (same shape as event application answers). */
  formSchema: unknown;
};

export type PublicVolunteerAskRole = {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  /** Hours stamped at check-in for shiftless ask roles — shown as "~N hrs". */
  defaultHours: number | null;
  sortOrder: number;
  /**
   * Accepted signups only (APPROVED | CHECKED_IN) — the number that counts
   * against `capacity`. PENDING never counts: capacity gates acceptance,
   * not application (mirrors `PublicVolunteerRole.acceptedCount`).
   */
  acceptedCount: number;
};

export type GetPublicVolunteerAskOutput = {
  ask: PublicVolunteerAsk;
  roles: PublicVolunteerAskRole[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPublicVolunteerAskDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public, unauthenticated read powering the generic ask signup page
 * (`/v/[askId]`). Sibling of `listPublicEventVolunteerRoles`, with one
 * deliberate divergence: the event read collapses every non-PUBLISHED
 * state to `not_found`, but an ask's PAUSED/CLOSED states remain readable
 * (see {@link PublicVolunteerAskStatus}) so an already-shared link can
 * render a friendly closed page. DRAFT and ARCHIVED still 404 uniformly —
 * the response never distinguishes "never existed" from "not yet / no
 * longer public".
 *
 * All reads run inside a single `repos.tx()` for consistency. Per-role
 * accepted counts come from `listSignupsByAsk` totals (2 count queries per
 * role) because no ask-scoped aggregate primitive exists yet — same
 * documented trade-off as `listAskRoster`.
 */
export async function getPublicVolunteerAsk(
  deps: GetPublicVolunteerAskDeps,
  rawInput: unknown,
): Promise<GetPublicVolunteerAskOutput> {
  const input = parseInput(getPublicVolunteerAskInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);

    // Conservative gate: missing, DRAFT, and ARCHIVED all collapse into the
    // same `not_found` shape (no existence oracle). So does a withheld
    // owner's ask (ban that sticks), matching the submit path's refusal.
    if (
      !ask ||
      ask.status === "DRAFT" ||
      ask.status === "ARCHIVED" ||
      (await isAskOwnerWithheld(tx, ask))
    ) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    const rawRoles = await tx.volunteering.listRolesByAsk(ask.id);

    const roles: PublicVolunteerAskRole[] = [];
    for (const role of rawRoles) {
      const [approved, checkedIn] = await Promise.all([
        tx.volunteering.listSignupsByAsk(ask.id, {
          roleId: role.id,
          status: "APPROVED",
          limit: 1,
        }),
        tx.volunteering.listSignupsByAsk(ask.id, {
          roleId: role.id,
          status: "CHECKED_IN",
          limit: 1,
        }),
      ]);
      roles.push({
        id: role.id,
        name: role.name,
        description: role.description,
        capacity: role.capacity,
        defaultHours: role.defaultHours,
        sortOrder: role.sortOrder,
        acceptedCount: approved.pageInfo.total + checkedIn.pageInfo.total,
      });
    }

    deps.logger?.info("volunteering.get_public_ask", {
      askId: ask.id,
      status: ask.status,
      roleCount: roles.length,
    });

    return {
      ask: {
        id: ask.id,
        title: ask.title,
        description: ask.description,
        status: ask.status,
        cadence: ask.cadence,
        startsAt: ask.startsAt,
        endsAt: ask.endsAt,
        timezone: ask.timezone,
        capacity: ask.capacity,
        waiverRequired: ask.waiverRequired,
        smsOptInEnabled: ask.smsOptInEnabled,
        textRemindersOffered: askOffersTextReminders(ask),
        formSchema: ask.formSchema,
      },
      roles,
    };
  });
}
