import { beforeEach, describe, expect, it, vi } from "vitest";

import * as placesUseCases from "@th/core/use-cases/places";

import { createCaller } from "./test-helpers";
import { placesRouter } from "../places";

describe("placesRouter.countDirectory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is public: a signed-out request reaches the use case with ctx deps and no `near`", async () => {
    const spy = vi
      .spyOn(placesUseCases, "countDirectoryPlaces")
      .mockResolvedValue({ count: 38 });

    // The home hero kicker is anonymous. `buildBaseCtx` defaults to a signed-in
    // ctx, so strip every credential: with `auth`, `authToken` and `apiKey`
    // all null, `resolveActorHumanId` returns null and `requireAuth` (what
    // `authedProcedure` mounts) throws UNAUTHORIZED. Only `publicProcedure`
    // lets this call through — flipping the procedure fails this test.
    const { caller, ctx } = createCaller(placesRouter, {
      auth: null,
      authToken: null,
      apiKey: null,
      actorHumanId: null,
      cookieHeader: null,
    });
    expect(ctx.auth).toBeNull();
    expect(ctx.authToken).toBeNull();
    expect(ctx.apiKey).toBeNull();
    expect(ctx.actorHumanId).toBeNull();

    const result = await caller.countDirectory({});

    expect(result).toEqual({ count: 38 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [depsArg, inputArg] = spy.mock.calls[0]!;
    expect(depsArg.repos).toBe(ctx.repos);
    expect(depsArg.logger?.info).toBeTypeOf("function");
    expect(inputArg).toEqual({});
  });

  it("forwards the `near` scope verbatim", async () => {
    const spy = vi
      .spyOn(placesUseCases, "countDirectoryPlaces")
      .mockResolvedValue({ count: 2 });

    const { caller } = createCaller(placesRouter);
    const near = { lat: 36.16, lng: -86.78, radiusKm: 25 };

    const result = await caller.countDirectory({ near });

    expect(result).toEqual({ count: 2 });
    expect(spy.mock.calls[0]![1]).toEqual({ near });
  });

  it("rejects invalid input at the boundary without reaching the use case", async () => {
    const spy = vi.spyOn(placesUseCases, "countDirectoryPlaces");

    const { caller } = createCaller(placesRouter);

    await expect(
      caller.countDirectory({ near: { lat: 91, lng: 0, radiusKm: 10 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });
});
