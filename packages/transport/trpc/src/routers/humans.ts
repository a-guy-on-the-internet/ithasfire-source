import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  acceptChargebackTerms,
  acceptChargebackTermsOutputSchema,
} from "@th/core/use-cases/payments";
import {
  acknowledgeScannerTerms,
  deleteMyAccount,
  deleteMyAccountInputSchema,
  deleteMyAccountOutputSchema,
  getHuman,
  getHumanInputSchema,
  getHumanOutputSchema,
  getHumanStats,
  getHumanStatsInputSchema,
  getHumanStatsOutputSchema,
  getMyNextNight,
  getMyNextNightOutputSchema,
  getMyWorkSummary,
  getMyWorkSummaryOutputSchema,
  searchTransferRecipients,
  searchTransferRecipientsInputSchema,
  searchTransferRecipientsOutputSchema,
  setThemePreference,
  setThemePreferenceInputSchema,
  setThemePreferenceOutputSchema,
  updateHumanProfile,
  updateHumanProfileInputSchema,
  updateHumanProfileOutputSchema,
  updateHumanJobs,
  updateHumanJobsInputSchema,
  updateHumanJobsOutputSchema,
} from "@th/core/use-cases/humans";

import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";
import { isActorEmailVerified } from "../verified-email";

const getHumanStatsInput = getHumanStatsInputSchema.omit({
  actorHumanId: true,
});
const searchTransferRecipientsInput = searchTransferRecipientsInputSchema.omit({
  actorHumanId: true,
});
const setThemePreferenceInput = setThemePreferenceInputSchema.omit({
  actingUserId: true,
});

