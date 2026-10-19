import { describe, expect, it, vi } from "vitest";

import type { Logger as PinoLogger } from "pino";

import { createPinoLoggerAdapter } from "../logger";

function createLoggerMock() {
  const trace = vi.fn();
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const fatal = vi.fn();
  const child = vi.fn();

  const logger = {
    trace,
    debug,
    info,
    warn,
    error,
    fatal,
    child,
  } as unknown as PinoLogger;

  return {
    logger,
    trace,
    debug,
    info,
    warn,
    error,
    fatal,
    child,
  };
}

describe("createPinoLoggerAdapter", () => {
  it("delegates to the requested log level", () => {
    const { logger, warn } = createLoggerMock();
    const adapter = createPinoLoggerAdapter({ logger });

    adapter.log("warn", "something happened", { module: "tests" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { module: "tests" },
      "something happened",
    );
  });

  it("creates child loggers with bindings", () => {
    const parent = createLoggerMock();
    const childMock = createLoggerMock();
    parent.child.mockReturnValue(childMock.logger);

    const adapter = createPinoLoggerAdapter({ logger: parent.logger });
    const childAdapter = adapter.child({ requestId: "req-1" });

    childAdapter.info("child message");

    expect(parent.child).toHaveBeenCalledWith({ requestId: "req-1" });
    expect(childMock.info).toHaveBeenCalledWith({}, "child message");
  });

  it("logs duration and returns result when withTime succeeds", async () => {
    const { logger, info, error } = createLoggerMock();
    const times = [100, 175];
    const adapter = createPinoLoggerAdapter({
      logger,
      timeProvider: () => times.shift() ?? 0,
    });

    const result = await adapter.withTime("load", async () => "ok");

    expect(result).toBe("ok");
    expect(info).toHaveBeenCalledWith(
      { op: "load", durationMs: 75 },
      "load completed",
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("logs failures with duration and rethrows", async () => {
    const { logger, info, error } = createLoggerMock();
    const times = [10, 70];
    const adapter = createPinoLoggerAdapter({
      logger,
      timeProvider: () => times.shift() ?? 0,
    });

    const boom = new Error("boom");

    await expect(
      adapter.withTime("sync", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "sync", durationMs: 60, err: boom }),
      "sync failed",
    );
  });
});
