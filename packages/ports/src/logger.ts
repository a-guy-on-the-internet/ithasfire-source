export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort;
  withTime<T>(name: string, f: () => Promise<T>): Promise<T>; // times + logs duration
  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}
