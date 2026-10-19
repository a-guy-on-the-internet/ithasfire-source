import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  archiveRoleTemplate,
  archiveRoleTemplateInputSchema,
  upsertRoleTemplateShifts,
  upsertRoleTemplateShiftsInputSchema,
  getRoleTemplateWithShifts,
  getRoleTemplateWithShiftsInputSchema,
  forkPlatformRoleTemplate,
  forkPlatformRoleTemplateInputSchema,
  checkInVolunteer,
  checkInVolunteerInputSchema,
  createEventVolunteerRole,
  createEventVolunteerRoleInputSchema,
  createFromTemplates,
  createFromTemplatesInputSchema,
  createRoleTemplate,
  createRoleTemplateInputSchema,
  createVolunteerShift,
  createVolunteerShiftBatch,
  createVolunteerShiftBatchInputSchemaBase,
  createVolunteerShiftInputSchemaBase,
  deleteEventVolunteerRole,
  deleteEventVolunteerRoleInputSchema,
  deleteVolunteerShift,
  deleteVolunteerShiftInputSchema,
  getPublicVolunteerWaiver,
  getPublicVolunteerWaiverInputSchema,
  getVolunteerContextForTicketScan,
  getVolunteerContextForTicketScanInputSchema,
  listEventVolunteerRoles,
  listEventVolunteerRolesInputSchema,
  listMyVolunteerCommitments,
  listMyVolunteerCommitmentsInputSchema,
  listMyVolunteerSignups,
  listMyVolunteerSignupsInputSchema,
  listPublicEventVolunteerRoles,
  listPublicEventVolunteerRolesInputSchema,
  listRoleTemplates,
  listRoleTemplatesInputSchema,
  listVolunteerShifts,
  listVolunteerShiftsInputSchema,
  listVolunteerSignups,
  listVolunteerSignupsInputSchema,
  mintVolunteerScanToken,
  mintVolunteerScanTokenInputSchema,
  resolveVolunteerSignupByToken,
  resolveVolunteerSignupByTokenInputSchema,
  reviewVolunteerSignup,
  reviewVolunteerSignupInputSchema,
  reviewVolunteerSignupsBatch,
  reviewVolunteerSignupsBatchInputSchema,
  searchVolunteerSignupsForCheckIn,
  searchVolunteerSignupsForCheckInInputSchema,
  submitVolunteerSignup,
  submitVolunteerSignupInputSchema,
  updateEventVolunteerRole,
  updateEventVolunteerRoleInputSchema,
  updateRoleTemplate,
  updateRoleTemplateInputSchema,
  updateVolunteerShift,
  updateVolunteerShiftInputSchemaBase,
  withdrawVolunteerSignup,
  withdrawVolunteerSignupInputSchema,
  updateVolunteerContactPrefs,
  updateVolunteerContactPrefsInputSchema,
  updateVolunteerHours,
  updateVolunteerHoursInputSchema,
  exportEventVolunteerHours,
  exportEventVolunteerHoursInputSchema,
  getOrgVolunteerHoursSummary,
  getOrgVolunteerHoursSummaryInputSchema,
  // ── Generic volunteer asks (generic-volunteering-asks spec) ──
  createVolunteerAsk,
  createVolunteerAskInputSchemaBase,
  updateVolunteerAsk,
  updateVolunteerAskInputSchema,
  addVolunteerAskRole,
  addVolunteerAskRoleInputSchema,
  updateVolunteerAskRole,
  updateVolunteerAskRoleInputSchema,
  createVolunteerGroup,
  createVolunteerGroupInputSchema,
  assignGroupCoordinator,
  assignGroupCoordinatorInputSchemaBase,
  assignSignupToGroup,
  assignSignupToGroupInputSchema,
  listAskRoster,
  listAskRosterInputSchema,
  listAskSignups,
  listAskSignupsInputSchema,
  listCoordinatorRoster,
  listCoordinatorRosterInputSchema,
  broadcastToRoster,
  broadcastToRosterInputSchema,
  listAskBroadcasts,
  listAskBroadcastsInputSchema,
  exportSignupIcs,
  exportSignupIcsInputSchema,
  getMyVolunteerIcsFeedToken,
  rotateMyVolunteerIcsFeedToken,
  getPublicVolunteerAsk,
  getPublicVolunteerAskInputSchema,
  assignWaiverToAsk,
  assignWaiverToAskInputBaseSchema,
  getPublicAskWaiver,
  getPublicAskWaiverInputSchema,
  resolveAskOwnership,
  volunteerSubjectTypeSchema,
  volunteerAskStatusSchema,
  // ── Shift occurrences + claims (generic-volunteer-shifts-occurrences A) ──
  createShiftOccurrence,
  createShiftOccurrenceInputSchemaBase,
  updateShiftOccurrence,
  updateShiftOccurrenceInputSchema,
  cancelShiftOccurrence,
  cancelShiftOccurrenceInputSchema,
  listAskOccurrences,
  listAskOccurrencesInputSchema,
  claimOccurrence,
  claimOccurrenceInputSchema,
  withdrawOccurrenceClaim,
  withdrawOccurrenceClaimInputSchema,
  assignOccurrenceClaim,
  assignOccurrenceClaimInputSchema,
  checkInOccurrenceClaim,
  checkInOccurrenceClaimInputSchema,
  listOccurrenceRoster,
  listOccurrenceRosterInputSchema,
  getPublicAskSchedule,
  getPublicAskScheduleInputSchema,
  // ── Comp-ticket rewards (volunteer-comp-tickets spec) ──
  setVolunteerReward,
  setVolunteerRewardInputSchema,
  listAskRewardLedger,
  listAskRewardLedgerInputSchema,
  listAskRewards,
  listAskRewardsInputSchema,
  grantVolunteerReward,
  revokeVolunteerReward,
  revokeVolunteerRewardInputSchema,
  type VolunteerRewardHooks,
} from "@th/core/use-cases/volunteering";
import { listMyEvents } from "@th/core/use-cases/events";
import type { MailerPort } from "@th/ports/comms/mailer";

import type { Ctx } from "../context";
import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  rateLimit,
  router,
} from "../init";
import { toTrpcError } from "../utils";

