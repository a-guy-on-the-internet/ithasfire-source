import { z } from "zod";
import { createHash } from "node:crypto";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { composeAssembledWaiverBody } from "./assembled-body";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

// ── Jurisdiction tiers ──────────────────────────────────────────────────────

type JurisdictionTier =
  | "VOID"
  | "RESTRICTED"
  | "MANDATORY_INSERT"
  | "SPECIAL"
  | "STANDARD";

const VOID_STATES = ["LA", "VA"];
const RESTRICTED_RECREATION = ["NY", "CT", "VT", "OR"];
const MANDATORY_INSERT = ["MT"];
const SPECIAL_RULES = ["WI", "HI", "WA", "WV"];

function getJurisdictionTier(stateCode: string | null): JurisdictionTier {
  if (!stateCode) return "STANDARD";
  const upper = stateCode.toUpperCase();
  if (VOID_STATES.includes(upper)) return "VOID";
  if (RESTRICTED_RECREATION.includes(upper)) return "RESTRICTED";
  if (MANDATORY_INSERT.includes(upper)) return "MANDATORY_INSERT";
  if (SPECIAL_RULES.includes(upper)) return "SPECIAL";
  return "STANDARD";
}
// ── Input / output schemas ──────────────────────────────────────────────────

export const assembleWaiverInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  /** Clause slugs the organizer explicitly selected (risk-specific only). */
  selectedClauseSlugs: z.array(z.string()).default([]),
  /** Optional custom clause text (max 500 chars). */
  customClause: z.string().max(500).optional().nullable(),
});

export const assembleWaiverOutputSchema = z.object({
  waiverTemplateId: z.uuid(),
  version: z.number().int(),
  bodyHash: z.string(),
  /** Number of clauses included. */
  clauseCount: z.number().int(),
  jurisdictionTier: z.string(),
  /** Warning message if jurisdiction restricts waivers. */
  jurisdictionWarning: z.string().nullable(),
});

export type AssembleWaiverInput = z.infer<typeof assembleWaiverInputSchema>;
export type AssembleWaiverOutput = z.infer<typeof assembleWaiverOutputSchema>;

export type AssembleWaiverDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ── Main use case ───────────────────────────────────────────────────────────

