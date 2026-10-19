import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { requirePlaceOwnership } from "../booking-requests/_shared/place-access";
import { coerceEmbedDomainToHostname } from "./_shared/embed-domain";
import { requireCalendarSubjectAccess } from "./_shared/require-calendar-subject-access";
import { requireHumanSubjectAccess } from "./_shared/require-human-subject-access";
import { requireMembershipsSubjectAccess } from "./_shared/require-memberships-subject-access";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const ALLOWED_SUBJECT_TYPES = [
  "event",
  "organization",
  "place",
  "human",
  /**
   * Membership-tiers widget (recurring-memberships spec, owner flow step 3).
   * `subjectId` is the tier OWNER's id — an Organization id or a Human id —
   * resolved org-first (see `requireMembershipsSubjectAccess`). A distinct
   * subject type (rather than reusing organization/human) so the memberships
   * widget's domain allowlist is its OWN row: revoking an events embed never
   * kills the memberships embed on the same domain, and vice versa.
   */
  "memberships",
  /**
   * Named-calendar widget (venue-hierarchy FR-010): the events widget
   * filtered to ONE Calendar's PUBLISHED events. `subjectId` is a Calendar
   * id; managing it requires place-edit access on the calendar's place
   * (`requireCalendarSubjectAccess`). NOTE the vocabulary split pinned in the
   * spec header: subjectType `"calendar"` names the ENTITY; `defaultView:
   * "calendar"` names a browse VIEW — both words are legal on one row.
   */
  "calendar",
] as const;

/**
 * The browse-view vocabulary. THIS is the authority the DB column defers to —
 * `Embed.defaultView` is a bare String, not a Postgres enum, exactly so this
 * list can grow without a migration (same convention as `subjectType`).
 * Ships as exactly list | calendar (spec out_of_scope: no week/day/map views).
 */
export const EMBED_VIEWS = ["list", "calendar"] as const;
export type EmbedView = (typeof EMBED_VIEWS)[number];

/**
 * Pre-refinement object schema. The place-subject cross-field rule below is a
 * `.superRefine()`, and zod v4 refuses `.omit()` on a schema carrying
 * refinements — so transport derives its public input from THIS base and the
 * use case re-validates with the refined schema (the exact split
 * `createBookingInquiryBaseSchema` uses, for the same reason).
 */
export const upsertEmbedBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    subjectType: z.enum(ALLOWED_SUBJECT_TYPES),
    subjectId: z.uuid(),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .transform((v) => v.toLowerCase()),
    requireAuth: z.boolean().optional(),
    linkOut: z.boolean().optional(),
    /**
     * Browse view a bare /embed/[id] renders. Omitted ⇒ the stored value is
     * PRESERVED on an existing (subject, domain) row (and defaults to "list"
     * on create), mirroring how the admin page's linkOut control works.
     */
    defaultView: z.enum(EMBED_VIEWS).optional(),
    /** Render a viewer-facing List/Calendar switcher. Omitted ⇒ preserved. */
    viewToggle: z.boolean().optional(),
  })
  .strict();

/**
 * Fields that make no sense for a "place" or "memberships" subject: the
 * booking-button and membership-tiers embeds are separate products (their own
 * routes and procedures, no list/calendar browse), not views of the events
 * widget. Sending one is a caller bug, so it is REJECTED (validation error)
 * rather than silently dropped.
 */
const VIEW_FIELDS = ["defaultView", "viewToggle"] as const;

/** Subject types with NO browse views (see `VIEW_FIELDS`). */
const VIEWLESS_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "place",
  "memberships",
]);

export const upsertEmbedInputSchema = upsertEmbedBaseSchema.superRefine(
  (value, ctx) => {
    if (!VIEWLESS_SUBJECT_TYPES.has(value.subjectType)) return;
    for (const field of VIEW_FIELDS) {
      if (value[field] === undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [field],
        message:
          "Booking (place) and memberships embeds have no views — remove defaultView / viewToggle.",
      });
    }
  },
);

export const upsertEmbedOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
      domain: z.string(),
      status: z.string(),
      requireAuth: z.boolean(),
      linkOut: z.boolean(),
      /**
       * Bare string, not `z.enum(EMBED_VIEWS)`, matching `subjectType`/`status`
       * above: read paths surface whatever is STORED so a row written under a
       * future/rolled-back vocabulary can't make the read path throw.
       */
      defaultView: z.string(),
      viewToggle: z.boolean(),
      createdAt: z.date(),
    }),
  })
  .strict();