// ── Error mapping (R8) ──────────────────────────────────────────────────────
//
// Use cases throw `{ code, message }` objects. Map them to TRPCError via the
// shared `toTrpcError` helper which already handles the standard codes:
//   invalid_input → BAD_REQUEST
//   forbidden     → FORBIDDEN
//   not_found     → NOT_FOUND
//   conflict      → CONFLICT   (covers volunteering_disabled, already_signed_up,
//                               signup_not_reviewable, signup_not_withdrawable,
//                               signup_not_approved, template_name_taken,
//                               shift_full, role_full, etc.)
//
// Unknown codes surface as INTERNAL_SERVER_ERROR.

type UseCaseCall<T> = () => Promise<T>;

async function call<T>(fn: UseCaseCall<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

// ── Comp-reward trigger hooks ───────────────────────────────────────────────
//
// The signup use cases (review / check-in / withdraw) only fire a comp-reward
// grant/revoke when a `rewards` dep is supplied — WITHOUT wiring it here, the
// triggers are dead in production. `makeRewardHooks` builds that dep from the
// request context: thin wrappers that construct the money-path use-case deps
// and delegate to grant/revoke, which already own idempotency, the budget cap,
// and post-commit + error-swallowed delivery.

/**
 * No-op mailer used only when `ctx.mailer` is absent. `grantVolunteerReward`
 * hard-requires a MailerPort, but the comp ticket MINT (the durable money
 * outcome) must not depend on email being configured — the send is post-commit
 * and already error-swallowed inside the grant. This fallback lets the grant
 * proceed and records the missed email instead of failing.
 */
function noopMailer(logger: Ctx["logger"]): MailerPort {
  return {
    async send() {
      logger?.warn("volunteer.reward.mailer_absent", {
        detail: "comp ticket minted without email — mailer not configured",
      });
      return {
        result: {
          success: false,
          errorCode: "dependency_failed",
          errorMessage: "mailer_not_configured",
        },
      };
    },
    async sendBatch() {
      return { results: [], okCount: 0, errorCount: 0 };
    },
    async health() {
      return { ok: false, message: "mailer_not_configured" };
    },
  };
}

function makeRewardHooks(ctx: Ctx): VolunteerRewardHooks {
  const publicAppUrl = ctx.publicAppUrl ?? "";
  // SUPPORT_URL isn't on the tRPC ctx; derive the support hub from the public
  // origin, mirroring the Stripe webhook's `env.SUPPORT_URL ?? ${url}/support`.
  const supportUrl = publicAppUrl ? `${publicAppUrl}/support` : "/support";
  const mailer = ctx.mailer ?? noopMailer(ctx.logger);

  return {
    grant: (input) =>
      grantVolunteerReward(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          mailer,
          publicAppUrl,
          supportUrl,
          // Venue-map parity with purchased-ticket emails; undefined when the
          // tileserver isn't configured, in which case the email omits the map.
          tileServerUrl: ctx.tileServerUrl ?? undefined,
          // The grant swallows a `duplicate_grant` race and a failed comp
          // email and still reports success; without this those money-path
          // degradations never reach Sentry (CLAUDE.md error-reporting
          // convention). Wired to `Sentry.captureException` in dep.ts.
          reportError: ctx.reportError ?? undefined,
          logger: ctx.logger,
        },
        input,
      ),
    // System-fired revoke (no actor) — the withdraw that fired it already
    // authorized the volunteer's own action.
    revoke: (input) =>
      revokeVolunteerReward(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
          reportError: ctx.reportError ?? undefined,
        },
        input,
      ),
  };
}

/**
 * Deps for `withdrawVolunteerSignup`, used by the `withdraw` procedure below
 * AND exported for `eventHumans.leave`: a person leaving a lineup through
 * a VOLUNTEER row with a signup is withdrawn through this same flow (its
 * reward revoke and spot-opened notices included), never a copy of it.
 */
export function volunteerWithdrawDeps(ctx: Ctx) {
  return {
    repos: ctx.repos,
    authz: ctx.authz,
    clock: ctx.clock,
    logger: ctx.logger,
    notify: ctx.notify,
    appBaseUrl: ctx.publicAppUrl ?? "",
    // WITHDRAWN revokes any un-redeemed grant (post-commit, idempotent).
    rewards: makeRewardHooks(ctx),
    // Sentry for the swallowed spot-opened notify failure.
    reportError: ctx.reportError ?? undefined,
  } satisfies Parameters<typeof withdrawVolunteerSignup>[0];
}

/**
 * Placeholder volunteer-scan-token port for procedures that don't actually
 * touch tokens (search / getContext) but whose `Deps` type requires the
 * field. If invoked, throws — guards against accidental regressions where
 * a token-using procedure is wired without a configured port.
 */
const unconfiguredScanTokenPort = {
  async sign(): Promise<never> {
    throw {
      code: "not_configured",
      message: "volunteer_scan_token_not_configured",
    } as const;
  },
  async verify(): Promise<never> {
    throw {
      code: "not_configured",
      message: "volunteer_scan_token_not_configured",
    } as const;
  },
} as const;

// ── Input schemas (strip actorHumanId — injected from ctx) ──────────────────

const createRoleTemplateInput = createRoleTemplateInputSchema.omit({
  actorHumanId: true,
});
const updateRoleTemplateInput = updateRoleTemplateInputSchema.omit({
  actorHumanId: true,
});
const archiveRoleTemplateInput = archiveRoleTemplateInputSchema.omit({
  actorHumanId: true,
});
const listRoleTemplatesInput = listRoleTemplatesInputSchema.omit({
  actorHumanId: true,
});
const upsertRoleTemplateShiftsInput = upsertRoleTemplateShiftsInputSchema.omit({
  actorHumanId: true,
});
const getRoleTemplateWithShiftsInput =
  getRoleTemplateWithShiftsInputSchema.omit({
    actorHumanId: true,
  });
const forkPlatformRoleTemplateInput = forkPlatformRoleTemplateInputSchema.omit({
  actorHumanId: true,
});

