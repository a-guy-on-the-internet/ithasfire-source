import { vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

export function createTestLogger(): LoggerPort {
  const logger: LoggerPort = {
    child: vi.fn(() => createTestLogger()),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}
