import { beforeEach, describe, expect, it, vi } from "vitest";

import * as placeLayoutUseCases from "@th/core/use-cases/place-layouts";
import type { ReplacePlaceLayoutOutput } from "@th/core/use-cases/place-layouts";

import { placeLayoutsRouter } from "../place-layouts";
import { createCaller } from "./test-helpers";

const baseOutput: ReplacePlaceLayoutOutput = {
  checksum: "checksum-test",
  diff: { added: 1, removed: 0, moved: 0, sectionsChanged: [] },
  issues: [],
  seatCount: 1,
  sectionCount: 1,
  seatIndexBounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 },
};

describe("placeLayoutsRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies and actor to replacePlaceLayout", async () => {
    const replaceSpy = vi
      .spyOn(placeLayoutUseCases, "replacePlaceLayout")
      .mockResolvedValue(baseOutput);
    const placeLayoutParser = { parse: vi.fn() } as any;
    const placeLayoutStreaming = { publishPlaceLayoutReplaced: vi.fn() } as any;

    const { caller, ctx } = createCaller(placeLayoutsRouter, {
      placeLayoutParser,
      placeLayoutStreaming,
    });

    const input = {
      placeId: "11111111-1111-4111-8111-111111111111",
      upload: { ref: "upload-1", format: "svg", source: "admin_wizard" },
      options: { idempotencyKey: "idem-key-1234" },
    };

    const result = await caller.replacePlaceLayout(input);

    expect(result).toEqual(baseOutput);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        parser: placeLayoutParser,
        streaming: placeLayoutStreaming,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        placeId: input.placeId,
        upload: input.upload,
        options: input.options,
      }),
    );
  });

  it("maps use case errors from replacePlaceLayout", async () => {
    vi.spyOn(placeLayoutUseCases, "replacePlaceLayout").mockRejectedValue({
      code: "invalid_input",
      message: "place_layout_empty",
    });

    const { caller } = createCaller(placeLayoutsRouter);

    await expect(
      caller.replacePlaceLayout({
        placeId: "11111111-1111-4111-8111-111111111111",
        upload: { ref: "upload-1", format: "svg", source: "admin" },
        options: { idempotencyKey: "idem-key-1234" },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "place_layout_empty",
    });
  });

  it("forwards dependencies and actor to deletePlaceLayout", async () => {
    const deleteSpy = vi
      .spyOn(placeLayoutUseCases, "deletePlaceLayout")
      .mockResolvedValue({
        deleted: true,
        deletedChecksum: "checksum-test",
      });
    const placeLayoutStreaming = { publishPlaceLayoutReplaced: vi.fn() } as any;

    const { caller, ctx } = createCaller(placeLayoutsRouter, {
      placeLayoutStreaming,
    });

    const input = {
      placeId: "22222222-2222-4222-8222-222222222222",
      reason: "test-delete",
    };

    const result = await caller.deletePlaceLayout(input);

    expect(result).toEqual({ deleted: true, deletedChecksum: "checksum-test" });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        streaming: placeLayoutStreaming,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        placeId: input.placeId,
        reason: input.reason,
      }),
    );
  });

  it("maps use case errors from deletePlaceLayout", async () => {
    vi.spyOn(placeLayoutUseCases, "deletePlaceLayout").mockRejectedValue({
      code: "forbidden",
      message: "not_allowed",
    });

    const { caller } = createCaller(placeLayoutsRouter);

    await expect(
      caller.deletePlaceLayout({
        placeId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_allowed" });
  });
});
