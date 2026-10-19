import { TRPCError } from "@trpc/server";
import type { HumanRole } from "@th/ports/authz";
import { z } from "zod";

import {
  listPlatformPlaces,
  listPlatformPlacesInputSchema,
  listPlatformPlacesOutputSchema,
  updatePlaceVerificationStatus,
  updatePlaceVerificationStatusInputSchema,
  updatePlaceVerificationStatusOutputSchema,
  reviewPlaceVerification,
  reviewPlaceVerificationInputSchemaBase,
  REVIEWER_NOTES_REFINEMENT,
  reviewPlaceVerificationWireOutputSchema,
  getVerificationRequest,
  getVerificationRequestInputSchema,
  getVerificationRequestInputSchemaBase,
  getVerificationRequestOutputSchema,
  mergePlaces,
  mergePlacesInputSchema,
  mergePlacesOutputSchema,
  previewPlaceMerge,
  previewPlaceMergeInputSchema,
  previewPlaceMergeOutputSchema,
} from "@th/core/use-cases/places";

import {
  listPlatformOrders,
  listPlatformOrdersInputSchema,
  listPlatformOrdersOutputSchema,
} from "@th/core/use-cases/orders";

import {
  listAllSettlements,
  listAllSettlementsInputSchema,
  listAllSettlementsOutputSchema,
} from "@th/core/use-cases/settlements/list-all-settlements";

import {
  listPlatformTickets,
  listPlatformTicketsInputSchema,
  listPlatformTicketsOutputSchema,
} from "@th/core/use-cases/tickets/list-platform-tickets";

import {
  getTaxNexusRollup,
  getTaxNexusRollupInputSchema,
  getTaxNexusRollupOutputSchema,
} from "@th/core/use-cases/tax/get-tax-nexus-rollup";

import {
  getPlatformSettings,
  getPlatformSettingsInputSchema,
  getPlatformSettingsOutputSchema,
  updatePlatformSetting,
  updatePlatformSettingInputSchema,
  updatePlatformSettingOutputSchema,
  getThemePresets,
  getThemePresetsOutputSchema,
  saveThemePreset,
  saveThemePresetInputSchema,
  saveThemePresetOutputSchema,
  activateThemePreset,
  activateThemePresetInputSchema,
  activateThemePresetOutputSchema,
  deleteThemePreset,
  deleteThemePresetInputSchema,
  deleteThemePresetOutputSchema,
  getGlobalFeePolicy,
  getGlobalFeePolicyInputSchema,
  getGlobalFeePolicyOutputSchema,
  listFeeWaivers,
  listFeeWaiversInputSchema,
  listFeeWaiversOutputSchema,
  grantFeeWaiver,
  grantFeeWaiverInputSchemaBase,
  grantFeeWaiverOutputSchema,
  revokeFeeWaiver,
  revokeFeeWaiverInputSchema,
  revokeFeeWaiverOutputSchema,
  type FeeWaiverDeps,
  getPlatformStats,
  getPlatformStatsInputSchema,
  getPlatformStatsOutputSchema,
  adminSetHumanStatus,
  adminSetHumanStatusInputSchema,
  adminSetHumanStatusOutputSchema,
  listFlaggedSignups,
  listFlaggedSignupsInputSchema,
  listFlaggedSignupsOutputSchema,
  adminForceVerifyEmail,
  adminForceVerifyEmailInputSchema,
  adminForceVerifyEmailOutputSchema,
  adminUnlinkAuthAccount,
  adminUnlinkAuthAccountInputSchema,
  adminUnlinkAuthAccountOutputSchema,
  adminDeleteHuman,
  adminDeleteHumanInputSchema,
  adminDeleteHumanOutputSchema,
  adminBulkDeletePlaces,
  adminBulkDeletePlacesInputSchema,
  adminBulkDeletePlacesOutputSchema,
  adminGrantHumanRole,
  adminGrantHumanRoleInputSchema,
  adminGrantHumanRoleOutputSchema,
  adminRevokeHumanRole,
  adminRevokeHumanRoleInputSchema,
  adminRevokeHumanRoleOutputSchema,
  listAuditLogs,
  listAuditLogsInputSchema,
  listAuditLogsOutputSchema,
  listPayeeDebtPositions,
  listPayeeDebtPositionsInputSchema,
  listPayeeDebtPositionsOutputSchema,
  listUnrecoveredCashDebts,
  listUnrecoveredCashDebtsInputSchema,
  listUnrecoveredCashDebtsOutputSchema,
  listPayablePositions,
  listPayablePositionsInputSchema,
  listPayablePositionsOutputSchema,
  listPayoutHistory,
  listPayoutHistoryInputSchema,
  listPayoutHistoryOutputSchema,
  listUpcomingPayouts,
  listUpcomingPayoutsInputSchema,
  listUpcomingPayoutsOutputSchema,
  getPlatformRevenue,
  getPlatformRevenueInputSchema,
  getPlatformRevenueOutputSchema,
  summariseRecurringRevenue,
  summariseRecurringRevenueInputSchema,
  summariseRecurringRevenueOutputSchema,
  listMembershipPositions,
  listMembershipPositionsInputSchema,
  listMembershipPositionsOutputSchema,
} from "@th/core/use-cases/platform";

