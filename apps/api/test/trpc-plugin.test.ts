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

describe("trpc plugin — client IP on error logs and reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContextFactoryMock.mockReturnValue(vi.fn());
  });

  const registerOnError = async (logger: ReturnType<typeof makeLogger>) => {
    const app = { register: vi.fn(async () => undefined) };
    const { default: plugin } = await import("../src/plugins/trpc");
    await plugin(app as any, {
      prefix: "/trpc",
      deps: { logger: logger as any } as any,
    });
    return (
      vi.mocked(app.register).mock.calls[0]?.[1] as {
        trpcOptions: { onError: (input: unknown) => void };
      }
    ).trpcOptions.onError;
  };

  // What Cloudflare → Google frontend hands the container.
  const req = {
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7, 172.70.1.1",
    },
    socket: { remoteAddress: "169.254.1.1" },
  };

  it("500s: logAndReport gets the IP fields in extra, and a client_ip Sentry tag", async () => {
    const logger = makeLogger();
    const onError = await registerOnError(logger);

    onError({
      path: "announcements.previewAudienceCount",
      type: "query",
      error: Object.assign(new Error("Invalid prisma.$queryRaw() invocation"), {
        code: "INTERNAL_SERVER_ERROR",
      }),
      req,
    });

    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          // Full detail stays in the log line.
          errorMessage: "Invalid prisma.$queryRaw() invocation",
          clientIp: "203.0.113.7",
          cfConnectingIp: "203.0.113.7",
          forwardedFor: "203.0.113.7, 172.70.1.1",
        }),
        report: expect.objectContaining({
          context: expect.objectContaining({
            tags: expect.objectContaining({ client_ip: "203.0.113.7" }),
            extra: expect.objectContaining({
              cfConnectingIp: "203.0.113.7",
              forwardedFor: "203.0.113.7, 172.70.1.1",
            }),
          }),
        }),
      }),
    );
  });

  it("client errors: the log line carries the IP fields", async () => {
    const logger = makeLogger();
    const onError = await registerOnError(logger);

    onError({
      path: "announcements.send",
      type: "mutation",
      error: Object.assign(new Error("bad input"), { code: "BAD_REQUEST" }),
      req,
    });

    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "trpc.client_error",
      expect.objectContaining({
        clientIp: "203.0.113.7",
        forwardedFor: "203.0.113.7, 172.70.1.1",
      }),
    );
  });

  it("prefers ctx.clientIp (e.g. a verified web forward) over header resolution", async () => {
    const logger = makeLogger();
    const onError = await registerOnError(logger);

    // The unlock route's call: Cloudflare saw the WEB SERVER; the context
    // resolved the guest from the signed forward.
    const webReq = {
      headers: {
        "cf-connecting-ip": "34.120.0.10",
        "x-forwarded-for": "34.120.0.10, 172.70.1.1",
      },
      socket: { remoteAddress: "169.254.1.1" },
    };

    onError({
      path: "events.validatePassword",
      type: "mutation",
      error: Object.assign(new Error("Rate limit exceeded."), {
        code: "TOO_MANY_REQUESTS",
      }),
      req: webReq,
      ctx: { clientIp: "198.51.100.23", clientIpSource: "forwarded" },
    });

    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "trpc.client_error",
      expect.objectContaining({
        clientIp: "198.51.100.23",
        clientIpSource: "forwarded",
        // Raw header fields are still the headers' own values.
        cfConnectingIp: "34.120.0.10",
        forwardedFor: "34.120.0.10, 172.70.1.1",
      }),
    );

    onError({
      path: "events.validatePassword",
      type: "mutation",
      error: Object.assign(new Error("boom"), {
        code: "INTERNAL_SERVER_ERROR",
      }),
      req: webReq,
      ctx: { clientIp: "198.51.100.23", clientIpSource: "forwarded" },
    });

    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          clientIp: "198.51.100.23",
          clientIpSource: "forwarded",
          cfConnectingIp: "34.120.0.10",
        }),
        report: expect.objectContaining({
          context: expect.objectContaining({
            tags: expect.objectContaining({ client_ip: "198.51.100.23" }),
            extra: expect.objectContaining({ clientIpSource: "forwarded" }),
          }),
        }),
      }),
    );
  });

  it("no req (defensive): IP fields are null, nothing throws", async () => {
    const logger = makeLogger();
    const onError = await registerOnError(logger);

    onError({
      path: "x.y",
      type: "query",
      error: Object.assign(new Error("boom"), {
        code: "INTERNAL_SERVER_ERROR",
      }),
    });

    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ clientIp: null }),
      }),
    );
  });
});