export async function assembleWaiver(
  deps: AssembleWaiverDeps,
  rawInput: unknown,
): Promise<AssembleWaiverOutput> {
  const input = parseInput(assembleWaiverInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    // 1. Load event
    const event = await tx.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    // 2. RBAC
    if (event.orgId) {
      await requireOrgMembership({
        repos: tx,
        orgId: event.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });
    } else {
      await ensureActorHoldsHumanEventRole(
        tx.authz,
        event.humanId,
        input.actorHumanId,
      );
    }

    // 3. Detect jurisdiction from event location
    const stateCode = (event.region ?? event.regionCode)?.toUpperCase() ?? null;
    const tier = getJurisdictionTier(stateCode);

    // 4. Load all active clauses
    const allClauses = await tx.waiverClauses.listActive();

    // 5. Separate structural vs risk-specific
    const structuralClauses = allClauses
      .filter((clause) => clause.layer === "STRUCTURAL")
      .filter((clause) => {
        // Strip clauses void in this state
        if (stateCode && clause.voidInStates.includes(stateCode)) return false;
        return true;
      });

    // For VOID jurisdictions, strip the core-release clause
    const assembledStructural =
      tier === "VOID"
        ? structuralClauses.filter((clause) => clause.slug !== "core-release")
        : structuralClauses;

    // 6. Risk-specific: start with organizer selections, add auto-selected
    const selectedSlugs = new Set(input.selectedClauseSlugs);

    // Auto-select rules: check event properties
    const riskClauses = allClauses.filter(
      (clause) => clause.layer === "RISK_SPECIFIC",
    );
    for (const clause of riskClauses) {
      // Add required-in-state clauses
      if (stateCode && clause.requiredInStates.includes(stateCode)) {
        selectedSlugs.add(clause.slug);
      }
    }

    const assembledRisk = riskClauses
      .filter((clause) => selectedSlugs.has(clause.slug))
      .filter((clause) => {
        if (stateCode && clause.voidInStates.includes(stateCode)) return false;
        return true;
      });

    // 7. Compose clause sections (sorted by sortOrder) + manifest via the
    //    shared pure helper — same formatting as the platform seed.
    const { body: clausesBody, assembledFromClauses } =
      composeAssembledWaiverBody([...assembledStructural, ...assembledRisk]);
    const clauseCount = assembledFromClauses.length;

    // 8. Build body text
    const bodyParts: string[] = [];

    // VOID jurisdiction: add acknowledgment header
    if (tier === "VOID") {
      bodyParts.push(
        `ACKNOWLEDGMENT OF RISK\n\nThis document serves as an acknowledgment of risk. Under the laws of ${stateCode === "LA" ? "Louisiana" : "Virginia"}, liability waivers for personal injury are not enforceable. This document does not constitute a waiver of your legal rights.\n`,
      );
    }

    // RESTRICTED jurisdiction: add warning
    if (tier === "RESTRICTED") {
      bodyParts.push(
        `NOTICE: ${stateCode} law restricts the enforceability of liability waivers for paid recreational events. The release of liability provisions in this document may not be enforceable under applicable state law.\n`,
      );
    }

    // Assembled clauses
    if (clausesBody) {
      bodyParts.push(clausesBody);
    }

    // Custom clause
    if (input.customClause?.trim()) {
      bodyParts.push(`ADDITIONAL TERMS. ${input.customClause.trim()}`);
    }

    const body = bodyParts.join("\n\n");
    const bodyHash = createHash("sha256").update(body).digest("hex");

    // 9. Upsert WaiverTemplate
    const templateName =
      tier === "VOID"
        ? "Event Risk Acknowledgment (Assembled)"
        : "Event Liability Waiver (Assembled)";

    // Check for existing assembled template on this event
    const existingTemplate = event.waiverTemplateId
      ? await tx.waiverTemplates.getById(event.waiverTemplateId)
      : null;

    let templateId: string;
    let templateVersion: number;
    if (existingTemplate && existingTemplate.source === "ASSEMBLED") {
      // Update existing assembled template
      const updatedTemplate = await tx.waiverTemplates.update({
        id: existingTemplate.id,
        body,
        name: templateName,
        source: "ASSEMBLED",
        assembledFromClauses,
        jurisdictionState: stateCode,
      });
      templateId = updatedTemplate.id;
      templateVersion = updatedTemplate.version;
    } else {
      // Create new assembled template
      const created = await tx.waiverTemplates.create({
        orgId: event.orgId ?? null,
        humanId: event.humanId ?? null,
        name: templateName,
        body,
        isDefault: false,
        source: "ASSEMBLED",
        assembledFromClauses,
        jurisdictionState: stateCode,
      });
      templateId = created.id;
      templateVersion = created.version;

      // Link to event
      await tx.events.setWaiverTemplate({
        eventId: event.id,
        waiverTemplateId: templateId,
      });
    }

    // 10. Audit
    await tx.audit.log({
      entity: "waiver_template",
      entityId: templateId,
      action: "assembled",
      data: {
        eventId: event.id,
        actorHumanId: input.actorHumanId,
        clauseCount,
        jurisdictionTier: tier,
        jurisdictionState: stateCode,
        selectedSlugs: [...selectedSlugs],
        hasCustomClause: !!input.customClause?.trim(),
      },
      at: new Date(),
    });

    // Jurisdiction warning
    let jurisdictionWarning: string | null = null;
    if (tier === "VOID") {
      jurisdictionWarning = `Liability waivers for personal injury are categorically unenforceable in ${stateCode === "LA" ? "Louisiana" : "Virginia"}. This document will serve as an acknowledgment of risk only. We strongly recommend purchasing event liability insurance.`;
    } else if (tier === "RESTRICTED") {
      jurisdictionWarning = `${stateCode} law restricts waiver enforceability for paid recreational events. Your waiver may not be enforceable. Consult a ${stateCode} attorney.`;
    }

    return assembleWaiverOutputSchema.parse({
      waiverTemplateId: templateId,
      version: templateVersion,
      bodyHash,
      clauseCount,
      jurisdictionTier: tier,
      jurisdictionWarning,
    });
  });
}