import {
  listAllPromos,
  listAllPromosInputSchema,
  listAllPromosOutputSchema,
} from "@th/core/use-cases/promos";

import {
  listPlatformHumans,
  listPlatformHumansInputSchema,
  listPlatformHumansOutputSchema,
} from "@th/core/use-cases/humans";

import {
  getMembershipStandingOverview,
  getMembershipStandingOverviewInputSchema,
  getMembershipStandingOverviewOutputSchema,
  overrideMembershipStanding,
  overrideMembershipStandingInputSchema,
  overrideMembershipStandingOutputSchema,
  suspendMembershipStanding,
  suspendMembershipStandingInputSchema,
  suspendMembershipStandingOutputSchema,
} from "@th/core/use-cases/memberships";

import { staffSecondFactorBypassEnabled } from "../dev-staff-2fa-bypass";
import { authedProcedure, publicProcedure } from "../init";
import { ticketPacksRouter } from "./ticket-packs";
import { disputesRouter } from "./disputes";
import { toTrpcError } from "../utils";

/**
 * Staff roles that grant access to the /platform area.
 * USER is excluded — only humans with elevated roles can enter.
 */
const PLATFORM_STAFF_ROLES: HumanRole[] = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
];

/**
 * Roles allowed to MUTATE a place's verification state from /platform/places
 * (staff verify + the "Waive verification" action).
 *
 * Narrower than PLATFORM_STAFF_ROLES on purpose: verification is trust state,
 * and SUPPORT/DEVELOPER have no business flipping it. This matches
 * `STAFF_VERIFIER_ROLES` inside `updatePlaceVerificationStatus` and the
 * `STAFF_REVIEWER_ROLES` gate on acknowledge/review/release, so a caller that
 * clears this transport pre-check also clears the use case's own staff bypass
 * instead of silently falling through to org-membership governance.
 */
const VERIFICATION_DECISION_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

const PUBLIC_SETTING_KEYS = ["homepage:heroStyle"] as const;

/**
 * Asserts an authenticated actor is present and returns their human id.
 * The use cases re-check the ADMIN role themselves; this only rejects
 * unauthenticated callers before we bother constructing deps.
 */
