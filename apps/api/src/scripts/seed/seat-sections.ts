import type { PrismaClient } from "@prisma/client";
import { buildEventFixtures } from "./fixtures.js";

/**
 * After events with venue place-layouts are seeded, this helper materialises
 * `SeatSection` and `Seat` rows for each event that owns a place layout, then
 * links the corresponding `TicketType` records via `seatSectionId`.
 *
 * The function is idempotent: existing sections/seats are skipped on re-run.
 */

type SeedResult = {
  eventId: string;
  eventSlug: string;
  sectionsCreated: number;
  seatsCreated: number;
  ticketTypesLinked: number;
};

/**
 * Create SeatSection + Seat rows for every event that has a `placeLayoutId`.
 *
 * Logic:
 * 1. Find all events that have a non-null `placeLayoutId`.
 * 2. For each event, read the PlaceLayout.metadata to get section definitions.
 * 3. Create a `SeatSection` record per section (keyed by `[eventId, name]`).
 * 4. Create `Seat` records for each section matching the layout's seat grid.
 * 5. Link each `TicketType` that name-matches a section label to that section's id.
 */
export async function ensureEventSeatSections(
  prisma: PrismaClient,
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];

  // 1. Find all events with a place layout
  const events = await prisma.event.findMany({
    where: { placeLayoutId: { not: null } },
    select: {
      id: true,
      slug: true,
      placeLayoutId: true,
    },
  });

  for (const event of events) {
    if (!event.placeLayoutId) continue;

    // 2. Read the PlaceLayout metadata
    const layout = await prisma.placeLayout.findUnique({
      where: { id: event.placeLayoutId },
      select: { metadata: true },
    });

    if (!layout?.metadata) continue;

    const metadata = layout.metadata as {
      sections?: Array<{
        sectionId: string;
        label: string;
        capacity: number;
        color?: string;
      }>;
      seatIds?: string[];
    };

    if (!metadata.sections?.length) continue;

    // 3. Fetch existing ticket types for this event
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id, status: "ACTIVE" },
      select: { id: true, name: true, seatSectionId: true },
    });

    // Load seed fixtures so we can prefer structural linkage via
    // fixture.layoutSectionId -> ticket name mapping instead of brittle
    // label-based fuzzy matching. buildEventFixtures() is deterministic
    // for the same seed run and used earlier when creating events.
    const fixtures = buildEventFixtures();
    const fixture = fixtures.find((f) => f.slug === event.slug);

    let sectionsCreated = 0;
    let totalSeatsCreated = 0;
    let ticketTypesLinked = 0;

    for (const sectionDef of metadata.sections) {
      // Determine section type based on label convention
      const sectionType = determineSectionType(sectionDef.label);

      // 3a. Upsert the SeatSection
      const seatSection = await prisma.seatSection.upsert({
        where: {
          eventId_name: {
            eventId: event.id,
            name: sectionDef.label,
          },
        },
        update: {
          type: sectionType,
          capacity: sectionDef.capacity,
          layoutSectionId: sectionDef.sectionId,
          placeLayoutId: event.placeLayoutId,
        },
        create: {
          eventId: event.id,
          name: sectionDef.label,
          type: sectionType,
          capacity: sectionDef.capacity,
          layoutSectionId: sectionDef.sectionId,
          placeLayoutId: event.placeLayoutId,
        },
      });
      sectionsCreated++;

      // 3b. Create Seat records for this section.
      // Parse seat IDs from the layout metadata that belong to this section.
      const sectionSeatIds = (metadata.seatIds ?? []).filter((sid) =>
        sid.startsWith(`${sectionDef.sectionId}-`),
      );

      for (const seatId of sectionSeatIds) {
        // Parse seatId format: "<sectionId>-<row>-<number>"
        // sectionId may itself contain parts, so we extract based on known prefix
        const afterPrefix = seatId.slice(sectionDef.sectionId.length + 1); // e.g. "A-1"
        const dashIdx = afterPrefix.lastIndexOf("-");
        const row = dashIdx >= 0 ? afterPrefix.slice(0, dashIdx) : null;
        const seatNumber =
          dashIdx >= 0 ? parseInt(afterPrefix.slice(dashIdx + 1), 10) : null;

        const label =
          row && seatNumber != null ? `${row}${seatNumber}` : seatId;

        try {
          await prisma.seat.upsert({
            where: {
              seatSectionId_label: {
                seatSectionId: seatSection.id,
                label,
              },
            },
            update: {
              row,
              number: seatNumber,
              status: "AVAILABLE",
            },
            create: {
              seatSectionId: seatSection.id,
              label,
              row,
              number: seatNumber,
              status: "AVAILABLE",
            },
          });
          totalSeatsCreated++;
        } catch {
          // Unique constraint violation on re-run — skip silently
        }
      }

      // 3c. Link ticket types to this seat section. Prefer a structural
      // mapping supplied in the seed fixtures (fixture.tickets[].layoutSectionId).
      // This avoids brittle label/name matching. If no fixture or mapping
      // exists for the event/section, fall back to the previous name-matching
      // heuristic for backwards compatibility.
      let linked = false;
      if (fixture?.tickets?.length) {
        const matchingFixtureTicket = fixture.tickets.find(
          (tt) => tt.layoutSectionId === sectionDef.sectionId,
        );
        if (matchingFixtureTicket) {
          const matchingTicketType = ticketTypes.find(
            (tt) => tt.name === matchingFixtureTicket.name,
          );
          if (matchingTicketType && !matchingTicketType.seatSectionId) {
            await prisma.ticketType.update({
              where: { id: matchingTicketType.id },
              data: { seatSectionId: seatSection.id },
            });
            ticketTypesLinked++;
            linked = true;
          }
        }
      }

      if (!linked) {
        // Fallback: original name-based heuristic (exact/containment)
        const matchingTicketType = findMatchingTicketType(
          ticketTypes,
          sectionDef.label,
        );
        if (matchingTicketType && !matchingTicketType.seatSectionId) {
          await prisma.ticketType.update({
            where: { id: matchingTicketType.id },
            data: { seatSectionId: seatSection.id },
          });
          ticketTypesLinked++;
        }
      }
    }

    results.push({
      eventId: event.id,
      eventSlug: event.slug ?? event.id.slice(-8),
      sectionsCreated,
      seatsCreated: totalSeatsCreated,
      ticketTypesLinked,
    });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Decide between GA and RESERVED based on section label. */
function determineSectionType(label: string): "GA" | "RESERVED" {
  const lower = label.toLowerCase();
  if (lower.includes("general admission") || lower === "ga") return "GA";
  return "RESERVED";
}

/**
 * Find a ticket type whose name matches a section label.
 *
 * Matching strategy (in priority order):
 * 1. Exact case-insensitive match
 * 2. One contains the other (e.g. "VIP" matches "VIP Pit")
 */
function findMatchingTicketType(
  ticketTypes: Array<{
    id: string;
    name: string;
    seatSectionId: string | null;
  }>,
  sectionLabel: string,
): { id: string; name: string; seatSectionId: string | null } | undefined {
  const labelLower = sectionLabel.toLowerCase();

  // Exact match first
  const exact = ticketTypes.find((tt) => tt.name.toLowerCase() === labelLower);
  if (exact) return exact;

  // Containment match: section label contains ticket name, or vice versa
  const containment = ticketTypes.find((tt) => {
    const nameLower = tt.name.toLowerCase();
    return labelLower.includes(nameLower) || nameLower.includes(labelLower);
  });
  return containment;
}
