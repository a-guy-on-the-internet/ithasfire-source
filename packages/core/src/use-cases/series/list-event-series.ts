import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  redactDraftFreeformLocation,
  roleSeesDraftFreeformAddress,
} from "../../lib/location/redact-draft-location";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  listSeriesInputSchema,
  listSeriesResultSchema,
  type ListSeriesInput,
  type ListSeriesResult,
} from "./schemas";
import { mapSeriesRecordToDto } from "./utils";

export type ListEventSeriesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEventSeries(
  deps: ListEventSeriesDeps,
  rawInput: unknown,
): Promise<ListSeriesResult> {
  const input = parseInput(listSeriesInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({ useCase: "listEventSeries" });

  return deps.repos.tx(async (tx) => {
    const access = await ensureSeriesOwnerAccess(
      tx,
      input.ownerScope,
      input.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );
    // N4: below the edit roles a freeform default location is its coarse
    // label only (`lib/location/redact-draft-location`).
    const seesFreeformAddress =
      access.kind === "human" || roleSeesDraftFreeformAddress(access.role);

    const limit = input.limit ?? 20;
    const result = await tx.series.listByOwner({
      ownerScope: input.ownerScope,
      ownerId: input.ownerId,
      activeOnly: input.activeOnly,
      q: input.q,
      limit,
      cursor: input.cursor ?? null,
    });

    const items = result.items.map(mapSeriesRecordToDto).map((dto) =>
      seesFreeformAddress || !dto.defaults?.location
        ? dto
        : {
            ...dto,
            defaults: {
              ...dto.defaults,
              location: redactDraftFreeformLocation(dto.defaults.location),
            },
          },
    );
    return listSeriesResultSchema.parse({
      items,
      nextCursor: result.nextCursor ?? undefined,
    });
  });
}