export const humansRouter = {
  // `createHuman` / `provisionHumanForAuthUser` are deliberately NOT exposed.
  // Both were public procedures: `createHuman` returned any account's name,
  // phone and humanId for an email (F1, 2026-09-29 scanner), and
  // `provisionHumanForAuthUser` let a caller overwrite a linked user's avatar
  // (F12). Human provisioning runs server-side only, from the Better Auth
  // hooks in apps/api/src/auth/better-auth.ts, which import the use case.

  // DB-backed human reads are auth-protected and must resolve the actor from
  // the current request context; callers cannot self-elect by supplying a target id.
  getHuman: authedProcedure
    .input(getHumanInputSchema.omit({ actorHumanId: true }))
    .output(getHumanOutputSchema)
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
      } satisfies Parameters<typeof getHuman>[0];

      try {
        return await getHuman(deps, {
          actorHumanId,
          targetHumanId: input.targetHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getStats: authedProcedure
    .input(getHumanStatsInput)
    .output(getHumanStatsOutputSchema)
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
      } satisfies Parameters<typeof getHumanStats>[0];

      try {
        return await getHumanStats(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  searchTransferRecipients: authedProcedure
    .input(searchTransferRecipientsInput)
    .output(searchTransferRecipientsOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof searchTransferRecipients>[0];

      try {
        return await searchTransferRecipients(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Returns the current user's saved contact/billing details.
   * Used by the checkout form to pre-fill fields.
   */
  getMyProfile: authedProcedure.query(async ({ ctx }) => {
    const actorHumanId = ctx.actorHumanId;
    if (!actorHumanId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Missing actor human id",
      });
    }
    const human = await ctx.repos.humans.getById(actorHumanId);
    if (!human) {
      throw new TRPCError({ code: "NOT_FOUND", message: "human_not_found" });
    }
    return {
      phone: human.phone,
      billingAddressLine1: human.billingAddressLine1,
      billingAddressLine2: human.billingAddressLine2,
      billingCity: human.billingCity,
      billingState: human.billingState,
      billingPostalCode: human.billingPostalCode,
      billingCountry: human.billingCountry,
      jobs: human.jobs ?? [],
      genreTags: human.genreTags ?? [],
      otherJobDescription: human.otherJobDescription ?? "",
      // Organizer chargeback-terms acceptance on the human's OWN row (solo
      // organizers). No gating: it is the caller's record. Lets the payments
      // page tell a returning owner has accepted instead of re-prompting on
      // every load (each re-accept would overwrite the legal `acceptedAt`).
      chargebackTermsVersion: human.chargebackTermsVersion ?? null,
      chargebackTermsAcceptedAt: human.chargebackTermsAcceptedAt ?? null,
    };
  }),

  /**
   * One-round-trip summary of the signed-in human's "work" footprint
   * (performer mode, administered groups, booking requests, venue claims,
   * edit suggestions). Feeds the account-settings nav so the "Your work"
   * sections stop mounting-then-fetching just to discover they're empty.
   *
   * Counts only — never entities. The actor is taken from the session; there
   * is no target-id input, so a caller can never summarize somebody else.
   */
  getMyWorkSummary: authedProcedure
    .output(getMyWorkSummaryOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // The use case degrades each sub-count to 0 instead of failing the
        // nav, so the reporter is what keeps that swallow visible.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getMyWorkSummary>[0];

      try {
        return await getMyWorkSummary(deps, { actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The viewer's next night (navbar account-menu block): the soonest
   * not-ended, published event they hold a ticket for, RSVP'd to, or are on
   * the lineup of — or null. Self-read: no input, the actor comes from the
   * session. Nothing is swallowed; a failing source fails the query and the
   * web hides the block.
   */
  getMyNextNight: authedProcedure
    .output(getMyNextNightOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
      } satisfies Parameters<typeof getMyNextNight>[0];

      try {
        // Ambient (navbar). An unverified account holds only what guest
        // checkout attached to it by email (B2): show no next night until it
        // proves the inbox, rather than throw. `null` hides every source of
        // a next night, RSVPs and lineup spots included, not only tickets.
        if (!(await isActorEmailVerified(ctx, actorHumanId))) return null;
        return await getMyNextNight(deps, { actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Whether the current user's account has a password credential (vs.
   * OAuth/passkey-only sign-in). Used by the account-deletion flow to decide
   * whether to require step-up password re-entry.
   */
  hasPasswordCredential: authedProcedure.query(async ({ ctx }) => {
    const actorHumanId = ctx.actorHumanId;
    if (!actorHumanId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Missing actor human id",
      });
    }
    return {
      hasPassword: await ctx.repos.humans.hasPasswordCredential(actorHumanId),
    };
  }),

  /**
   * Saves phone and/or billing address to the current user's profile
   * for faster future checkouts.
   */
  updateProfile: authedProcedure
    .input(updateHumanProfileInputSchema.omit({ actorHumanId: true }))
    .output(updateHumanProfileOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof updateHumanProfile>[0];

      try {
        return await updateHumanProfile(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Returns the current user's stored web light/dark preference, or `null`
   * when they have never set one (the web layer then falls back to the
   * `th-theme` cookie, then the default). Self-scoped: only the caller's own
   * preference is ever read.
   */
  getMyThemePreference: authedProcedure
    .output(z.object({ mode: z.enum(["light", "dark"]).nullable() }))
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      const human = await ctx.repos.humans.getById(actorHumanId);
      const mode =
        human?.themeMode === "light" || human?.themeMode === "dark"
          ? human.themeMode
          : null;
      return { mode };
    }),

  /**
   * Persists the current user's web light/dark preference so it syncs across
   * their devices. Self-scoped — the target is always the caller's own
   * actorHumanId (never accepted from the client).
   */
  setThemePreference: authedProcedure
    .input(setThemePreferenceInput)
    .output(setThemePreferenceOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof setThemePreference>[0];

      try {
        return await setThemePreference(deps, {
          ...input,
          actingUserId: actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateJobs: authedProcedure
    .input(updateHumanJobsInputSchema.omit({ actorHumanId: true }))
    .output(updateHumanJobsOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof updateHumanJobs>[0];

      try {
        return await updateHumanJobs(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Self-serve account deletion. The client can only ever target its own
   * actorHumanId (never let a client supply one) — no RBAC needed, gated
   * only by the confirmation phrase matching the caller's own email.
   */
  deleteMyAccount: authedProcedure
    .input(deleteMyAccountInputSchema.omit({ actorHumanId: true }))
    // Verifies a `currentPassword` against the stored hash when the account
    // has one — a brute-forceable credential check, same class as
    // `events.validatePassword` / sign-in's customRules. Tight per-actor cap
    // so a hijacked-session attacker can't grind guesses against the hash.
    .use(
      rateLimit<z.infer<typeof deleteMyAccountInputSchema>>({
        key: (ctx) => `humans:deleteMyAccount:${ctx.actorHumanId}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "deleting your account",
      }),
    )
    .output(deleteMyAccountOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof deleteMyAccount>[0];

      try {
        return await deleteMyAccount(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  acceptMyChargebackTerms: authedProcedure
    .output(acceptChargebackTermsOutputSchema)
    .mutation(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof acceptChargebackTerms>[0];

      try {
        return await acceptChargebackTerms(deps, {
          actorHumanId,
          target: { type: "HUMAN", humanId: actorHumanId },
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  acknowledgeScannerTerms: authedProcedure
    .input(z.object({ version: z.string() }))
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof acknowledgeScannerTerms>[0];

      try {
        return await acknowledgeScannerTerms(deps, {
          humanId: actorHumanId,
          version: input.version,
          ipAddress: ctx.clientIp ?? null,
          userAgent: ctx.userAgent ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type HumansRouter = typeof humansRouter;
