import { TRPCError } from "@trpc/server";

import {
  approveDisputeEvidence,
  approveDisputeEvidenceInputSchema,
  approveDisputeEvidenceOutputSchema,
  assembleDisputeEvidence,
  assembleDisputeEvidenceInputSchema,
  assembleDisputeEvidenceOutputSchema,
  getDisputeForDesk,
  getDisputeForDeskInputSchema,
  getDisputeForDeskOutputSchema,
  listDisputesForDesk,
  listDisputesForDeskInputSchema,
  listDisputesForDeskOutputSchema,
  requireDisputeDeskStaff,
  submitDisputeEvidence,
  submitDisputeEvidenceInputSchema,
  submitDisputeEvidenceOutputSchema,
  updateDisputeEvidenceDraft,
  updateDisputeEvidenceDraftInputSchema,
  updateDisputeEvidenceDraftOutputSchema,
} from "@th/core/use-cases/disputes/evidence";

import { authedProcedure, router } from "../init";
import { rateLimit } from "../guard";
import { toTrpcError } from "../utils";
import type { Ctx } from "../context";

// ─────────────────────────────────────────────────────────────────────────────
// Dispute desk — staff read/write surface for chargeback evidence.
//
// Mounted UNDER the platform router (`platform.disputes.*`), exactly like
// `platform.ticketPacks.*`, so every procedure inherits the wholesale staff
// second-factor gate in guard.ts (`path.startsWith("platform.")`) without
// growing the per-path allowlist. Every use case additionally enforces the
// desk role inside core (`requireDisputeDeskStaff`): reads = ADMIN|SUPPORT,
// writes = ADMIN. The transport only checks an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

// Per-actor caps on the mutations (Redis fixed-window). Generous for humans,
// tight enough that a stuck client cannot flood the audit log or the
// processor: a submit is one irreversible processor call per package.
const DESK_MUTATION_MAX = 30;
const DESK_MUTATION_WINDOW_S = 60;
const DESK_SUBMIT_MAX = 10;
const DESK_SUBMIT_WINDOW_S = 60;

const listInput = listDisputesForDeskInputSchema.omit({ actorHumanId: true });
const getInput = getDisputeForDeskInputSchema.omit({ actorHumanId: true });
// `assemble` has no actor in its core input (the webhook calls it too), so
// the transport does the desk role check itself before delegating.
const assembleInput = assembleDisputeEvidenceInputSchema;
const updateDraftInput = updateDisputeEvidenceDraftInputSchema.omit({
  actorHumanId: true,
});
const approveInput = approveDisputeEvidenceInputSchema.omit({
  actorHumanId: true,
});
// The processor idempotency key is derived server-side from the package's
// attempt id; a client-supplied key would let a stale tab replay a submit
// under a fresh key.
const submitInput = submitDisputeEvidenceInputSchema.omit({
  actorHumanId: true,
  idempotencyKey: true,
});

function readDeps(ctx: Ctx) {
  return {
    repos: ctx.repos,
    authz: ctx.authz,
    logger: ctx.logger,
    reportError: ctx.reportError ?? undefined,
  };
}

function writeDeps(ctx: Ctx) {
  return {
    repos: ctx.repos,
    authz: ctx.authz,
    // Per-dispute mutex shared by every package mutation.
    idempotency: ctx.idempotency,
    clock: ctx.clock,
    logger: ctx.logger,
    reportError: ctx.reportError ?? undefined,
  };
}

const mutationLimit = (name: string) =>
  rateLimit({
    key: (ctx) => `platform:disputes:${name}:${ctx.actorHumanId}`,
    maxRequests: DESK_MUTATION_MAX,
    windowSeconds: DESK_MUTATION_WINDOW_S,
    message: "updating dispute evidence",
  });

export const disputesRouter = router({
  list: authedProcedure
    .input(listInput)
    .output(listDisputesForDeskOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listDisputesForDesk(readDeps(ctx), { ...input, actorHumanId }),
      );
    }),

  get: authedProcedure
    .input(getInput)
    .output(getDisputeForDeskOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getDisputeForDesk(readDeps(ctx), { ...input, actorHumanId }),
      );
    }),

  /** (Re-)assemble the package from persisted order data. `force` re-drafts. */
  assemble: authedProcedure
    .use(mutationLimit("assemble"))
    .input(assembleInput)
    .output(assembleDisputeEvidenceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(async () => {
        await requireDisputeDeskStaff({ authz: ctx.authz }, actorHumanId, "write");
        return assembleDisputeEvidence(writeDeps(ctx), input);
      });
    }),

  updateDraft: authedProcedure
    .use(mutationLimit("updateDraft"))
    .input(updateDraftInput)
    .output(updateDisputeEvidenceDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updateDisputeEvidenceDraft(writeDeps(ctx), { ...input, actorHumanId }),
      );
    }),

  approve: authedProcedure
    .use(mutationLimit("approve"))
    .input(approveInput)
    .output(approveDisputeEvidenceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        approveDisputeEvidence(writeDeps(ctx), { ...input, actorHumanId }),
      );
    }),

  submit: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `platform:disputes:submit:${ctx.actorHumanId}`,
        maxRequests: DESK_SUBMIT_MAX,
        windowSeconds: DESK_SUBMIT_WINDOW_S,
        message: "submitting dispute evidence",
      }),
    )
    .input(submitInput)
    .output(submitDisputeEvidenceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        submitDisputeEvidence(
          { ...writeDeps(ctx), payments: ctx.payments },
          { ...input, actorHumanId },
        ),
      );
    }),
});
