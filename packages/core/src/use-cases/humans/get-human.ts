import { z } from "zod";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { humanStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

export const getHumanInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    targetHumanId: z.uuid(),
  })
  .strict();

export const getHumanOutputSchema = z
  .object({
    human: z.object({
      id: z.uuid(),
      email: z.string().email(),
      name: z.string().nullable(),
      phoneMasked: z.string().nullable(),
      status: humanStatusSchema,
    }),
  })
  .strict();

export type GetHumanInput = z.infer<typeof getHumanInputSchema>;
export type GetHumanOutput = z.infer<typeof getHumanOutputSchema>;

export type GetHumanDeps = {
  repos: Repos;
  /** The staff probe behind reading a human other than oneself. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

/** Staff roles that may read another human's record. */
const STAFF_READ_ROLES = ["ADMIN", "SUPPORT"] as const;

export async function getHuman(
  deps: GetHumanDeps,
  rawInput: unknown,
): Promise<GetHumanOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getHuman" });

  const execute = async () => {
    const input = parseInput(getHumanInputSchema, rawInput);

    // Use getByIdWithIdentity to get human + auth user identity data
    const result = await deps.repos.humans.getByIdWithIdentity(
      input.targetHumanId,
    );
    if (!result) {
      throw fail("HUMAN_NOT_FOUND");
    }

    const { human, identity } = result;

    // Reading oneself needs no role. Anyone else's record is a staff read,
    // asked of the authz port, which counts a staff role only with a second
    // factor enrolled (`SECOND_FACTOR_REQUIRED` otherwise).
    const isSelf = input.actorHumanId === human.id;
    if (!isSelf) {
      await requirePlatformStaff({
        authz: deps.authz,
        actorHumanId: input.actorHumanId,
        roles: STAFF_READ_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });
    }

    const phoneMasked = isSelf ? maskPhone(identity.phone) : null;

    return getHumanOutputSchema.parse({
      human: {
        id: human.id,
        email: identity.email,
        name: human.name,
        phoneMasked,
        status: human.status,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getHuman", execute);
  }

  return execute();
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.length <= 2) return phone;
  const visible = phone.slice(-2);
  const masked = "*".repeat(phone.length - 2) + visible;
  return masked;
}
