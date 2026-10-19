import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ConsentRecordRow } from "@th/ports/repos/consent";

import { parseInput } from "../../lib/io";
import {
  listConsentByAnonymousIdInputSchema,
  listConsentByHumanIdInputSchema,
} from "./schemas";

export type ListConsentDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export type ListConsentOutput = {
  records: ConsentRecordRow[];
};

/** Lookup all consent records tied to a Human (DSAR fulfillment). */
export async function listConsentByHumanId(
  deps: ListConsentDeps,
  rawInput: unknown,
): Promise<ListConsentOutput> {
  const input = parseInput(listConsentByHumanIdInputSchema, rawInput);
  const records = await deps.repos.consent.listByHumanId(input.humanId);
  return { records };
}

/** Lookup all consent records tied to an anonymous (pre-signup) device id. */
export async function listConsentByAnonymousId(
  deps: ListConsentDeps,
  rawInput: unknown,
): Promise<ListConsentOutput> {
  const input = parseInput(listConsentByAnonymousIdInputSchema, rawInput);
  const records = await deps.repos.consent.listByAnonymousId(input.anonymousId);
  return { records };
}