export type UpsertEmbedInput = z.infer<typeof upsertEmbedInputSchema>;
export type UpsertEmbedOutput = z.infer<typeof upsertEmbedOutputSchema>;

export type UpsertEmbedDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function upsertEmbed(
  deps: UpsertEmbedDeps,
  rawInput: unknown,
): Promise<UpsertEmbedOutput> {
  const logger = deps.logger?.child({ useCase: "upsertEmbed" });

  const execute = async () => {
    const input = parseInput(upsertEmbedInputSchema, rawInput);

    // ── Normalize domain to a bare hostname ──────────────────────────
    // Organisers paste "https://example.com" / "example.com/" — store the
    // hostname the origin allowlist actually compares against, or reject
    // outright so a never-matchable value can't be persisted. The message is
    // human-readable on purpose: the admin toast surfaces it verbatim.
    const domain = coerceEmbedDomainToHostname(input.domain);
    if (!domain) {
      throw fail("EMBED_DOMAIN_INVALID", {
        message:
          "Enter a valid domain such as example.com (no spaces or unusual characters).",
      });
    }

    // ── Authorization ────────────────────────────────────────────────
    if (input.subjectType === "organization") {
      const org = await deps.repos.organizations.getById(input.subjectId);
      if (!org) {
        throw fail("ORGANIZATION_NOT_FOUND");
      }
      await requireOrgMembership({
        repos: deps.repos,
        orgId: org.id,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });
    } else if (input.subjectType === "human") {
      // Personal (non-org) admin context. The actor may only manage their OWN
      // human subject — see the helper for why there is no delegation model.
      await requireHumanSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "memberships") {
      // Membership-tiers widget. subjectId = the tier owner (org or human);
      // org-first resolution + the per-kind gates live in the helper.
      await requireMembershipsSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "calendar") {
      // Named-calendar widget (venue-hierarchy FR-010). Place-edit access on
      // the calendar's OWN place — resolution + gate live in the helper.
      // Like the place subject, NOT gated on verification (the PUBLIC read
      // path gates on VERIFIED + ACTIVE instead — see the helper doc).
      await requireCalendarSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "place") {
      // Place subject (booking-request button). Same venue-owner gate as the
      // booking inbox: direct human owner, or owning-org member with an
      // edit-level role.
      //
      // Deliberately NOT gated on verificationStatus / acceptsBookingRequests:
      // owners may register their website's domain while verification is
      // still pending — the widget READ path (get-booking-widget) reports
      // `accepting: false` until the place is VERIFIED and opted in, and
      // createBookingInquiry re-checks server-side. Allowing early setup
      // keeps onboarding friction low without opening any request intake.
      const place = await deps.repos.places.getById(input.subjectId);
      if (!place) {
        throw fail("PLACE_NOT_FOUND");
      }
      await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
        requiredOrgRoles: ORG_EDIT_ROLES,
      });
    } else {
      // event subject
      const event = await deps.repos.events.getById(input.subjectId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (event.status !== "PUBLISHED") {
        throw fail("EVENT_NOT_PUBLISHED");
      }

      if (event.orgId) {
        await requireOrgMembership({
          repos: deps.repos,
          orgId: event.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_EDIT_ROLES,
          errorCode: "INSUFFICIENT_ROLE",
        });
      } else {
        await ensureActorHoldsHumanEventRole(
          deps.repos.authz,
          event.humanId,
          input.actorHumanId,
        );
      }
    }

    const embed = await deps.repos.tx(async (tx) => {
      const record = await tx.embeds.upsert({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        domain,
        createdBy: input.actorHumanId,
        requireAuth: input.requireAuth,
        linkOut: input.linkOut,
        defaultView: input.defaultView,
        viewToggle: input.viewToggle,
      });

      await tx.audit.log({
        entity: "embed",
        entityId: record.id,
        action: "upsert_embed",
        data: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          domain,
          actorHumanId: input.actorHumanId,
          requireAuth: input.requireAuth,
          linkOut: input.linkOut,
          defaultView: input.defaultView,
          viewToggle: input.viewToggle,
        },
      });

      return record;
    });

    return {
      embed: {
        id: embed.id,
        subjectType: embed.subjectType,
        subjectId: embed.subjectId,
        domain: embed.domain,
        status: embed.status,
        requireAuth: embed.requireAuth,
        linkOut: embed.linkOut,
        defaultView: embed.defaultView,
        viewToggle: embed.viewToggle,
        createdAt: embed.createdAt,
      },
    };
  };

  if (logger) {
    return logger.withTime("upsertEmbed", execute);
  }
  return execute();
}
