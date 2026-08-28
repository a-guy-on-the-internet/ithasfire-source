import type { PrismaClient } from "@prisma/client";

/**
 * Validate that venue events have a consistent, complete seating setup.
 *
 * Checks:
 * 1. Every event with a `placeLayoutId` has at least one `SeatSection`.
 * 2. Every layout metadata section has a corresponding `SeatSection` record.
 * 3. Every `SeatSection` has at least one `Seat` record.
 * 4. Every ticket type with a `seatSectionId` points to a valid section.
 * 5. Every section-linked ticket type's section belongs to the same event.
 *
 * Returns a list of issues; an empty list means everything is valid.
 */

export type LayoutValidationIssue = {
  eventId: string;
  eventSlug: string;
  level: "error" | "warning";
  message: string;
};

export async function validatePlaceLayouts(
  prisma: PrismaClient,
): Promise<LayoutValidationIssue[]> {
  const issues: LayoutValidationIssue[] = [];

  // Find all events with a place layout
  const events = await prisma.event.findMany({
    where: { placeLayoutId: { not: null } },
    select: {
      id: true,
      slug: true,
      placeLayoutId: true,
    },
  });

  for (const event of events) {
    const slug = event.slug ?? event.id.slice(-8);

    if (!event.placeLayoutId) continue;

    // Load the layout metadata
    const layout = await prisma.placeLayout.findUnique({
      where: { id: event.placeLayoutId },
      select: { metadata: true },
    });

    if (!layout?.metadata) {
      issues.push({
        eventId: event.id,
        eventSlug: slug,
        level: "error",
        message: `Event references placeLayoutId=${event.placeLayoutId} but layout not found or has no metadata`,
      });
      continue;
    }

    const metadata = layout.metadata as {
      sections?: Array<{ sectionId: string; label: string; capacity: number }>;
      seatIds?: string[];
    };

    // 1. Check that SeatSection records exist
    const dbSections = await prisma.seatSection.findMany({
      where: { eventId: event.id },
      select: { id: true, name: true, capacity: true },
    });

    if (dbSections.length === 0) {
      issues.push({
        eventId: event.id,
        eventSlug: slug,
        level: "error",
        message:
          "Event has a place layout but no SeatSection records in the database",
      });
      continue;
    }

    // 2. Check layout metadata sections vs DB sections
    const metaSections = metadata.sections ?? [];
    for (const ms of metaSections) {
      const dbMatch = dbSections.find((dbs) => dbs.name === ms.label);
      if (!dbMatch) {
        issues.push({
          eventId: event.id,
          eventSlug: slug,
          level: "error",
          message: `Layout metadata section "${ms.label}" (sectionId=${ms.sectionId}) has no corresponding SeatSection record`,
        });
      }
    }

    // Reverse check: DB sections without metadata entries
    for (const dbs of dbSections) {
      const metaMatch = metaSections.find((ms) => ms.label === dbs.name);
      if (!metaMatch) {
        issues.push({
          eventId: event.id,
          eventSlug: slug,
          level: "warning",
          message: `SeatSection "${dbs.name}" exists in DB but not in layout metadata`,
        });
      }
    }

    // 3. Check each section has seats
    for (const dbs of dbSections) {
      const seatCount = await prisma.seat.count({
        where: { seatSectionId: dbs.id },
      });
      if (seatCount === 0) {
        issues.push({
          eventId: event.id,
          eventSlug: slug,
          level: "warning",
          message: `SeatSection "${dbs.name}" has 0 seats`,
        });
      }
    }

    // 4. Check ticket types with seatSectionId
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id, status: "ACTIVE" },
      select: { id: true, name: true, seatSectionId: true },
    });

    const linkedCount = ticketTypes.filter((tt) => tt.seatSectionId).length;
    if (linkedCount === 0) {
      issues.push({
        eventId: event.id,
        eventSlug: slug,
        level: "error",
        message: `No ticket types are linked to seat sections (all seatSectionId=null)`,
      });
    }

    for (const tt of ticketTypes) {
      if (tt.seatSectionId) {
        const section = dbSections.find((s) => s.id === tt.seatSectionId);
        if (!section) {
          issues.push({
            eventId: event.id,
            eventSlug: slug,
            level: "error",
            message: `TicketType "${tt.name}" references seatSectionId=${tt.seatSectionId} but that section does not belong to this event`,
          });
        }
      } else {
        // Ticket type without a section link on a venue event
        issues.push({
          eventId: event.id,
          eventSlug: slug,
          level: "warning",
          message: `TicketType "${tt.name}" has no seatSectionId — it will render as GA in checkout`,
        });
      }
    }
  }

  return issues;
}