const createEventRoleInput = createEventVolunteerRoleInputSchema.omit({
  actorHumanId: true,
});
const createFromTemplatesInput = createFromTemplatesInputSchema.omit({
  actorHumanId: true,
});
const updateEventRoleInput = updateEventVolunteerRoleInputSchema.omit({
  actorHumanId: true,
});
const deleteEventRoleInput = deleteEventVolunteerRoleInputSchema.omit({
  actorHumanId: true,
});
const listEventRolesInput = listEventVolunteerRolesInputSchema.omit({
  actorHumanId: true,
});

const createShiftInput = createVolunteerShiftInputSchemaBase.omit({
  actorHumanId: true,
});
const createShiftBatchInput = createVolunteerShiftBatchInputSchemaBase.omit({
  actorHumanId: true,
});
const updateShiftInput = updateVolunteerShiftInputSchemaBase.omit({
  actorHumanId: true,
});
const deleteShiftInput = deleteVolunteerShiftInputSchema.omit({
  actorHumanId: true,
});
const listShiftsInput = listVolunteerShiftsInputSchema.omit({
  actorHumanId: true,
});

// submit is public (optional auth). actorHumanId is nullish on the input schema;
// we overwrite it from ctx so clients cannot impersonate another human.
// ipAddress/userAgent are likewise stripped from the client-facing input and
// injected from the request context (waiver-acceptance legal record) — a
// client must never be able to forge them.
const submitSignupInput = submitVolunteerSignupInputSchema.omit({
  actorHumanId: true,
  ipAddress: true,
  userAgent: true,
});
const reviewSignupInput = reviewVolunteerSignupInputSchema.omit({
  actorHumanId: true,
});
const reviewSignupsBatchInput = reviewVolunteerSignupsBatchInputSchema.omit({
  actorHumanId: true,
});
const checkInSignupInput = checkInVolunteerInputSchema.omit({
  actorHumanId: true,
});
const withdrawSignupInput = withdrawVolunteerSignupInputSchema.omit({
  actorHumanId: true,
});
const updateContactPrefsInput = updateVolunteerContactPrefsInputSchema.omit({
  actorHumanId: true,
});
const updateHoursInput = updateVolunteerHoursInputSchema.omit({
  actorHumanId: true,
});
const exportHoursInput = exportEventVolunteerHoursInputSchema.omit({
  actorHumanId: true,
});
const orgHoursSummaryInput = getOrgVolunteerHoursSummaryInputSchema.omit({
  actorHumanId: true,
});
const listSignupsInput = listVolunteerSignupsInputSchema.omit({
  actorHumanId: true,
});

const mintScanTokenInput = mintVolunteerScanTokenInputSchema.omit({
  actorHumanId: true,
});
const resolveByTokenInput = resolveVolunteerSignupByTokenInputSchema.omit({
  actorHumanId: true,
});
const searchForCheckInInput = searchVolunteerSignupsForCheckInInputSchema.omit({
  actorHumanId: true,
});
const getContextForTicketScanInput =
  getVolunteerContextForTicketScanInputSchema.omit({
    actorHumanId: true,
  });

const publicRolesListInput = listPublicEventVolunteerRolesInputSchema;
const publicWaiverInput = getPublicVolunteerWaiverInputSchema.omit({
  actorHumanId: true,
});
// Ask-level waiver (ask-level-volunteer-waivers spec). actorHumanId is
// stripped and re-injected from ctx on both — a client can neither
// impersonate the assigning editor nor forge the viewer whose
// `alreadyOnFile` state is computed.
const assignAskWaiverInput = assignWaiverToAskInputBaseSchema.omit({
  actorHumanId: true,
});
const publicAskWaiverInput = getPublicAskWaiverInputSchema.omit({
  actorHumanId: true,
});
const signupCountsInput = z.object({ eventId: z.string().uuid() });

// ── Generic volunteer asks (generic-volunteering-asks spec) ──
// The refined schemas (`createVolunteerAskInputSchema`,
// `assignGroupCoordinatorInputSchema`) can't be `.omit()`-ed, so the
// transport parses the Base object schemas — the use cases re-parse the
// full refined schema, exactly like the shift create/update procedures.
const createAskInput = createVolunteerAskInputSchemaBase.omit({
  actorHumanId: true,
});
const updateAskInput = updateVolunteerAskInputSchema.omit({
  actorHumanId: true,
});
const listAsksBySubjectInput = z.object({
  subjectType: volunteerSubjectTypeSchema,
  subjectId: z.string().uuid(),
});
const listAsksByOrgInput = z.object({
  orgId: z.string().uuid(),
  status: volunteerAskStatusSchema.optional(),
});
const addAskRoleInput = addVolunteerAskRoleInputSchema.omit({
  actorHumanId: true,
});
const updateAskRoleInput = updateVolunteerAskRoleInputSchema.omit({
  actorHumanId: true,
});
const createGroupInput = createVolunteerGroupInputSchema.omit({
  actorHumanId: true,
});
const assignCoordinatorInput = assignGroupCoordinatorInputSchemaBase.omit({
  actorHumanId: true,
});
const assignSignupToGroupInput = assignSignupToGroupInputSchema.omit({
  actorHumanId: true,
});
// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" |
// "backward") on every request. Allow it on the two cursor-paginated roster
// procedures and STRIP it in the handler before calling the use case (which
// has no `direction` field) — same precedent as eventSaves.listMine
// (event-saves.ts). Without this the infinite roster lists would break the
// moment these schemas ever turn `.strict()`.
const infiniteDirection = z.enum(["forward", "backward"]).optional();
const askRosterInput = listAskRosterInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: infiniteDirection });
const listAskSignupsInput = listAskSignupsInputSchema.omit({
  actorHumanId: true,
});
const coordinatorRosterInput = listCoordinatorRosterInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: infiniteDirection });
const broadcastSendInput = broadcastToRosterInputSchema.omit({
  actorHumanId: true,
});
const broadcastListInput = listAskBroadcastsInputSchema.omit({
  actorHumanId: true,
});
const signupIcsInput = exportSignupIcsInputSchema.omit({ actorHumanId: true });

