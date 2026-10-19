import type { Repos } from "@th/ports/repos";
import type { EventRecord, EventStatus } from "@th/ports/repos/events";

import { fail } from "@th/errors";

import { ensureEventOpenToPublic } from "../events/_shared/event-open-to-public";

/**
 * An event can be saved iff the actor could open its detail page. This is the
 * SAME gate as `get-public-event-body`: the event must exist and be
 * PUBLISHED. Visibility PRIVATE is deliberately NOT a blocker — on the detail
 * path PRIVATE means "unlisted / reachable by link", and content gating
 * (password/application) protects sections, not the page's existence. Saving
 * carries no more information than the page the user is already looking at.
 */
export async function getSaveableEventOrThrow(
  repos: Pick<Repos, "events">,
  eventId: string,
): Promise<EventRecord> {
  // A banned owner's event cannot be saved (ban-that-sticks): it answers
  // exactly like an unpublished one.
  const event = await ensureEventOpenToPublic(repos, eventId, {
    code: "EVENT_NOT_PUBLISHED",
    opts: { category: "NOT_FOUND" },
  });

  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_PUBLISHED", { category: "NOT_FOUND" });
  }

  return event;
}

/**
 * Read-time visibility filter for the /saved list (FR-004): keep PUBLISHED
 * events, CANCELLED events (seeing the cancellation is watchlist value — the
 * UI badges it), and COMPLETED events (the Past tab's whole value is past
 * events; a completed event's existence is not sensitive). Keeping COMPLETED
 * deliberately diverges from `get-public-event-body` (which 404s COMPLETED) —
 * a list summary isn't a detail page. Drop everything else (drafts, archived
 * — no-longer-visible events must not leak as stubs). Visibility PRIVATE
 * stays visible to the saver, matching the detail-page semantics above.
 */
export function isVisibleInSavedList(status: EventStatus): boolean {
  return (
    status === "PUBLISHED" || status === "CANCELLED" || status === "COMPLETED"
  );
}
