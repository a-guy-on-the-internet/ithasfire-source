import type { FastifyPluginAsync } from "fastify";
import type { AnyRouter } from "@trpc/server";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { ZodError, type ZodIssue } from "zod";
import { logAndReport } from "@th/adapters/infra/discord-alerts";
import { appRouter, createContextFactory, type TrpcDeps } from "@th/trpc";
import { resolveWireAppCode } from "@th/trpc/utils";
import { Sentry } from "../instrument";
import { env } from "../lib/env";

// Sentry org slug used to build issue deep-links in alerts. The org is a stable
// SaaS tenant on us.sentry.io; `SENTRY_ORG` can override via env with no infra
// change required.
const SENTRY_ORG = env.SENTRY_ORG ?? "hearth-fire";

/**
 * Build a Sentry issue-search URL for a captured event id. Pasting an event id
 * into Sentry's issue search resolves to that specific event's issue. Returns
 * `undefined` when no org is configured so the alert simply omits the link.
 * Best-effort: never throws into the error-handling path.
 */
const sentryIssueUrl = (eventId: string): string | undefined => {
  if (!SENTRY_ORG) return undefined;
  return `https://${SENTRY_ORG}.sentry.io/organizations/${SENTRY_ORG}/issues/?query=${encodeURIComponent(
    eventId,
  )}`;
};

export type TrpcPluginOptions = {
  prefix?: string;
  deps: TrpcDeps;
};

const EXPECTED_CLIENT_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
]);

const plugin: FastifyPluginAsync<TrpcPluginOptions> = async (app, opts) => {
  const createContext = createContextFactory(opts.deps);
  const logger = opts.deps.logger.child({ transport: "trpc" });

  const trpcPlugin = fastifyTRPCPlugin as unknown as FastifyPluginAsync<
    FastifyTRPCPluginOptions<AnyRouter>
  >;

  // NOTE: The Fastify tRPC adapter's TS types don't expose `onError` on the
  // options object, but the runtime implementation forwards it to the
  // underlying HTTP handler — Sentry/structured logging below depends on it.
  // The `as any` cast is intentional (this option works correctly at runtime).
  //
  // `errorFormatter` is DELIBERATELY NOT set here: tRPC honors it ONLY when set
  // on `initTRPC.create(...)`, which the router's tRPC instance now does (see
  // packages/transport/trpc/src/trpc.ts). Passing it to the adapter did
  // nothing — the formatter that surfaced `data.appCode` / `data.meta` was dead
  // code — so it lives with the router instance now.
  await app.register(trpcPlugin, {
    prefix: opts.prefix ?? "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({
        path,
        error,
        type,
      }: {
        path: string | undefined;
        error: any;
        type: string;
      }) => {
        const isServerError = error.code === "INTERNAL_SERVER_ERROR";

        // Mirror the stable client-facing code into server logs (FR-008) so the
        // log line and the client response carry the same identifier — shared
        // resolution with the router's errorFormatter (both call
        // `resolveWireAppCode` from @th/trpc/utils).
        const appCode = resolveWireAppCode(error);

        const zodErrors =
          error.cause instanceof ZodError
            ? error.cause.issues.map((e: ZodIssue) => ({
                path: e.path.join("."),
                message: e.message,
                code: e.code,
              }))
            : undefined;

        const isOutputValidation =
          error.cause instanceof ZodError &&
          (error.message?.includes("output") ||
            error.message?.includes("Output"));

        if (isServerError) {
          // Many domain errors are PLAIN OBJECTS `{ code, message }` (e.g.
          // createFileStorageError), not Error instances — no stack, no
          // grouping. Passing `error.cause` straight to Sentry produced a
          // low-signal "Non-Error exception captured" event (or effectively
          // invisible). Always report the TRPCError itself (a real Error with
          // a stack + the wrapped message) and stash the cause detail in extra
          // so it isn't lost.
          const rawCause = error.cause as unknown;
          const causeRecord =
            rawCause && typeof rawCause === "object"
              ? (rawCause as Record<string, unknown>)
              : undefined;
          const causeCode =
            causeRecord && typeof causeRecord.code === "string"
              ? causeRecord.code
              : undefined;
          const causeMessage =
            rawCause instanceof Error
              ? rawCause.message
              : causeRecord && typeof causeRecord.message === "string"
                ? causeRecord.message
                : undefined;
          const causeSnapshot =
            rawCause === undefined
              ? undefined
              : rawCause instanceof Error
                ? { name: rawCause.name, message: rawCause.message }
                : causeRecord
                  ? { code: causeCode, message: causeMessage }
                  : { value: rawCause };

          void logAndReport({
            logger,
            level: "error",
            message: "trpc.unhandled_error",
            extra: {
              trpcPath: path,
              trpcType: type,
              errorMessage: error.message,
              errorCode: error.code,
              appCode,
              cause: causeMessage,
              causeCode,
              zodErrors,
            },
            report: {
              captureException: Sentry.captureException,
              buildSentryUrl: (eventId) => sentryIssueUrl(eventId),
              error: error,
              context: {
                tags: {
                  trpcPath: path,
                  trpcType: type,
                  trpcCode: error.code,
                  isOutputValidation: isOutputValidation ? "true" : undefined,
                },
                extra: {
                  ...(zodErrors ? { zodErrors } : {}),
                  ...(causeSnapshot ? { cause: causeSnapshot } : {}),
                  ...(causeCode ? { causeCode } : {}),
                  ...(causeMessage ? { causeMessage } : {}),
                },
              },
            },
            alert: opts.deps.discordAlert
              ? {
                  send: opts.deps.discordAlert,
                  payload: {
                    title: "tRPC unhandled error",
                    colour: "error",
                    description:
                      "A tRPC request failed unexpectedly. Check structured logs and Sentry for details.",
                    fields: [
                      { name: "Path", value: path ?? "unknown", inline: true },
                      { name: "Type", value: type, inline: true },
                      { name: "Code", value: error.code, inline: true },
                    ],
                  },
                }
              : undefined,
          });
        } else {
          const level = EXPECTED_CLIENT_ERROR_CODES.has(error.code)
            ? "info"
            : "warn";
          logger.log(level, "trpc.client_error", {
            trpcPath: path,
            trpcType: type,
            errorCode: error.code,
            errorMessage: error.message,
            appCode,
          });
        }
      },
    } as any,
  });
};

export default plugin;