// ── Shift occurrences + claims (generic-volunteer-shifts-occurrences A) ──
// `createShiftOccurrenceInputSchema` is refined (endsAt > startsAt) and
// can't be `.omit()`-ed, so the transport parses the Base object schema —
// the use case re-parses the full refined schema (same pattern as the
// shift create procedures).
const createOccurrenceInput = createShiftOccurrenceInputSchemaBase.omit({
  actorHumanId: true,
});
const updateOccurrenceInput = updateShiftOccurrenceInputSchema.omit({
  actorHumanId: true,
});
const cancelOccurrenceInput = cancelShiftOccurrenceInputSchema.omit({
  actorHumanId: true,
});
const listOccurrencesInput = listAskOccurrencesInputSchema.omit({
  actorHumanId: true,
});
const claimOccurrenceInput = claimOccurrenceInputSchema.omit({
  actorHumanId: true,
});
const withdrawClaimInput = withdrawOccurrenceClaimInputSchema.omit({
  actorHumanId: true,
});
const assignClaimInput = assignOccurrenceClaimInputSchema.omit({
  actorHumanId: true,
});
const checkInClaimInput = checkInOccurrenceClaimInputSchema.omit({
  actorHumanId: true,
});
const occurrenceRosterInput = listOccurrenceRosterInputSchema.omit({
  actorHumanId: true,
});

// ── Comp-ticket rewards (volunteer-comp-tickets spec) ──
const setRewardInput = setVolunteerRewardInputSchema.omit({
  actorHumanId: true,
});
const rewardLedgerInput = listAskRewardLedgerInputSchema.omit({
  actorHumanId: true,
});
const rewardListInput = listAskRewardsInputSchema.omit({ actorHumanId: true });
// Manual revoke strips actorHumanId — injected from ctx so the finance gate in
// the use case runs against the authenticated actor, never a client-supplied id.
const revokeRewardInput = revokeVolunteerRewardInputSchema.omit({
  actorHumanId: true,
});

// ── Sub-routers ─────────────────────────────────────────────────────────────

