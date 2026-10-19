import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";
import { AppError } from "@th/errors";

import { INTERNAL_ERROR_WIRE_MESSAGE, t } from "../trpc";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";

// Regression for the 2026-09-29 incident: a 500 carried the raw Prisma error
// ("Invalid prisma.$queryRaw() invocation … column h.email does not exist")
// to the client. Driven through a real HTTP handler because `createCaller`
// never runs the errorFormatter — only a serialized response proves what
// actually reaches the wire.

const PRISMA_MESSAGE =
  'Invalid `prisma.$queryRaw()` invocation:\n\nRaw query failed. Code: `42703`. Message: `column h.email does not exist`';

/** Shaped like PrismaClientKnownRequestError P2010 — code + message + meta. */
const prismaLikeError = () =>
  Object.assign(new Error(PRISMA_MESSAGE), {
    code: "P2010",
    meta: { code: "42703", message: "column h.email does not exist" },
  });

const testRouter = t.router({
  dbFailure: t.procedure.query(() => {
    throw toTrpcError(prismaLikeError());
  }),
  // What tRPC does with a raw throw (e.g. tonight's middleware TypeError).
  typeErrorFailure: t.procedure.query(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'ownerId')");
  }),
  badRequest: t.procedure
    .input(z.object({ ownerId: z.string().uuid() }))
    .query(() => "unreachable"),
  // A use case's curated meta on a 500-class AppError, wrapping a processor
  // error that carries its OWN raw `.meta`.
  curatedFailure: t.procedure.query(() => {
    throw toTrpcError(
      new AppError("DISPUTE_EVIDENCE_SUBMIT_FAILED", {
        message: "the processor evidence submission failed",
        meta: {
          disputeId: "dp_1",
          processorError: { type: "api_error", message: "sanitised" },
        },
        cause: Object.assign(new Error("raw stripe text sk_live_x"), {
          meta: { raw: "sk_live_x" },
        }),
      }),
    );
  }),
  forbidden: t.procedure.query(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "insufficient_role" });
  }),
  // confirmPayment's refusal: the PI status is client-facing meta (a
  // redirect return reopens buying only on a dead PaymentIntent).
  paymentNotSucceeded: t.procedure.query(() => {
    throw toTrpcError(
      new AppError("PAYMENT_NOT_SUCCEEDED", {
        meta: { status: "requires_action" },
      }),
    );
  }),
});

type WireError = {
  message: string;
  data: Record<string, unknown>;
};

const call = async (
  path: string,
  opts: { isProduction: boolean; input?: unknown },
) => {
  const onError = vi.fn();
  const url = new URL(`http://localhost/trpc/${path}`);
  if (opts.input !== undefined) {
    url.searchParams.set("input", JSON.stringify({ json: opts.input }));
  }
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request(url),
    router: testRouter,
    createContext: () => ({ isProduction: opts.isProduction }) as Ctx,
    onError,
  });
  const body = (await res.json()) as { error: { json: WireError } };
  return { status: res.status, error: body.error.json, onError };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("errorFormatter — INTERNAL_SERVER_ERROR scrubbing", () => {
  it("production: a Prisma 500 reaches the client as a generic message, no meta, no stack", async () => {
    const { status, error, onError } = await call("dbFailure", {
      isProduction: true,
    });

    expect(status).toBe(500);
    expect(error.message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
    expect(error.data).not.toHaveProperty("meta");
    expect(error.data).not.toHaveProperty("stack");
    expect(JSON.stringify(error)).not.toMatch(/prisma|h\.email|42703/i);
    // Log/report path keeps the full detail.
    expect(onError).toHaveBeenCalledTimes(1);
    const logged = onError.mock.calls[0]![0].error as TRPCError;
    expect(logged.message).toBe(PRISMA_MESSAGE);
    expect((logged.cause as { meta?: unknown }).meta).toEqual({
      code: "42703",
      message: "column h.email does not exist",
    });
  });

  it("production: a raw TypeError 500 is scrubbed too", async () => {
    const { status, error, onError } = await call("typeErrorFailure", {
      isProduction: true,
    });

    expect(status).toBe(500);
    expect(error.message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
    expect(JSON.stringify(error)).not.toMatch(/ownerId/);
    expect((onError.mock.calls[0]![0].error as TRPCError).message).toMatch(
      /reading 'ownerId'/,
    );
  });

  it("NODE_ENV=production scrubs even when ctx does not say so (fail-safe)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { error } = await call("dbFailure", { isProduction: false });

    expect(error.message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
  });

  it("production: client errors keep their message (only 500s are scrubbed)", async () => {
    const forbidden = await call("forbidden", { isProduction: true });
    expect(forbidden.status).toBe(403);
    expect(forbidden.error.message).toBe("insufficient_role");

    const bad = await call("badRequest", {
      isProduction: true,
      input: { ownerId: "not-a-uuid" },
    });
    expect(bad.status).toBe(400);
    expect(bad.error.message).not.toBe(INTERNAL_ERROR_WIRE_MESSAGE);
  });

  it("non-production: the raw 500 message stays visible for local debugging", async () => {
    const { error } = await call("dbFailure", { isProduction: false });

    expect(error.message).toBe(PRISMA_MESSAGE);
  });
});

describe("errorFormatter — curated AppError meta survives the production scrub", () => {
  it("keeps meta a use case wrote on an AppError (dispute desk reads processorError)", async () => {
    const { status, error } = await call("curatedFailure", {
      isProduction: true,
    });

    expect(status).toBe(500);
    expect(error.message).toBe(INTERNAL_ERROR_WIRE_MESSAGE);
    expect(error.data.appCode).toBe("DISPUTE_EVIDENCE_SUBMIT_FAILED");
    expect(error.data.meta).toEqual({
      disputeId: "dp_1",
      processorError: { type: "api_error", message: "sanitised" },
      appCode: "DISPUTE_EVIDENCE_SUBMIT_FAILED",
    });
    // The wrapped processor error's own message/meta never reach the wire.
    expect(JSON.stringify(error)).not.toMatch(/sk_live_x/);
    expect(error.data).not.toHaveProperty("stack");
  });
});

describe("errorFormatter — PAYMENT_NOT_SUCCEEDED carries the PaymentIntent status", () => {
  it("production: the 409 keeps data.meta.status (the checkout tells a dead PI from a pending one)", async () => {
    const { status, error } = await call("paymentNotSucceeded", {
      isProduction: true,
    });

    expect(status).toBe(409);
    expect(error.data.appCode).toBe("PAYMENT_NOT_SUCCEEDED");
    expect(error.data.meta).toEqual({
      status: "requires_action",
      appCode: "PAYMENT_NOT_SUCCEEDED",
    });
  });
});
