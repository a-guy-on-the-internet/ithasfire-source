import { beforeEach, describe, expect, it, vi } from "vitest";

import * as scannerUseCases from "@th/core/use-cases/scanner";

import { scannerRouter } from "../scanner";
import { createCaller } from "./test-helpers";

describe("scannerRouter.listAccessibleEvents", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // The use case degrades an unreadable venue to "no coordinates" instead of
  // failing the picker; that swallow must reach Sentry (ReporterPort).
  it("forwards the reporter and injects the actor from ctx", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(scannerUseCases, "listScannerAccessibleEvents")
      .mockResolvedValue({ events: [], viaPlatformAdmin: false });
    const { caller, ctx } = createCaller(scannerRouter, { reportError });

    await caller.listAccessibleEvents({});

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, reportError }),
      expect.objectContaining({ actorHumanId: ctx.actorHumanId }),
    );
  });
});
