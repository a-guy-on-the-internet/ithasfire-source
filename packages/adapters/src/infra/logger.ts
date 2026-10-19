import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";

import type { LogLevel, LoggerPort } from "@th/ports/logger";

type TimeProvider = () => number;

const defaultTimeProvider: TimeProvider = () => {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
};

class PinoLoggerAdapter implements LoggerPort {
  constructor(
    private readonly logger: PinoLogger,
    private readonly getTime: TimeProvider,
  ) {}

  child(bindings: Record<string, unknown>): LoggerPort {
    return new PinoLoggerAdapter(
      this.logger.child(bindings ?? {}),
      this.getTime,
    );
  }

  async withTime<T>(name: string, f: () => Promise<T>): Promise<T> {
    const startedAt = this.getTime();
    try {
      const result = await f();
      const durationMs = this.getTime() - startedAt;
      this.logger.info({ op: name, durationMs }, `${name} completed`);
      return result;
    } catch (err) {
      const durationMs = this.getTime() - startedAt;
      this.logger.error({ op: name, durationMs, err }, `${name} failed`);
      throw err;
    }
  }

  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    this.emit(level, msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit("info", msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.emit("warn", msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit("error", msg, extra);
  }

  private emit(
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    const hasExtra = extra && Object.keys(extra).length > 0;
    const logger = this.logger as unknown as Record<
      LogLevel,
      (obj: Record<string, unknown>, msg?: string) => void
    > & { info: (obj: Record<string, unknown>, msg?: string) => void };
    const method = logger[level] ?? logger.info;
    if (hasExtra && extra) {
      method.call(this.logger, extra, msg);
    } else {
      method.call(this.logger, {}, msg);
    }
  }
}

export type CreatePinoLoggerAdapterOptions = {
  logger?: PinoLogger;
  options?: LoggerOptions;
  timeProvider?: TimeProvider;
};

export function createPinoLoggerAdapter(
  options: CreatePinoLoggerAdapterOptions = {},
): LoggerPort {
  const baseLogger = options.logger ?? pino(options.options ?? {});
  const timeProvider = options.timeProvider ?? defaultTimeProvider;
  return new PinoLoggerAdapter(baseLogger, timeProvider);
}
