import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  redactDraftFreeformLocation,
  roleSeesDraftFreeformAddress,
} from "../../lib/location/redact-draft-location";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  listOccurrencesInputSchema,
  listOccurrencesResultSchema,
  type ListOccurrencesInput,
  type ListOccurrencesResult,
} from "./schemas";
import { mapOccurrenceRecordToDto } from "./utils";
import { fail } from "@th/errors";

export type ListSeriesOccurrencesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listSeriesOccurrences(
  deps: ListSeriesOccurrencesDeps,
  rawInput: unknown,
): Promise<ListOccurrencesResult> {
  const input = parseInput(listOccurrencesInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({ useCase: "listSeriesOccurrences" });

  return deps.repos.tx(async (tx) => {
    const series = await tx.series.getById(input.seriesId);
    if (!series) {
      throw fail("SERIES_NOT_FOUND");
    }

    const access = await ensureSeriesOwnerAccess(
      tx,
      series.ownerScope,
      series.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );
    // N4: below the edit roles a freeform override location is its coarse
    // label only (`lib/location/redact-draft-location`).
    const seesFreeformAddress =
      access.kind === "human" || roleSeesDraftFreeformAddress(access.role);

    const limit = input.limit ?? 50;
    const range = input.range
      ? {
          start: new Date(input.range.start),
          end: new Date(input.range.end),
        }
      : undefined;

    const result = await tx.seriesOccurrences.listBySeries({
      seriesId: input.seriesId,
      range,
      status: input.status,
      limit,
      cursor: input.cursor ?? null,
    });

    const items = result.items.map(mapOccurrenceRecordToDto).map((dto) =>
      seesFreeformAddress || !dto.overrides?.location
        ? dto
        : {
            ...dto,
            overrides: {
              ...dto.overrides,
              location: redactDraftFreeformLocation(dto.overrides.location),
            },
          },
    );
    return listOccurrencesResultSchema.parse({
      items,
      nextCursor: result.nextCursor ?? undefined,
    });
  });
}