function requireStaffActor(ctx: { actorHumanId?: string | null }): string {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

function feeWaiverDeps(ctx: {
  repos: FeeWaiverDeps["repos"];
  authz: FeeWaiverDeps["authz"];
  logger?: FeeWaiverDeps["logger"];
  reportError?: FeeWaiverDeps["reportError"] | null;
}): FeeWaiverDeps {
  return {
    repos: ctx.repos,
    authz: ctx.authz,
    logger: ctx.logger,
    reportError: ctx.reportError ?? undefined,
  };
}

/**
 * Settings that feed the email footer defaults cache. Writing any of these
 * invalidates the cache so the next render reflects the change immediately.
 */
const FOOTER_AFFECTING_SETTING_KEYS = new Set([
  "email:physicalAddress",
  "supportEmail",
  "platformName",
]);

const listPlatformPlacesProcedureInput = listPlatformPlacesInputSchema.omit({
  actorHumanId: true,
});
const staffUpdateVerificationInput =
  updatePlaceVerificationStatusInputSchema.omit({ actorHumanId: true });
const reviewVerificationInput = reviewPlaceVerificationInputSchemaBase
  .omit({ actorHumanId: true })
  .refine(
    REVIEWER_NOTES_REFINEMENT.predicate,
    REVIEWER_NOTES_REFINEMENT.options,
  );
const getVerificationRequestInput = getVerificationRequestInputSchemaBase.omit({
  actorHumanId: true,
});

export const platformRouter = {
  /**
   * Ticket packs — staff catalogue CRUD (ticket-type-packs spec FR-012).
   * Nested here ON PURPOSE so every procedure lives under `platform.*` and
   * inherits the wholesale staff second-factor gate in guard.ts, unlike the
   * top-level `volunteerPacks.admin.*` placement (which gets no early
   * `SECOND_FACTOR_REQUIRED`; not a precedent to copy).
   *
   * Scope note: that gate picks the early `SECOND_FACTOR_REQUIRED` code and
   * is keyed on the tRPC PATH PREFIX, not on the underlying use case. The
   * rule itself is the authz port's, so a sibling procedure in another
   * router calling the same core function is refused too, but under its own
   * role error unless it is listed in `SECOND_FACTOR_GATED_MODERATION_PATHS`
   * (or passes its staff probe to `throwIfStaffSecondFactorRequired`).
   */
  ticketPacks: ticketPacksRouter,

  /**
   * Dispute desk — chargeback evidence assemble / edit / approve / submit
   * plus the staff queue reads. Same nesting rationale as ticketPacks:
   * `platform.disputes.*` inherits the wholesale second-factor gate.
   */
  disputes: disputesRouter,

  /**
   * Lightweight probe: "does the current actor have platform staff access?"
   *
   * Returns the actor's staff roles so the shell can tailor navigation
   * (e.g. REVIEWER sees the verification queue, ADMIN sees everything).
   * Also surfaces `actorHumanId` — the /platform/roles UI uses it to detect
   * "is this table row the acting admin's own row" for the last-ADMIN
   * self-revoke confirmation guard (client-side defense-in-depth; the
   * authoritative last-ADMIN-lockout check lives server-side in
   * `adminRevokeHumanRole`).
   */
  checkStaffAccess: authedProcedure
    .output(
      z.object({
        allowed: z.boolean(),
        roles: z.array(z.string()),
        actorHumanId: z.string().uuid(),
        // Whether the actor has an enrolled second factor (passkey or TOTP).
        // Deliberately excluded from `requireStaffSecondFactor`'s gated-path
        // allowlist (packages/transport/trpc/src/guard.ts) — this probe must
        // keep answering for staff missing a 2nd factor so the client shell
        // (PlatformShell) can redirect to the friendly `/enroll-2fa` prompt
        // instead of a raw tRPC error. `false` (not computed) when the actor
        // isn't staff at all — moot in that case.
        secondFactorEnrolled: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const result = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
        // Status probe: answers on the role so the shell can redirect.
        allowWithoutSecondFactor: true,
      });

      if (!result.allowed) {
        return {
          allowed: false,
          roles: [],
          actorHumanId,
          secondFactorEnrolled: false,
        };
      }

      // Fetch the actual roles for the UI to use
      const staffRoles =
        await ctx.repos.authz.getStaffRolesForHumanId(actorHumanId);
      // Must agree with the dev bypass the authz port is built with, or the
      // shell would redirect to /enroll-2fa while the API happily served the
      // calls.
      const secondFactorEnrolled =
        staffSecondFactorBypassEnabled ||
        (await ctx.repos.humans.hasSecondFactorEnrolled(actorHumanId));

      return {
        allowed: true,
        roles: staffRoles.filter((r) => PLATFORM_STAFF_ROLES.includes(r)),
        actorHumanId,
        secondFactorEnrolled,
      };
    }),

  /**
   * Staff-only list of all places, filterable by verification status and
   * by place `status` (the Active / Archived / All chips). Each row carries
   * `publicPath`, the place's public page path or null.
   * Powers the /platform/places verification queue.
   */
  listPlaces: authedProcedure
    .input(listPlatformPlacesProcedureInput)
    .output(listPlatformPlacesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPlatformPlaces>[0];

      try {
        return await listPlatformPlaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only mutation to update a place's verification status. This is the
   * ONLY transport that can drive a place to VERIFIED/REJECTED: the org-side
   * `places.updatePlaceVerificationStatus` twin was deleted as a
   * privilege-escalation hole (an org admin could self-issue a verified
   * badge through it, and it sat outside the `platform.*` 2FA prefix gate).
   * The use case itself now also refuses terminal decisions from non-staff
   * actors, so this guarantee does not depend on transport shape alone.
   *
   * Org ownership is NOT required here — ADMIN/REVIEWER staff can verify any
   * place.
   *
   * Also backs the /platform/places "Waive verification" action, which sends
   * `reason: "WAIVED_DOCUMENT_REVIEW"` (+ an optional note) so the audit row
   * distinguishes a deliberate skip of document review from a plain verify.
   * Same use case, same transaction, same audit write — no forked path.
   */
  updatePlaceVerificationStatus: authedProcedure
    .input(staffUpdateVerificationInput)
    .output(updatePlaceVerificationStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      // Pre-check: require a verification-decision role before forwarding.
      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: VERIFICATION_DECISION_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      const deps = {
        repos: ctx.repos,
        // MUST be passed: without it the use case's staff bypass is skipped
        // entirely and every call falls through to org-membership governance,
        // so staff could not act on a place their own org doesn't own.
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updatePlaceVerificationStatus>[0];

      try {
        return await updatePlaceVerificationStatus(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only economic-nexus threshold watch: net facilitated sales + tax
   * collected grouped by frozen tax situs (country + state/province) over a
   * rolling window (spec 2026-07-01 §5.3).
   */
  taxNexusRollup: authedProcedure
    .input(getTaxNexusRollupInputSchema.omit({ actorHumanId: true }))
    .output(getTaxNexusRollupOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getTaxNexusRollup>[0];

      try {
        return await getTaxNexusRollup(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only paginated list of all orders across orgs.
   * Powers the /platform/orders page.
   */
  listOrders: authedProcedure
    .input(listPlatformOrdersInputSchema.omit({ actorHumanId: true }))
    .output(listPlatformOrdersOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPlatformOrders>[0];

      try {
        return await listPlatformOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only (ADMIN + REVIEWER) paginated, filterable list of platform
   * audit-log rows. Powers the read-only /platform/audit-log viewer — NOT
   * the org-scoped /admin/[slug]/activity surface (a separate, out-of-scope
   * feature; see docs/specs/2026-03-03/audit-log-viewer.md).
   */
  listAuditLogs: authedProcedure
    .input(listAuditLogsInputSchema.omit({ actorHumanId: true }))
    .output(listAuditLogsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listAuditLogs>[0];

      try {
        return await listAuditLogs(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only paginated list of all tickets across orgs.
   * Powers the /platform/tickets page.
   */
  listTickets: authedProcedure
    .input(listPlatformTicketsInputSchema.omit({ actorHumanId: true }))
    .output(listPlatformTicketsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPlatformTickets>[0];

      try {
        return await listPlatformTickets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: retrieve a verification request with documents and signed view URLs.
   */
  getVerificationRequest: authedProcedure
    .input(getVerificationRequestInput)
    .output(getVerificationRequestOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        storage: ctx.fileStorage,
        logger: ctx.logger,
      } satisfies Parameters<typeof getVerificationRequest>[0];

      try {
        return await getVerificationRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: approve or reject a place verification request.
   * Replaces the simple updatePlaceVerificationStatus for KYB-reviewed places.
   */
  reviewPlaceVerification: authedProcedure
    .input(reviewVerificationInput)
    .output(reviewPlaceVerificationWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof reviewPlaceVerification>[0];

      let result;
      try {
        result = await reviewPlaceVerification(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      return reviewPlaceVerificationWireOutputSchema.parse(result);
    }),

  /**
   * Staff-only paginated list of all settlements across orgs.
   * Powers the /platform/settlements page.
   */
  listSettlements: authedProcedure
    .input(listAllSettlementsInputSchema.omit({ actorHumanId: true }))
    .output(listAllSettlementsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listAllSettlements>[0];

      try {
        return await listAllSettlements(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: get platform settings.
   * Powers the /platform/settings admin page.
   */
  getSettings: authedProcedure
    .input(getPlatformSettingsInputSchema)
    .output(getPlatformSettingsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      // Pre-check staff access
      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await getPlatformSettings(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only mutation: update a single platform setting.
   * Requires ADMIN or DEVELOPER role.
   */
  updateSetting: authedProcedure
    .input(updatePlatformSettingInputSchema.omit({ actorHumanId: true }))
    .output(updatePlatformSettingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        const result = await updatePlatformSetting(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
        // Unconditional, unlike the footer cache below: this cache holds the
        // whole PlatformSetting table, so ANY key changing makes the snapshot
        // stale. `updatePlatformSetting` writes inside `repos.tx(...)`, and a
        // transaction-scoped repo is not the cached instance — so without this
        // the writer would keep reading pre-write values until the TTL lapsed.
        ctx.platformSettingsCache?.invalidate();
        if (FOOTER_AFFECTING_SETTING_KEYS.has(input.key)) {
          ctx.footerDefaultsCache?.invalidate();
        }
        return result;
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: fetch a subset of platform settings safe for unauthenticated
   * consumption. Only keys in PUBLIC_SETTING_KEYS are returned.
   */
  getPublicSettings: publicProcedure
    .input(
      z
        .object({
          keys: z.array(z.enum(PUBLIC_SETTING_KEYS)).min(1),
        })
        .strict(),
    )
    .output(getPlatformSettingsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const result = await getPlatformSettings(
          { repos: ctx.repos, logger: ctx.logger },
          { keys: input.keys },
        );
        return {
          ...result,
          settings: result.settings.filter((s) =>
            PUBLIC_SETTING_KEYS.includes(
              s.key as (typeof PUBLIC_SETTING_KEYS)[number],
            ),
          ),
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: resolve the platform-level email footer defaults (mailing
   * address, contact email, brand name). These values appear in every
   * outgoing email footer, so they are not secret — exposing them lets the
   * admin event-builder render a faithful email preview that includes the
   * exact footer recipients will see, without requiring platform-staff access
   * to the full settings list.
   */
  getFooterDefaults: publicProcedure
    .output(
      z
        .object({
          physicalAddress: z.string().nullable(),
          contactEmail: z.string().nullable(),
          brandName: z.string().nullable(),
        })
        .strict(),
    )
    .query(async ({ ctx }) => {
      const defaults = (await ctx.footerDefaultsCache?.resolve()) ?? {};
      return {
        physicalAddress: defaults.physicalAddress ?? null,
        contactEmail: defaults.contactEmail ?? null,
        brandName: defaults.brandName ?? null,
      };
    }),

  // ── Theme Presets ───────────────────────────────────────────────────────

  /**
   * Public: get the currently active theme preset + its tokens.
   * Used at app boot to inject seasonal CSS variables.
   */
  getActiveTheme: publicProcedure
    .output(
      getThemePresetsOutputSchema.pick({ presets: true, activeSlug: true }),
    )
    .query(async ({ ctx }) => {
      try {
        return await getThemePresets({ repos: ctx.repos, logger: ctx.logger });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: list all theme presets (built-in + custom) with active slug.
   */
  getThemePresets: authedProcedure
    .output(getThemePresetsOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await getThemePresets({ repos: ctx.repos, logger: ctx.logger });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: save (create or update) a custom theme preset.
   */
  saveThemePreset: authedProcedure
    .input(saveThemePresetInputSchema.omit({ actorHumanId: true }))
    .output(saveThemePresetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await saveThemePreset(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: activate a theme preset (or null to revert to default).
   */
  activateThemePreset: authedProcedure
    .input(activateThemePresetInputSchema.omit({ actorHumanId: true }))
    .output(activateThemePresetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await activateThemePreset(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: delete a custom theme preset.
   */
  deleteThemePreset: authedProcedure
    .input(deleteThemePresetInputSchema.omit({ actorHumanId: true }))
    .output(deleteThemePresetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await deleteThemePreset(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Fee-policy endpoints (global) ──────────────────────────────────

  /**
   * Returns the current GLOBAL fee policy. Staff-only.
   */
  getGlobalFeePolicy: authedProcedure
    .input(getGlobalFeePolicyInputSchema.omit({ actorHumanId: true }))
    .output(getGlobalFeePolicyOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await getGlobalFeePolicy(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // READ-ONLY BY DESIGN — there is no `upsertGlobalFeePolicy` counterpart and
  // one must not be re-added. The GLOBAL fee policy is defined in code
  // (`packages/core/src/lib/pricing/platform-fee-policy.ts`) and materialized
  // into the DB by `apps/api/src/scripts/reference-data/seed-platform-fee-policy.ts` on every
  // deploy. A staff hand-edit would be silently reverted on the next deploy,
  // after minting a policy version and (because buyer totals are fee-inclusive
  // in search documents) invalidating the indexed price of every published
  // event. Change the constant, ship it, review it as a diff.

  // ── Fee waivers ─────────────────────────────────────────────────────────
  // A consumable allowance that zeroes the platform fee on N tickets for a
  // human or org. All three are ADMIN-only: a waiver is forgone revenue.

  listFeeWaivers: authedProcedure
    .input(listFeeWaiversInputSchema.omit({ actorHumanId: true }))
    .output(listFeeWaiversOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listFeeWaivers(feeWaiverDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  grantFeeWaiver: authedProcedure
    .input(grantFeeWaiverInputSchemaBase.omit({ actorHumanId: true }))
    .output(grantFeeWaiverOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await grantFeeWaiver(feeWaiverDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  revokeFeeWaiver: authedProcedure
    .input(revokeFeeWaiverInputSchema.omit({ actorHumanId: true }))
    .output(revokeFeeWaiverOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await revokeFeeWaiver(feeWaiverDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Platform-level aggregate stats: order counts, revenue, fees, events, etc.
   * Staff-only (any platform role).
   */
  getStats: authedProcedure
    .input(getPlatformStatsInputSchema)
    .output(getPlatformStatsOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await getPlatformStats(
          { repos: ctx.repos, logger: ctx.logger },
          {},
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public-facing aggregate stats for marketing pages (about, etc.).
   * Returns only safe counts — no revenue or fee data.
   */
  getPublicStats: publicProcedure
    .output(
      z
        .object({
          totalEvents: z.number().int(),
          totalTicketsSold: z.number().int(),
          totalOrganizations: z.number().int(),
        })
        .strict(),
    )
    .query(async ({ ctx }) => {
      try {
        const stats = await getPlatformStats(
          { repos: ctx.repos, logger: ctx.logger },
          {},
        );
        return {
          totalEvents: stats.totalEvents,
          totalTicketsSold: stats.totalTicketsSold,
          totalOrganizations: stats.totalOrganizations,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Staff-only list of all promos. */
  listPromos: authedProcedure
    .input(listAllPromosInputSchema)
    .output(listAllPromosOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await listAllPromos(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only paginated list of all humans with identity + org memberships.
   * Powers the /platform/humans admin page.
   */
  listHumans: authedProcedure
    .input(listPlatformHumansInputSchema.omit({ actorHumanId: true }))
    .output(listPlatformHumansOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listPlatformHumans>[0];

      try {
        return await listPlatformHumans(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Staff-only: accounts that signed up in the last 30 days from a network a
   * BANNED human used. Derived on every read (never a stored flag); powers
   * the "Flagged sign-ups" filter on /platform/humans. Same staff bar as
   * `listHumans`; the `platform.*` prefix carries the second-factor gate.
   */
  listFlaggedSignups: authedProcedure
    .input(listFlaggedSignupsInputSchema.omit({ actorHumanId: true }))
    .output(listFlaggedSignupsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listFlaggedSignups(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Human Management Mutations (ADMIN-only) ─────────────────────────

  /**
   * ADMIN-only: change a human's status (ACTIVE, SUSPENDED, BANNED).
   * Invalidates all sessions on suspend/ban.
   */
  setHumanStatus: authedProcedure
    .input(adminSetHumanStatusInputSchema.omit({ actorHumanId: true }))
    .output(adminSetHumanStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminSetHumanStatus(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            identitySecret: ctx.identityHashSecret ?? null,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: grant a platform HumanRole to a target human.
   * Powers the /platform/roles admin UI. The bootstrap path for the very
   * first ADMIN remains `pnpm seed:admin` (apps/api/src/scripts/reference-data/seed-platform-admin.ts) —
   * this mutation cannot be used until at least one ADMIN already exists.
   */
  grantRole: authedProcedure
    .input(adminGrantHumanRoleInputSchema.omit({ actorHumanId: true }))
    .output(adminGrantHumanRoleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminGrantHumanRole(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: revoke a platform HumanRole from a target human.
   * Powers the /platform/roles admin UI.
   */
  revokeRole: authedProcedure
    .input(adminRevokeHumanRoleInputSchema.omit({ actorHumanId: true }))
    .output(adminRevokeHumanRoleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminRevokeHumanRole(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: force-verify a human's email address.
   */
  forceVerifyEmail: authedProcedure
    .input(adminForceVerifyEmailInputSchema.omit({ actorHumanId: true }))
    .output(adminForceVerifyEmailOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminForceVerifyEmail(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: unlink an OAuth provider from a human's account.
   * Invalidates all sessions to force re-auth.
   */
  unlinkAuthAccount: authedProcedure
    .input(adminUnlinkAuthAccountInputSchema.omit({ actorHumanId: true }))
    .output(adminUnlinkAuthAccountOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminUnlinkAuthAccount(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: permanently delete a human and all associated data.
   * Requires the human's email as a confirmation phrase.
   */
  deleteHuman: authedProcedure
    .input(adminDeleteHumanInputSchema.omit({ actorHumanId: true }))
    .output(adminDeleteHumanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await adminDeleteHuman(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: permanently delete places in bulk.
   */
  adminBulkDeletePlaces: authedProcedure
    .input(adminBulkDeletePlacesInputSchema.omit({ actorHumanId: true }))
    .output(adminBulkDeletePlacesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_STAFF_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff access required",
        });
      }

      try {
        return await adminBulkDeletePlaces(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only, read-only: what merging `mergedId` into `survivorId` would
   * move, fill and refuse (merge-duplicate-places FR-002). Authorization is
   * the use case's (ADMIN staff).
   */
  previewPlaceMerge: authedProcedure
    .input(previewPlaceMergeInputSchema.omit({ actorHumanId: true }))
    .output(previewPlaceMergeOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await previewPlaceMerge(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: merge a duplicate place into the one that stays, then delete
   * it (merge-duplicate-places FR-001). A refusal is CONFLICT with
   * `meta.reason === "PLACE_MERGE_BLOCKED"` and `meta.blockers`.
   */
  mergePlaces: authedProcedure
    .input(mergePlacesInputSchema.omit({ actorHumanId: true }))
    .output(mergePlacesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await mergePlaces(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            search: ctx.multiSearch ?? undefined,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * ADMIN-only: list OAuth/credential accounts linked to a human.
   * Used by the Manage Accounts dialog.
   */
  listHumanAuthAccounts: authedProcedure
    .input(z.object({ humanId: z.string().uuid() }))
    .output(
      z.array(
        z.object({
          providerId: z.string(),
          accountId: z.string(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Admin access required",
        });
      }

      try {
        return await ctx.repos.humans.listAuthAccounts(input.humanId);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Membership standing (ADMIN-only) ─────────────────────────────────
  // Risk tools from the recurring-memberships spec: dispute-fee exposure per
  // owner, rolling-reserve override, suspend/unsuspend. The use cases enforce
  // the ADMIN staff role themselves (STAFF_ONLY), mirroring fee waivers.

  /**
   * Per-owner membership risk overview: tiers, live members, standing
   * (suspension + reserve) and dispute-fee exposure on MEMBERSHIP orders.
   * Powers /platform/memberships.
   */
  listMembershipStandings: authedProcedure
    .input(
      getMembershipStandingOverviewInputSchema.omit({ actorHumanId: true }),
    )
    .output(getMembershipStandingOverviewOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await getMembershipStandingOverview(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHAT WE OWE. Positive payable cells from the SAME ledger read the payout
   * batch plans from (`payeeLedger.listPayableBalances`), plus — as a
   * SEPARATE field, never summed into it — the maturity-free outstanding
   * liability. Powers the "Payouts owed" section of /platform/settlements.
   * The use case enforces ADMIN|SUPPORT itself (STAFF_ONLY).
   */
  listPayablePositions: authedProcedure
    // `.optional()`, because the omit leaves an EMPTY object and a required
    // empty object 400s the no-argument call every client actually makes
    // (`useQuery()` sends `undefined`). Strictness survives: a caller that
    // DOES pass an object still has its unknown keys refused.
    .input(listPayablePositionsInputSchema.omit({ actorHumanId: true }).optional())
    .output(listPayablePositionsOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listPayablePositions(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHAT WE PAID. One row per PayoutItem — when, how much, to whom, and the
   * deductions that explain the number — newest first. Powers the "Payouts
   * sent" section of /platform/settlements. The use case enforces
   * ADMIN|SUPPORT itself (STAFF_ONLY); cursor-paged, so it is fetched with
   * `utils.fetch`, never `useInfiniteQuery` (strict input).
   */
  listPayoutHistory: authedProcedure
    .input(listPayoutHistoryInputSchema.omit({ actorHumanId: true }))
    .output(listPayoutHistoryOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listPayoutHistory(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHEN THE REST GOES OUT. Per (payee, currency, maturity date), the
   * SETTLEMENT_CREDIT cents that are not payable yet — the forward sibling of
   * `listPayablePositions`, over exactly the credit rows that read excludes
   * on maturity. `creditCents` is a GROSS CREDIT FEED, NOT A BALANCE: no
   * debits, no payouts, no holds — all of those are already effective in
   * today's payable. The use case nets ONE thing against it: carried-forward
   * DEBT (a negative payable today, including the debt a hold on an open
   * dispute creates), consumed soonest-tranche-first, giving `expectedCents`.
   * `heldCents` is an annotation of what is under dispute, never subtracted.
   * If the payable read fails, `debtResolved` is false and every
   * debt-dependent figure is NULL — unknown is never rendered as a number.
   * It forecasts MATURITY, not PAYMENT. Powers the "Upcoming payouts" section
   * of /platform/settlements. The use case enforces ADMIN|SUPPORT itself
   * (STAFF_ONLY).
   */
  listUpcomingPayouts: authedProcedure
    // `.optional()`, because the omit leaves an EMPTY object and a required
    // empty object 400s the no-argument call every client actually makes
    // (`useQuery()` sends `undefined`). Strictness survives: a caller that
    // DOES pass an object still has its unknown keys refused.
    .input(listUpcomingPayoutsInputSchema.omit({ actorHumanId: true }).optional())
    .output(listUpcomingPayoutsOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listUpcomingPayouts(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHAT THE PLATFORM CHARGED AND KEPT, per currency — volume, the platform
   * fee recorded at checkout (split by fee mode), tax held for remittance,
   * the recovered Connect account fee, two measured cost lines (platform fee
   * returned on refunds, processor cost) and `netKeptCents`. All three
   * measured lines ride with `{ measured, total }` coverage and carry a
   * reason below full coverage: `unread` (a real population, none of it
   * measured) is `null` cents; `partial_coverage` is a real but incomplete
   * figure; `nothing_to_report` (`total === 0`) is a CONFIDENT 0 — the sum
   * of an empty set — and must not be rendered as unknown.
   *
   * THE NET IS COVERAGE-GATED AND OVER A SUBSET: eight eligibility
   * conditions. Three exclude most REFUNDED orders (an ABSORB refund returns
   * the processor fee to the platform, a refund recovers a spent credit, and
   * a partial refund under the basis cap cannot be pro-rated in integers
   * without overstating) and one excludes RESALE orders, which record
   * `feesPlatformCents: 0` and would otherwise render a confident $0.00.
   * It is SIGNED — a capped give-back and platform-funded credit can exceed
   * the fee. Never render it without `netKeptCoverage`, and never as
   * all-time platform profit. There is no payload-wide `netKeptUnavailable`
   * flag: the state is per currency.
   *
   * The basis expression is not in question
   * (docs/decisions/absorb-refund-returns-platform-fee.md), and on a
   * pass-through sale the platform receives the fee twice — the net counts
   * both units because both were received, and takes no position on whether
   * it should have been; that record parks it. See the use case's header for
   * every term. The use case enforces ADMIN|SUPPORT itself (STAFF_ONLY).
   */
  getPlatformRevenue: authedProcedure
    // `.optional()` for the same no-argument-call reason as the reads above.
    .input(getPlatformRevenueInputSchema.omit({ actorHumanId: true }).optional())
    .output(getPlatformRevenueOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await getPlatformRevenue(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Payees whose ledger payable is NEGATIVE (a lost dispute or post-payout
   * refund clawed back more than their matured credits cover) — who owes
   * what, since when, and whether they have upcoming sales to recover from.
   * Powers the "Payees in debt" section of /platform/settlements. The use
   * case enforces ADMIN|SUPPORT itself (STAFF_ONLY); cursor-paged, so it is
   * fetched with `utils.fetch`, never `useInfiniteQuery` (strict input).
   */
  listPayeeDebtPositions: authedProcedure
    .input(listPayeeDebtPositionsInputSchema.omit({ actorHumanId: true }))
    .output(listPayeeDebtPositionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listPayeeDebtPositions(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * UNPAID CASH BALANCES (door-sales spec 2026-10-07, FR-013): payees whose
   * door cash-sale debt (platform fee + tax kept in cash) has gone
   * unrecovered by later payouts for more than 30 days, largest first, with
   * the oldest unrecovered date and whether a Stripe account exists to
   * recover it from. Staff collect it by hand. Read-only. The use case
   * enforces ADMIN|SUPPORT itself (STAFF_ONLY); cursor-paged, fetch with
   * `utils.fetch` (strict input). `.optional()` so a no-argument call is
   * not a 400; a caller that passes an object still has unknown keys refused.
   */
  listUnrecoveredCashDebts: authedProcedure
    .input(
      listUnrecoveredCashDebtsInputSchema
        .omit({ actorHumanId: true })
        .optional(),
    )
    .output(listUnrecoveredCashDebtsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listUnrecoveredCashDebts(
          { repos: ctx.repos, authz: ctx.authz, clock: ctx.clock },
          { ...(input ?? {}), actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHAT MEMBERSHIPS ARE WORTH — active/trialing counts and normalised
   * monthly value per currency. Memberships carry a 0% platform fee, so this
   * is money flowing TO OWNERS and none of it is platform income; the output
   * field is named `ownerRevenueByCurrency` for that reason. Powers the
   * "Recurring revenue" section of /platform/memberships. The use case
   * enforces ADMIN|SUPPORT itself (STAFF_ONLY).
   */
  summariseRecurringRevenue: authedProcedure
    // `.optional()`, because the omit leaves an EMPTY object and a required
    // empty object 400s the no-argument call every client makes
    // (`useQuery()` sends `undefined`). Strictness survives: a caller that
    // DOES pass an object still has its unknown keys refused.
    .input(
      summariseRecurringRevenueInputSchema
        .omit({ actorHumanId: true })
        .optional(),
    )
    .output(summariseRecurringRevenueOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await summariseRecurringRevenue(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * WHICH MEMBERSHIPS ARE BROKEN — `past_due` / `unpaid` / stuck `incomplete`
   * (bucket "attention"), or scheduled to end inside the window (bucket
   * "leaving"). Powers the "Needs attention" and "Leaving" sections of
   * /platform/memberships. The use case enforces ADMIN|SUPPORT itself
   * (STAFF_ONLY); cursor-paged, so it is fetched with `utils.fetch`, never
   * `useInfiniteQuery` (strict input).
   */
  listMembershipPositions: authedProcedure
    .input(listMembershipPositionsInputSchema.omit({ actorHumanId: true }))
    .output(listMembershipPositionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await listMembershipPositions(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** ADMIN-only: suspend or un-suspend an owner's memberships (new signups). */
  suspendMembershipStanding: authedProcedure
    .input(suspendMembershipStandingInputSchema.omit({ actorHumanId: true }))
    .output(suspendMembershipStandingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await suspendMembershipStanding(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** ADMIN-only: set/clear the rolling reserve on an owner's membership payouts. */
  overrideMembershipStanding: authedProcedure
    .input(overrideMembershipStandingInputSchema.omit({ actorHumanId: true }))
    .output(overrideMembershipStandingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireStaffActor(ctx);
      try {
        return await overrideMembershipStanding(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Webhook DLQ ──────────────────────────────────────────────────────

  listWebhookDlq: authedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .output(
      z.object({
        items: z.array(
          z.object({
            stripeEventId: z.string(),
            eventType: z.string(),
            payload: z.string(),
            error: z.string(),
            receivedAt: z.string(),
          }),
        ),
        count: z.number().int(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) throw new TRPCError({ code: "FORBIDDEN" });
      if (!ctx.webhookDlq) return { items: [], count: 0 };

      const [items, count] = await Promise.all([
        ctx.webhookDlq.list(input.limit),
        ctx.webhookDlq.count(),
      ]);
      return { items, count };
    }),

  removeWebhookDlqItem: authedProcedure
    .input(z.object({ stripeEventId: z.string() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) throw new TRPCError({ code: "FORBIDDEN" });
      if (!ctx.webhookDlq)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook DLQ not configured",
        });

      await ctx.webhookDlq.remove(input.stripeEventId);
      return { ok: true as const };
    }),

  /**
   * Re-drive a DLQ'd Stripe event through the real webhook dispatch.
   *
   * Before this existed the DLQ was a graveyard: operators could look at a
   * failed event and delete it, but the only way to actually apply it was to
   * re-send from the Stripe dashboard (impossible for events Stripe has since
   * aged out). On success the item is removed from the DLQ; on failure it stays
   * put with the new error so a retry loop is still visible.
   *
   * Replay is safe for money — every handler is guarded by an order-status
   * precondition, a unique ledger key, or the `stripe_evt:` idempotency cache —
   * but notification emails are only deduped for 120s, so a replay can re-send
   * a receipt. The UI warns about that.
   */
  replayWebhookDlqItem: authedProcedure
    .input(z.object({ stripeEventId: z.string() }))
    .output(
      z.object({
        ok: z.boolean(),
        error: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) throw new TRPCError({ code: "FORBIDDEN" });
      if (!ctx.webhookDlq)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook DLQ not configured",
        });
      if (!ctx.replayStripeEvent)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook replay is not available in this environment",
        });

      const item = await ctx.webhookDlq.get(input.stripeEventId);
      if (!item)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No DLQ item for that event id",
        });

      const result = await ctx.replayStripeEvent(item.payload);
      // Only clear it once it actually applied. A failed replay must stay
      // visible — silently dropping it would be the same class of bug as the
      // swallowed webhook this DLQ exists to catch.
      if (result.ok) {
        // The event APPLIED. If clearing the row fails, do not turn that into a
        // 500: the admin would read it as "replay failed" and replay again
        // (re-sending a receipt email). Report and say what happened instead.
        try {
          await ctx.webhookDlq.remove(input.stripeEventId);
        } catch (err) {
          try {
            ctx.reportError?.(err, {
              tags: { area: "webhook_dlq", step: "replay_remove" },
              extra: { stripeEventId: input.stripeEventId },
            });
          } catch {
            // A throwing reporter never changes behaviour.
          }
          return { ok: true, error: "applied; DLQ row not cleared" };
        }
      }
      return { ok: result.ok, error: result.error ?? null };
    }),
};

export type PlatformRouter = typeof platformRouter;
