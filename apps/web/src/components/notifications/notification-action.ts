/**
 * In-app notification action → clickable href.
 *
 * The stored action (`NotificationAction`) carries EITHER an absolute `href`
 * (renderers handed a fully-built URL) or a relative in-app `route` (renderers
 * that only know the path). `NotificationItem` gates its CTA button on `href`
 * alone, so every route-only action rendered inert — the button never appeared.
 * This promotes `route` to `href` so those actions work.
 *
 * The href lands in two places: the CTA's `<a href>` (so focus, Enter,
 * middle-click and open-in-new-tab are the browser's) and `router.push(href)`
 * from the container, which a plain click or Enter is routed through. A
 * relative path is the right shape for both.
 */

import type { NotificationItemData } from "@th/ui";

import { safeHref } from "@/lib/escape-html";

/**
 * `/events/<uuid>` — a route shape that CANNOT resolve, dropped permanently.
 *
 * THIS IS NOT A WORKAROUND FOR A BUG THAT WILL BE FIXED. The emitters were all
 * fixed to build slug-based links, but `Notification.actionRoute` is a PERSISTED
 * column: every row already written with `/events/<uuid>` is still in the
 * database and still renders in someone's inbox. Fixing the producers does
 * nothing for those rows, and a backfill isn't worth it (the id → slug mapping
 * for a deleted event is gone anyway). So this stays as a permanent read-side
 * guard, and it doubles as defence-in-depth for any future emitter that builds
 * an action outside the renderer registry.
 *
 * Why the route can't resolve: the public event page is `/events/[...slug]` and
 * resolves through `events.resolveBySlug`, which matches the current slug or
 * slug history only — there is no id branch. (On a seeded dev database some ids
 * 307-redirect, but only because the seed left the uuid in `EventSlugHistory`;
 * `publish-event` records the generated slug, so a real event's id is never
 * there.)
 *
 * Dropping the href hides the button and leaves the notification text intact,
 * which is exactly the behaviour those rows had before route promotion existed.
 */
const DEAD_EVENT_ID_ROUTE =
  /^(?:https?:\/\/[^/]+)?\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i;

export type StoredNotificationAction = {
  label: string;
  href?: string | null;
  route?: string | null;
};

/**
 * The href a notification's CTA navigates to, or null when there is no target
 * or the stored target is a known-dead event-id route.
 */
export function resolveNotificationActionHref(
  action: StoredNotificationAction,
): string | null {
  const target = action.href ?? action.route ?? null;
  if (!target) return null;
  if (DEAD_EVENT_ID_ROUTE.test(target)) return null;
  // The value now lands verbatim in an `<a href>` (`NotificationItem`), not
  // just `router.push`. `safeHref` is the one place that already owns the
  // scheme allowlist (http/https/mailto/tel, same-origin relative) — route
  // through it rather than growing a second copy of that decision here. A
  // rejected scheme (e.g. `javascript:`) falls back to `"#"`; treat that the
  // same as "no target" so the CTA doesn't render as a dead link.
  const safe = safeHref(target);
  return safe === "#" ? null : safe;
}

/** Maps a stored action onto the shape `NotificationItem` consumes. */
export function toNotificationItemAction(
  action: StoredNotificationAction | null | undefined,
): NotificationItemData["action"] {
  if (!action) return null;
  return { label: action.label, href: resolveNotificationActionHref(action) };
}