const templatesRouter = router({
  create: authedProcedure
    .input(createRoleTemplateInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createRoleTemplate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  update: authedProcedure
    .input(updateRoleTemplateInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateRoleTemplate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  archive: authedProcedure
    .input(archiveRoleTemplateInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        archiveRoleTemplate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  list: authedProcedure
    .input(listRoleTemplatesInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listRoleTemplates(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  getWithShifts: authedProcedure
    .input(getRoleTemplateWithShiftsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getRoleTemplateWithShifts(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  upsertShifts: authedProcedure
    .input(upsertRoleTemplateShiftsInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        upsertRoleTemplateShifts(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * "Customise" — fork a LIVE catalogue role into an org-owned copy
   * (FR-011). No idempotency key on the wire: it is derived server-side from
   * (orgId, templateId) so two clicks of the same button cannot key
   * differently. See the use case.
   */
  fork: authedProcedure
    .input(forkPlatformRoleTemplateInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        forkPlatformRoleTemplate(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            idempotency: ctx.idempotency,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
});

const rolesRouter = router({
  create: authedProcedure
    .input(createEventRoleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createEventVolunteerRole(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  createFromTemplates: authedProcedure
    .input(createFromTemplatesInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createFromTemplates(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  update: authedProcedure
    .input(updateEventRoleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateEventVolunteerRole(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  delete: authedProcedure
    .input(deleteEventRoleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        deleteEventVolunteerRole(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  list: authedProcedure
    .input(listEventRolesInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listEventVolunteerRoles(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
});

const shiftsRouter = router({
  create: authedProcedure
    .input(createShiftInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createVolunteerShift(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  createBatch: authedProcedure
    .input(createShiftBatchInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createVolunteerShiftBatch(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  update: authedProcedure
    .input(updateShiftInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateVolunteerShift(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  delete: authedProcedure
    .input(deleteShiftInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        deleteVolunteerShift(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  list: authedProcedure.input(listShiftsInput).query(async ({ ctx, input }) => {
    const actorHumanId = requireActor(ctx);
    return call(() =>
      listVolunteerShifts(
        { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
        { ...input, actorHumanId },
      ),
    );
  }),
});

const signupsRouter = router({
  /** Submit a volunteer signup. Publicly callable; auth is optional. */
  submit: optionalProcedure
    .input(submitSignupInput)
    // Public + anonymous, and it can make us email the typed address: cap
    // it per IP on top of the global floor (the direct mail also has a
    // per-recipient daily cap in the use case).
    .use(
      rateLimit({
        key: (ctx) => `volunteer:signups:submit:ip:${ctx.clientIp ?? "no-ip"}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "volunteer signups",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return call(() =>
        submitVolunteerSignup(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
            // Swallowed post-commit notify failures surface to Sentry.
            reportError: ctx.reportError ?? undefined,
            // Contact-only signups: fixed-copy direct confirmation, capped
            // per recipient (fails closed without these).
            mailer: ctx.mailer ?? null,
            rateLimit: ctx.rateLimit,
          },
          {
            ...input,
            actorHumanId: ctx.actorHumanId ?? null,
            // Server-injected for the volunteer waiver acceptance record —
            // same ctx extraction as the checkout/attestation procedures.
            ipAddress: ctx.clientIp ?? null,
            userAgent: ctx.userAgent ?? null,
          },
        ),
      );
    }),
  review: authedProcedure
    .input(reviewSignupInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        reviewVolunteerSignup(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
            // A notify failure is swallowed (review stays persisted) — report
            // it to Sentry per the CLAUDE.md error-reporting convention.
            reportError: ctx.reportError ?? undefined,
            // ON_APPROVAL comp-reward trigger (post-commit, idempotent).
            rewards: makeRewardHooks(ctx),
            // Contact-only signups get their decision by direct mail.
            mailer: ctx.mailer ?? null,
            rateLimit: ctx.rateLimit,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Bulk approve/reject. Per-id failures (shift_full, signup_not_reviewable,
   * …) are NOT tRPC errors — the mutation resolves with mixed
   * `{ id, ok, code? }` results. Only input validation / unexpected
   * failures throw.
   */
  reviewBatch: authedProcedure
    .input(reviewSignupsBatchInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        reviewVolunteerSignupsBatch(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
            // Swallowed per-item notify failures surface to Sentry.
            reportError: ctx.reportError ?? undefined,
            // Batch delegates each id to reviewVolunteerSignup with these same
            // deps, so ON_APPROVAL grants fire per-item.
            rewards: makeRewardHooks(ctx),
            mailer: ctx.mailer ?? null,
            rateLimit: ctx.rateLimit,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  checkIn: authedProcedure
    .input(checkInSignupInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        checkInVolunteer(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
            // ON_CHECK_IN comp-reward trigger (post-commit, idempotent).
            rewards: makeRewardHooks(ctx),
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Mint a signed volunteer scan token for an APPROVED signup.
   *
   * - The signup's owner can mint a `short` or `print` token for THEIR OWN
   *   signup. A self-minted `print` token is a printable QR ("scan me in"),
   *   not a badge — badge stock stays organizer/venue-issued. It gets a
   *   tighter TTL ceiling than an organizer's.
   * - Org-edit-role admins can mint either kind for any approved signup.
   *
   * The transport does NOT gate on `kind`, `actorHumanId`, or ownership —
   * every one of those lives in `mintVolunteerScanToken`, which authorizes
   * before it inspects state so a probe can't classify signup ids. Keep it
   * that way: `actorHumanId` is omitted from the client-facing input and
   * injected from ctx, so a client cannot mint as someone else.
   *
   * Returns `{ token, expiresAt }`. The token is human+event scoped so a
   * single token covers all of a volunteer's eligible signups for the event.
   */
  mintScanToken: authedProcedure
    .input(mintScanTokenInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      if (!ctx.volunteerScanToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "volunteer_scan_token_not_configured",
        });
      }
      const tokenPort = ctx.volunteerScanToken;
      return call(() =>
        mintVolunteerScanToken(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            volunteerScanToken: tokenPort,
            shortTokenTtlHours:
              ctx.volunteerScanTokenShortTtlHours ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Verify a volunteer scan token and return all eligible signups for the
   * token's human on the given event. Used by the scanner app's volunteer
   * mode (FR-002 / FR-006).
   */
  resolveByToken: authedProcedure
    .input(resolveByTokenInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      if (!ctx.volunteerScanToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "volunteer_scan_token_not_configured",
        });
      }
      const tokenPort = ctx.volunteerScanToken;
      return call(() =>
        resolveVolunteerSignupByToken(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            volunteerScanToken: tokenPort,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Search eligible volunteer signups for an event by name or email.
   * Drives the manual fallback flow (FR-004). Org-edit-role required.
   */
  searchForCheckIn: authedProcedure
    .input(searchForCheckInInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        searchVolunteerSignupsForCheckIn(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            // Token port is unused by this flow but the deps type requires it.
            volunteerScanToken:
              ctx.volunteerScanToken ?? unconfiguredScanTokenPort,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Given a ticket-scan result (humanId + eventId), return any eligible
   * volunteer signups for the same event. Powers FR-009a enrichment.
   */
  getContextForTicketScan: authedProcedure
    .input(getContextForTicketScanInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getVolunteerContextForTicketScan(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            volunteerScanToken:
              ctx.volunteerScanToken ?? unconfiguredScanTokenPort,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Move a signup into / between / out of (null = general pool) a group
   * (FR-005). Owner: any move; coordinator: pool ↔ own group only —
   * both enforced in the use case.
   */
  assignToGroup: authedProcedure
    .input(assignSignupToGroupInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        assignSignupToGroup(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  withdraw: authedProcedure
    .input(withdrawSignupInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        // Shared with `eventHumans.leave` so the two can never drift.
        withdrawVolunteerSignup(volunteerWithdrawDeps(ctx), {
          ...input,
          actorHumanId,
        }),
      );
    }),
  /**
   * Volunteer toggles SMS reminders on their OWN signup (Gap 6).
   * Ownership + the phone-required-to-enable rule live in the use case;
   * enabling without a contactPhone on file → CONFLICT
   * (phone_required_for_sms). Disabling always succeeds.
   */
  updateContactPrefs: authedProcedure
    .input(updateContactPrefsInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateVolunteerContactPrefs(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  list: authedProcedure
    .input(listSignupsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listVolunteerSignups(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Ask-scoped signup listing (FR-005 / FR-007) — the flat query behind
   * the owner's PENDING review queue, per-group member lists, and the
   * coordinator console's pool panel. Owner: any scope; coordinator:
   * own GROUP or POOL only — enforced in the use case (uniform
   * `forbidden` on anything else).
   */
  listByAsk: authedProcedure
    .input(listAskSignupsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listAskSignups(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Admin override for hours-worked on a signup. `null` clears the
   * override and reverts to scheduled hours. Mirrors the per-row
   * inline edit in the admin Signups tab.
   */
  updateHours: authedProcedure
    .input(updateHoursInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateVolunteerHours(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Per-event hours report (one row per signup, ready for CSV). The
   * web client serialises rows to CSV client-side; doing that here
   * would force a streamed transport not currently wired in tRPC.
   */
  exportHours: authedProcedure
    .input(exportHoursInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        exportEventVolunteerHours(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  listMine: authedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listMyVolunteerSignups(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { actorHumanId } satisfies z.infer<
            typeof listMyVolunteerSignupsInputSchema
          >,
        ),
      );
    }),
  /**
   * Read behind the attendee-facing `/my-volunteering` page: every
   * commitment the signed-in human holds, past and future, in every
   * status, with the display join (event/ask title, role, shift window,
   * venue) that `listMine` deliberately lacks. Self-read — the actor
   * comes from the session, never from input, so there is nothing to
   * point at another human.
   *
   * Dates ride the router's superjson transformer as real `Date`s, same
   * as every other procedure here.
   */
  listMyCommitments: authedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listMyVolunteerCommitments(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { actorHumanId } satisfies z.infer<
            typeof listMyVolunteerCommitmentsInputSchema
          >,
        ),
      );
    }),
  /**
   * Aggregated counts keyed by role → shift → count. Admin-only.
   *
   * All reads run inside a single `repos.tx()` so we don't incur an N+1
   * transaction per role. The underlying query uses
   * `countByShiftForEvent(eventId)` which returns every shift's count in one
   * `groupBy` — we reshape that flat map into the nested `{ byRole, byShift }`
   * structure the admin UI expects.
   *
   * `byRole` / `byShift` are pending-inclusive (PENDING | APPROVED |
   * CHECKED_IN) — the review-workload view. `acceptedByRole` /
   * `acceptedByShift` count only accepted signups (APPROVED | CHECKED_IN),
   * matching the public occupancy counters, so "filled vs capacity" never
   * shows pending applicants overflowing capacity. The accepted maps are
   * flat (`roleId → count`, `shiftId → count`) and omit zero-count entries.
   */
  counts: authedProcedure
    .input(signupCountsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(async () => {
        // RBAC + role discovery piggy-backs on list-event-roles (admin-only).
        const roles = await listEventVolunteerRoles(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { actorHumanId, eventId: input.eventId },
        );
        return ctx.repos.tx(async (tx) => {
          const [byRole, byShiftFlat, acceptedByRole, acceptedByShift] =
            await Promise.all([
              tx.volunteering.countByRole(input.eventId),
              tx.volunteering.countByShiftForEvent(input.eventId),
              tx.volunteering.countAcceptedByRole(input.eventId),
              tx.volunteering.countAcceptedByShiftForEvent(input.eventId),
            ]);

          // Reshape flat { shiftId → count } into { roleId → { shiftId → count } }.
          // Initialise an empty bucket for every role so callers can iterate
          // without optional-chaining.
          const byShift: Record<string, Record<string, number>> = {};
          for (const role of roles) {
            byShift[role.id] = {};
            for (const shift of role.shifts) {
              const count = byShiftFlat[shift.id];
              if (count !== undefined) {
                byShift[role.id]![shift.id] = count;
              }
            }
          }
          return { byRole, byShift, acceptedByRole, acceptedByShift };
        });
      });
    }),

  /**
   * Per-event signup counts grouped by status for a batch of events.
   *
   * Powers the admin events list "needs review" column without an N+1 fetch.
   * Authorization: we delegate to the existing `listMyEvents` use case which
   * already enforces org-membership / owner-access. The intersection of the
   * caller's visible events and the requested ids is what we count, so an
   * attacker who passes a foreign event id alongside legit ones can't probe
   * signup counts for events they don't own.
   */
  statusCountsBatch: authedProcedure
    .input(
      z.object({
        eventIds: z.array(z.string().uuid()).max(200),
        ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
        ownerId: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(async () => {
        if (input.eventIds.length === 0) return {};
        const owned = await listMyEvents(
          { repos: ctx.repos, logger: ctx.logger },
          {
            actorHumanId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            limit: 100,
          },
        );
        const ownedIds = new Set(owned.items.map((e) => e.id));
        const visibleIds = input.eventIds.filter((id) => ownedIds.has(id));
        if (visibleIds.length === 0) return {};
        return ctx.repos.tx((tx) =>
          tx.volunteering.countByEventsAndStatus(visibleIds),
        );
      });
    }),
});

/**
 * Org-wide volunteer hours reporting (Gap 7).
 *
 * `orgSummary` returns one row per distinct volunteer across all of the
 * org's events (total hours, events count, last shift date), with an
 * optional date-range filter. RBAC (any org member, ORG_ANY_ROLE) is
 * enforced inside the use case. Like `signups.exportHours`, the rows
 * come back as data and the web client serialises CSV client-side.
 */
const hoursRouter = router({
  orgSummary: authedProcedure
    .input(orgHoursSummaryInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getOrgVolunteerHoursSummary(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
});

/**
 * Public-facing roles for the event signup page.
 *
 * Delegates to the `listPublicEventVolunteerRoles` core use case which
 * enforces the visibility gate (event must exist, be PUBLISHED, and have
 * volunteering enabled) and projects to a public DTO that strips admin-only
 * fields (`autoApprove`, `templateId`, `notes`, timestamps).
 */
const publicRolesRouter = router({
  list: publicProcedure
    .input(publicRolesListInput)
    .query(async ({ ctx, input }) => {
      return call(() =>
        listPublicEventVolunteerRoles(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        ),
      );
    }),
  /**
   * Waiver metadata for the public signup form (Gap 3):
   * `{ waiverRequired, waiver: { templateId, version, title, body } | null,
   * alreadyAccepted }`. Optional auth — `alreadyAccepted` is computed for
   * the signed-in viewer (actorHumanId from ctx, never from input) and is
   * always false for guests. The use case applies the same visibility gate
   * as `list` (unpublished / volunteering-off events collapse to NOT_FOUND).
   */
  waiver: optionalProcedure
    .input(publicWaiverInput)
    .query(async ({ ctx, input }) => {
      return call(() =>
        getPublicVolunteerWaiver(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId ?? null },
        ),
      );
    }),
});

// ── Generic volunteer asks (generic-volunteering-asks spec) ─────────────────

const asksRouter = router({
  create: authedProcedure
    .input(createAskInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createVolunteerAsk(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  update: authedProcedure
    .input(updateAskInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateVolunteerAsk(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Attach (or clear, with null) a waiver template on a standing ask.
   * Authz + per-subject template ownership validation live in core's
   * `assignWaiverToAsk`; EVENT-subject asks are rejected (they keep
   * event-level assignment). Deliberately separate from `update` so a
   * broad field patch can never silently re-point a liability gate.
   */
  assignWaiver: authedProcedure
    .input(assignAskWaiverInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        assignWaiverToAsk(
          { repos: ctx.repos, clock: ctx.clock },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Dashboard listing for a place / org / human ("me") subject. Authz
   * delegates to core's `resolveAskOwnership` (THE ask trust gate) inside
   * the same tx as the read — same composition pattern as
   * `signups.counts`, which piggybacks RBAC on a core call before its tx
   * reads. There is deliberately no standalone core list use case yet.
   */
  listBySubject: authedProcedure
    .input(listAsksBySubjectInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        ctx.repos.tx(async (tx) => {
          await resolveAskOwnership(
            tx,
            {
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              orgId: null,
            },
            actorHumanId,
          );
          return tx.volunteering.listAsksBySubject(
            input.subjectType,
            input.subjectId,
          );
        }),
      );
    }),
  /** Org dashboard listing via the denormalized `orgId`. EDITOR+ only. */
  listByOrg: authedProcedure
    .input(listAsksByOrgInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        ctx.repos.tx(async (tx) => {
          await resolveAskOwnership(
            tx,
            { subjectType: "ORG", subjectId: input.orgId, orgId: input.orgId },
            actorHumanId,
          );
          return tx.volunteering.listAsksByOrg(
            input.orgId,
            input.status ? { status: input.status } : undefined,
          );
        }),
      );
    }),
});

const askRolesRouter = router({
  add: authedProcedure
    .input(addAskRoleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        addVolunteerAskRole(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  update: authedProcedure
    .input(updateAskRoleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateVolunteerAskRole(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
});

const groupsRouter = router({
  create: authedProcedure
    .input(createGroupInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createVolunteerGroup(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Set / replace / clear (both target fields absent) the single
   * coordinator on a group. The new coordinator is told in-app AND by
   * email: `notifyWithEmail` binds the mailer (plain `ctx.notify` skips the
   * email leg with `port_unavailable`), falling back to in-app-only when no
   * mailer is configured. A swallowed notify failure reports to Sentry.
   *
   * Because every call can email an address the actor typed, it is capped
   * per actor: 20/hour here on every call, plus the use case's fail-closed
   * daily cap on NEW addresses (shadow-profile minting).
   */
  assignCoordinator: authedProcedure
    .input(assignCoordinatorInput)
    .use(
      rateLimit({
        key: (ctx) => `volunteer:assignCoordinator:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "assigning coordinators",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        assignGroupCoordinator(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notifyWithEmail ?? ctx.notify,
            reportError: ctx.reportError ?? undefined,
            rateLimit: ctx.rateLimit,
            // Null (not "") when unset: the use case skips the notice with a
            // reported config warning instead of building a non-URL link.
            appBaseUrl: ctx.publicAppUrl ?? null,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
});

const rosterRouter = router({
  /** Owner view — every role, group, and the general pool (FR-007). */
  ask: authedProcedure.input(askRosterInput).query(async ({ ctx, input }) => {
    const actorHumanId = requireActor(ctx);
    // Drop the tRPC-injected `direction` before forwarding: the use case
    // has no `direction` field (see the askRosterInput comment).
    const { direction: _direction, ...rest } = input;
    return call(() =>
      listAskRoster(
        { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
        { ...rest, actorHumanId },
      ),
    );
  }),
  /** Coordinator view — ONLY the actor's group(s) for the ask (NFR-003). */
  coordinator: authedProcedure
    .input(coordinatorRosterInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      // Same `direction` strip as roster.ask.
      const { direction: _direction, ...rest } = input;
      return call(() =>
        listCoordinatorRoster(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...rest, actorHumanId },
        ),
      );
    }),
});

const broadcastsRouter = router({
  /**
   * One-way roster announcement (FR-009). Owner: any scope; coordinator:
   * own group only — enforced in the use case. `broadcastId` is the
   * client-supplied idempotency key; a retry replays the ledger row
   * without re-sending. Shadow (humanId-less) volunteers are reached by
   * direct email, so a configured mailer is a hard precondition.
   */
  send: authedProcedure
    .input(broadcastSendInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      const mailer = ctx.mailer;
      if (!mailer) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Mailer not configured",
        });
      }
      return call(() =>
        broadcastToRoster(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            mailer,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /** Broadcast ledger — owner: all; coordinator: own sends + own group. */
  list: authedProcedure
    .input(broadcastListInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listAskBroadcasts(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
});

/**
 * Shift occurrences + claims on standing asks
 * (generic-volunteer-shifts-occurrences spec, phase A). Occurrence CRUD is
 * owner-gated (resolveAskOwnership in core); claim/withdraw are
 * volunteer-self-serve; assign/checkIn are owner-or-coordinator
 * (coordinator scoped to their own group, enforced in core). The public
 * open-slot schedule lives on `publicAsks.schedule`.
 */
const scheduleRouter = router({
  createOccurrence: authedProcedure
    .input(createOccurrenceInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        createShiftOccurrence(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? null,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  updateOccurrence: authedProcedure
    .input(updateOccurrenceInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateShiftOccurrence(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notify,
            appBaseUrl: ctx.publicAppUrl ?? null,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Cancel notifies every active claimant (email + in-app).
   * `notifyWithEmail` binds the mailer so the email leg actually sends
   * (a claimant may never open the app before the cancelled date) —
   * falls back to in-app-only `notify` when no mailer is configured
   * (same precedent as booking-requests).
   */
  cancelOccurrence: authedProcedure
    .input(cancelOccurrenceInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        cancelShiftOccurrence(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            notify: ctx.notifyWithEmail ?? ctx.notify,
            // Shadow claimants have no notify() identity — reached by a
            // direct best-effort mailer send instead.
            mailer: ctx.mailer ?? null,
            // Null (not "") when unset: the use case skips the notify leg
            // with a reported config warning instead of feeding the strict
            // renderer a non-URL askUrl (which would swallow every send).
            appBaseUrl: ctx.publicAppUrl ?? null,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /** Owner schedule tab: occurrences with active-claim counts. */
  listOccurrences: authedProcedure
    .input(listOccurrencesInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listAskOccurrences(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /** Self-serve claim by an APPROVED same-ask+role volunteer. */
  claim: authedProcedure
    .input(claimOccurrenceInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        claimOccurrence(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  withdrawClaim: authedProcedure
    .input(withdrawClaimInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        withdrawOccurrenceClaim(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Owner/coordinator assignment. The confirmation email (with .ics
   * attachment) is post-commit best-effort — an unconfigured mailer never
   * blocks the assignment (mirrors the comp-grant mailer posture).
   */
  assign: authedProcedure
    .input(assignClaimInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        assignOccurrenceClaim(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            mailer: ctx.mailer ?? null,
            appBaseUrl: ctx.publicAppUrl ?? null,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  checkIn: authedProcedure
    .input(checkInClaimInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        checkInOccurrenceClaim(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /** Per-occurrence roster — owner all claims, coordinator own group only. */
  roster: authedProcedure
    .input(occurrenceRosterInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listOccurrenceRoster(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
});

/**
 * Public-facing ask read for the generic signup page (`/v/[askId]`).
 * Mirrors `publicRoles.list`: the core use case enforces the visibility
 * gate (DRAFT/ARCHIVED collapse to NOT_FOUND; PAUSED/CLOSED stay readable
 * for a friendly closed page) and projects to a public DTO.
 */
const publicAsksRouter = router({
  get: publicProcedure
    .input(getPublicVolunteerAskInputSchema)
    .query(async ({ ctx, input }) => {
      return call(() =>
        getPublicVolunteerAsk({ repos: ctx.repos, logger: ctx.logger }, input),
      );
    }),
  /**
   * Waiver metadata for the public ask signup form
   * (ask-level-volunteer-waivers spec): `{ waiverRequired, waiver | null,
   * alreadyOnFile }`. Optional auth — `alreadyOnFile` is computed for the
   * signed-in viewer (actorHumanId from ctx, never input) and is always
   * false for guests. Same DRAFT/ARCHIVED → NOT_FOUND gate as `get`.
   */
  waiver: optionalProcedure
    .input(publicAskWaiverInput)
    .query(async ({ ctx, input }) => {
      return call(() =>
        getPublicAskWaiver(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId ?? null },
        ),
      );
    }),
  /**
   * Public upcoming-schedule read (generic-volunteer-shifts-occurrences
   * NFR-003): SCHEDULED future occurrences with open-slot counts only —
   * never claimant identity. Same DRAFT/ARCHIVED → NOT_FOUND gate as `get`.
   */
  schedule: publicProcedure
    .input(getPublicAskScheduleInputSchema)
    .query(async ({ ctx, input }) => {
      return call(() =>
        getPublicAskSchedule(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          input,
        ),
      );
    }),
});

const icsRouter = router({
  /**
   * Per-signup `.ics` download (FR-012). Returns `{ icsBody, filename }`;
   * the web client Blob-downloads it — same delivery as the admin
   * calendar's per-event downloads, so no HTTP route is needed for the
   * authed single-file case.
   */
  mySignupIcs: authedProcedure
    .input(signupIcsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        exportSignupIcs(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Get-or-mint the actor's "my volunteering" feed token (FR-012).
   * Returns `{ feedToken, minted }` — the token ONLY. The UI composes the
   * subscribable URL (`{apiBaseUrl}/api/volunteering/{token}/calendar.ics`)
   * client-side, matching how `apps/web/src/lib/calendar/calendar-actions.ts`
   * builds the venue feed URL —
   * the transport doesn't know the public API origin.
   */
  myFeedToken: authedProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getMyVolunteerIcsFeedToken(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { actorHumanId },
        ),
      );
    }),
  /**
   * Rotate the actor's feed token — unconditional overwrite for a leaked
   * calendar URL. Same shape as `myFeedToken` (`{ feedToken, minted }`)
   * so the UI swaps URLs in place; every previously subscribed calendar
   * app breaks immediately. Self-only: identity comes from ctx, never
   * from client input.
   */
  rotateMyFeedToken: authedProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        rotateMyVolunteerIcsFeedToken(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            appBaseUrl: ctx.publicAppUrl ?? "",
          },
          { actorHumanId },
        ),
      );
    }),
});

// ── Comp-ticket rewards (volunteer-comp-tickets spec) ───────────────────────
//
// Config + read + MANUAL revoke. `grant` is NOT exposed — it fires system-side
// from the review / check-in triggers (see makeRewardHooks). `revoke` has TWO
// callers: the system-fired withdraw path (no actor, via makeRewardHooks) and
// this client-callable `rewards.revoke` (actor injected → the use case's
// ORG_FINANCE_ROLES gate applies, so a non-finance organiser gets FORBIDDEN).
const rewardsRouter = router({
  /**
   * Create / update the comp reward on an ask (or one of its roles). Finance-
   * gated in the use case (spends organizer revenue). A concurrent ask-level
   * upsert race surfaces the adapter's `duplicate_reward` as CONFLICT.
   */
  set: authedProcedure
    .input(setRewardInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        setVolunteerReward(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Owner / finance reward ledger for an ask: per-grant redemption state plus
   * granted / redeemed / revoked counts, remaining budget, and face value
   * comped (integer cents).
   */
  ledger: authedProcedure
    .input(rewardLedgerInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listAskRewardLedger(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Owner / finance list of the rewards CONFIGURED on an ask (config form +
   * status). Enumerates every reward — inactive and zero-grant included — so
   * the form can pre-fill and the status view is complete.
   */
  list: authedProcedure
    .input(rewardListInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listAskRewards(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),
  /**
   * Manually void an unused comp grant (FR-007): sets the comp ticket INVALID,
   * cancels the $0 comp order, and returns the budget slot. The MANUAL,
   * finance-gated path — because `actorHumanId` is injected, the use case
   * enforces `ORG_FINANCE_ROLES` on the reward's owning org (a plain
   * organiser/editor without finance → FORBIDDEN). Idempotent on an
   * already-REVOKED grant; a redeemed/scanned comp is refused as
   * `reward_already_redeemed` (CONFLICT) — clawing that back is a manual refund
   * decision, not an auto-void.
   */
  revoke: authedProcedure
    .input(revokeRewardInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        revokeVolunteerReward(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
});

// ── Top-level volunteer router ──────────────────────────────────────────────

export const volunteerRouter = {
  templates: templatesRouter,
  roles: rolesRouter,
  shifts: shiftsRouter,
  signups: signupsRouter,
  hours: hoursRouter,
  publicRoles: publicRolesRouter,
  asks: asksRouter,
  askRoles: askRolesRouter,
  groups: groupsRouter,
  roster: rosterRouter,
  broadcasts: broadcastsRouter,
  schedule: scheduleRouter,
  publicAsks: publicAsksRouter,
  ics: icsRouter,
  rewards: rewardsRouter,
};

export type VolunteerRouter = typeof volunteerRouter;
