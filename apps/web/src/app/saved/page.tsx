/**
 * /saved — permanent redirect to /my-tickets.
 *
 * The watchlist folded into the tickets destination on 2026-08-31: `/saved`
 * was unreachable on a phone (no bottom-bar tab, and the navbar sheds its
 * saved-heart below 600px), while Tickets already had a tab. `/my-tickets` now
 * renders both halves under one Upcoming/Past control.
 *
 * This route stays so the things still pointing at it keep working —
 * bookmarks, the navbar heart, the home `SavedStrip`'s "View all", and two
 * help-centre articles. Same idiom as `app/events/page.tsx`.
 *
 * A signed-out request 307s here, then `/my-tickets` (a `PRIVATE_ROUTE_PREFIXES`
 * entry) 307s on to `/sign-in?redirect_url=/my-tickets`.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function SavedEventsRedirect() {
  redirect("/my-tickets");
}
