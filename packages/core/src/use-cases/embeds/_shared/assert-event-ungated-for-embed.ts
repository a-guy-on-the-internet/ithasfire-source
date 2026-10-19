import { z } from "zod";

import { fail } from "@th/errors";

import { eventIsGated } from "../../../lib/location/project-public-event-location";

/** The gate as embed outputs carry it — `EventGateType`'s three values. */
export const embedGateTypeSchema = z.enum(["NONE", "PASSWORD", "APPLICATION"]);
export type EmbedGateType = z.infer<typeof embedGateTypeSchema>;

/**
 * The gate an embed output reports. Fails closed like
 * {@link isEventUngatedForEmbed}: a missing or unknown value reports
 * `"PASSWORD"`, the plain "locked" badge, never `"NONE"`. It cannot occur
 * through the Prisma adapter (the column is NOT NULL and always selected).
 */
export function embedGateTypeOf(event: {
  gateType?: string | null;
}): EmbedGateType {
  const parsed = embedGateTypeSchema.safeParse(event.gateType);
  return parsed.success ? parsed.data : "PASSWORD";
}

/**
 * True when an embed may show this event's full page or sell it: only an
 * ungated (`gateType === "NONE"`) event.
 *
 * An embed can NEVER unlock a gated event (owner ruling 2026-10-12). It is a
 * cross-site iframe with no grant cookies and no signed-in session, so the
 * only standing it has is "anonymous". A PASSWORD or APPLICATION event shows
 * as a card (title, date, image) with a link to the event on Ithas Fire;
 * nobody buys it through the widget.
 *
 * FAILS CLOSED on a missing gate. `EventRecord.gateType` is typed required and
 * the Prisma adapter always selects it, but a projection that forgot the
 * column (or a stale fixture) must not open the event: only the literal
 * `"NONE"` is ungated. The rule itself lives in ONE place, `eventIsGated`
 * (N5 in `projectPublicEventLocation`); this only names it for embeds.
 */
export function isEventUngatedForEmbed(event: {
  /** `EventGateType`; typed loosely so projections typed `string` fit. */
  gateType?: string | null;
}): boolean {
  return !eventIsGated({ gateType: event.gateType });
}

/**
 * Throws `EVENT_GATED` unless the event is ungated — see
 * {@link isEventUngatedForEmbed}. Call it after the event is loaded and
 * authorized for the embed (`assertEventAllowedForEmbed`), so a foreign or
 * unpublished event still answers EVENT_NOT_FOUND and the gate code never
 * confirms that an event the embed cannot see exists.
 */
export function assertEventUngatedForEmbed(event: {
  /** `EventGateType`; typed loosely so projections typed `string` fit. */
  gateType?: string | null;
}): void {
  if (!isEventUngatedForEmbed(event)) {
    throw fail("EVENT_GATED");
  }
}
