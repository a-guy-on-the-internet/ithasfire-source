import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import {
  redactDraftFreeformLocation,
  roleSeesDraftFreeformAddress,
} from "../../lib/location/redact-draft-location";
import {
  listEventTemplatesInputSchema,
  listEventTemplatesResultSchema,
  type ListEventTemplatesInput,
  type ListEventTemplatesResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "./permissions";

export type ListEventTemplatesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEventTemplates(
  deps: ListEventTemplatesDeps,
  rawInput: unknown,
): Promise<ListEventTemplatesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "listEventTemplates" });

  const input = parseInput(listEventTemplatesInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    const access = await ensureTemplateOwnerAccess(
      tx,
      input.ownerScope,
      input.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );

    const listing = await tx.eventTemplates.list({
      ownerScope: input.ownerScope,
      ownerId: input.ownerId,
      activeOnly: input.activeOnly,
      q: input.q,
      limit: input.limit ?? 20,
      cursor: input.cursor ?? null,
    });

    // N4: a VIEWER / FINANCE reader (view access, below the edit roles) gets
    // a freeform default location as its coarse label only — no street, no
    // coordinates. The owner of a HUMAN-scoped template is always its editor.
    const seesFreeformAddress =
      access.kind === "human" || roleSeesDraftFreeformAddress(access.role);
    const items = seesFreeformAddress
      ? listing.items
      : listing.items.map((item) =>
          item.defaults?.location
            ? {
                ...item,
                defaults: {
                  ...item.defaults,
                  location: redactDraftFreeformLocation(item.defaults.location),
                },
              }
            : item,
        );

    return listEventTemplatesResultSchema.parse({ ...listing, items });
  });

  return result;
}
