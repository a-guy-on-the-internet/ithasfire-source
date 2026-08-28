import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@th/errors";

const logAndReportMock = vi.fn(async () => undefined);
const fastifyTRPCPluginMock = vi.fn();
const createContextFactoryMock = vi.fn(() => vi.fn());
const captureExceptionMock = vi.fn();

vi.mock("@th/adapters/infra/discord-alerts", () => ({
  logAndReport: logAndReportMock,
}));

vi.mock("@trpc/server/adapters/fastify", () => ({
  fastifyTRPCPlugin: fastifyTRPCPluginMock,
}));

vi.mock("@th/trpc", () => ({
  appRouter: { _def: {} },
  createContextFactory: createContextFactoryMock,
}));

vi.mock("../src/instrument", () => ({
  Sentry: {
    captureException: captureExceptionMock,
  },
}));

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}

describe("trpc plugin observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContextFactoryMock.mockReturnValue(vi.fn());
  });

  it("reports internal server errors through the shared helper", async () => {
    const logger = makeLogger();
    const discordAlert = vi.fn(async () => undefined);
    const app = {
      register: vi.fn(async () => undefined),
    };

    const { default: plugin } = await import("../src/plugins/trpc");

    await plugin(app as any, {
      prefix: "/trpc",
      deps: {
        logger: logger as any,
        discordAlert,
      } as any,
    });

    const registration = vi.mocked(app.register).mock.calls[0]?.[1] as {
      trpcOptions: { onError: (input: unknown) => void };
    };

    // The TRPCError itself (a real Error with a stack) — its `cause` is also
    // an Error here.
    const trpcError = Object.assign(new Error("Internal server error"), {
      code: "INTERNAL_SERVER_ERROR",
      cause: new Error("database unavailable"),
    });

    registration.trpcOptions.onError({
      path: "events.list",
      type: "query",
      error: trpcError,
    });

    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        logger,
        level: "error",
        message: "trpc.unhandled_error",
        extra: expect.objectContaining({
          trpcPath: "events.list",
          trpcType: "query",
          errorCode: "INTERNAL_SERVER_ERROR",
          cause: "database unavailable",
        }),
        report: expect.objectContaining({
          captureException: captureExceptionMock,
          // Always the TRPCError itself, never the (possibly stackless) cause.
          error: trpcError,
        }),
        alert: {
          send: discordAlert,
          payload: expect.objectContaining({
            title: "tRPC unhandled error",
            description:
              "A tRPC request failed unexpectedly. Check structured logs and Sentry for details.",
          }),
        },
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports the TRPCError (not the stackless plain-object cause) and preserves cause detail in extra", async () => {
    const logger = makeLogger();
    const app = {
      register: vi.fn(async () => undefined),
    };

    const { default: plugin } = await import("../src/plugins/trpc");

    await plugin(app as any, {
      prefix: "/trpc",
      deps: {
        logger: logger as any,
      } as any,
    });

    const registration = vi.mocked(app.register).mock.calls[0]?.[1] as {
      trpcOptions: { onError: (input: unknown) => void };
    };

    // Simulates a domain error like `createFileStorageError` — a PLAIN OBJECT
    // `{ code, message }` with no stack, wrapped in a real TRPCError.
    const trpcError = Object.assign(new Error("storage_error"), {
      code: "INTERNAL_SERVER_ERROR",
      cause: { code: "dependency_failed", message: "public_base_url_not_configured" },
    });

    registration.trpcOptions.onError({
      path: "events.requestImageUpload",
      type: "mutation",
      error: trpcError,
    });

    const call = logAndReportMock.mock.calls.at(-1)?.[0] as any;

    // The reported exception is the real Error (has a stack), not the cause.
    expect(call.report.error).toBe(trpcError);
    expect(call.report.error).toBeInstanceOf(Error);

    // Cause detail is preserved in Sentry extra + the structured log.
    expect(call.report.context.extra).toEqual(
      expect.objectContaining({
        cause: {
          code: "dependency_failed",
          message: "public_base_url_not_configured",
        },
        causeCode: "dependency_failed",
        causeMessage: "public_base_url_not_configured",
      }),
    );
    expect(call.extra).toEqual(
      expect.objectContaining({
        causeCode: "dependency_failed",
        cause: "public_base_url_not_configured",
      }),
    );
  });

  // The `errorFormatter` tests that used to live here were deleted, not fixed.
  // They reached into `app.register`'s trpcOptions, but tRPC honours
  // errorFormatter ONLY on initTRPC.create(...) — it moved to
  // packages/transport/trpc/src/trpc.ts (see the comment there), so the Fastify
  // adapter never carried one and the assertions were testing a dead location.
  //
  // Coverage now lives closer to the code: the meta/appCode resolution rules are
  // exercised in packages/transport/trpc/src/utils.test.ts ("wire errorFormatter"),
  // and that the real router actually HAS the formatter wired is asserted in
  // packages/transport/trpc/src/__tests__/trpc-error-formatter.test.ts.
  //
  // What stays here is what is genuinely plugin-level: onError -> Sentry.
});
