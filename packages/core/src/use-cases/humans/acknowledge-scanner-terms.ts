import { z } from "zod";

import { SCANNER_TERMS_VERSION } from "@th/types";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const acknowledgeScannerTermsInputSchema = z.object({
  humanId: z.string().min(1),
  version: z.string().min(1),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export type AcknowledgeScannerTermsInput = z.infer<
  typeof acknowledgeScannerTermsInputSchema
>;

export type AcknowledgeScannerTermsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function acknowledgeScannerTerms(
  deps: AcknowledgeScannerTermsDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(acknowledgeScannerTermsInputSchema, rawInput);

  if (input.version !== SCANNER_TERMS_VERSION) {
    throw fail("SCANNER_TERMS_VERSION_MISMATCH");
  }

  await deps.repos.tx(async (tx) => {
    const acknowledgedAt = deps.clock.now();

    await tx.humans.acknowledgeScannerTerms({
      humanId: input.humanId,
      version: input.version,
      acknowledgedAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await tx.audit.log({
      entity: "human",
      entityId: input.humanId,
      action: "human.scanner_terms_acknowledged",
      data: { version: input.version },
      at: acknowledgedAt,
    });
  });
}
