import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";

export type DependencyContext = { action: string } & Record<string, unknown>;

export function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  rawInput: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    throw {
      code: "invalid_input",
      message: "invalid_input",
      issues: parsed.error.issues,
    } as const;
  }
  return parsed.data;
}

export async function callOrDependencyFailed<T>(
  fn: () => Promise<T>,
  logger: LoggerPort | undefined,
  context: DependencyContext,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger?.error("dependency_failed", {
      ...context,
      error: describeError(error),
    });
    throw { code: "dependency_failed", message: context.action } as const;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown_error";
  }
}
