import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MaterializeSectionsResult } from "@th/ports/repos/seats";
import type { SeatSection as LayoutSeatSection } from "@th/ports/place-layouts";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const materializeEventSeatSectionsInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const materializeEventSeatSectionsOutputSchema = z.object({
  eventId: z.string(),
  placeLayoutId: z.string().nullable(),
  sectionsCreated: z.number().int(),
  seatsCreated: z.number().int(),
  sectionIdMap: z.record(z.string(), z.string()),
});

export type MaterializeEventSeatSectionsInput = z.infer<
  typeof materializeEventSeatSectionsInputSchema
>;
export type MaterializeEventSeatSectionsOutput = z.infer<
  typeof materializeEventSeatSectionsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type MaterializeEventSeatSectionsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materialise `SeatSection` + `Seat` rows for an event based on its
 * PlaceLayout metadata.
 *
 * Idempotent: uses the composite unique constraint
 * `(eventId, placeLayoutId, layoutSectionId)` so repeated calls upsert
 * rather than duplicate.
 *
 * Returns a no-op result when the event has no `placeLayoutId` or the
 * layout contains no sections.
 */
export async function materializeEventSeatSections(
  deps: MaterializeEventSeatSectionsDeps,
  rawInput: unknown,
): Promise<MaterializeEventSeatSectionsOutput> {
  const input = parseInput(materializeEventSeatSectionsInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "materializeEventSeatSections",
  });

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (!event.placeLayoutId) {
    logger?.log(
      "debug",
      "event has no placeLayoutId, skipping materialisation",
    );
    return {
      eventId: event.id,
      placeLayoutId: null,
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    };
  }

  const layout = await deps.repos.placeLayouts.getById(event.placeLayoutId);
  if (!layout || !layout.sections.length) {
    logger?.log(
      "debug",
      "layout not found or has no sections, skipping materialisation",
    );
    return {
      eventId: event.id,
      placeLayoutId: event.placeLayoutId,
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    };
  }

  const sectionDefs = layout.sections
    .filter((s) => (s.kind as string) !== "helper")
    .map(toLayoutSectionDef);

  const result: MaterializeSectionsResult = await deps.repos.tx(async (tx) => {
    return tx.seats.materializeSections({
      eventId: event.id,
      placeLayoutId: layout.id,
      sections: sectionDefs,
      seatIds: layout.seatIds,
    });
  });

  logger?.info("materialised seat sections for event", {
    eventId: event.id,
    placeLayoutId: layout.id,
    sectionsCreated: result.sectionsCreated,
    seatsCreated: result.seatsCreated,
  });

  return {
    eventId: event.id,
    placeLayoutId: layout.id,
    sectionsCreated: result.sectionsCreated,
    seatsCreated: result.seatsCreated,
    sectionIdMap: result.sectionIdMap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toLayoutSectionDef(section: LayoutSeatSection) {
  return {
    sectionId: section.sectionId,
    label: section.label,
    capacity: section.capacity,
    kind: section.kind ?? "seat",
    color: section.color ?? null,
    geometry: section.geometry ?? null,
    stageAnchor: section.stageAnchor ?? null,
  };
}
