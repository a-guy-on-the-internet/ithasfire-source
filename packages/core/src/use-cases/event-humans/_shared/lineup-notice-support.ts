import type { Repos } from "@th/ports/repos";
import type { EventHumanRole } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";
import type { ReporterPort } from "@th/ports/reporter";

import { clipUtf16 } from "../../../lib/clip-utf16";
import { listOrgEditMembers } from "../../booking-holds/notify-booking-hold-intents";

// Shared helpers for the lineup notices (owner ruling "option A",
// 2026-09-30): the added / payout-invite notices to the person, and the
// left notice to the event's editors.

export type LineupSupportRepos = Pick<
  Repos,
  "humans" | "organizations" | "entityPages"
>;

/** Trim trailing slashes so URL joins never emit `//my-lineups`. */
export function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * A name fit for copy, or null. A value that looks like an email address is
 * dropped: shadow profiles have carried the address in `name`, and an email
 * must never be what a notice shows as someone's name. Clipped to the
 * renderer schemas' 200-character bound.
 */
export function displayNameForCopy(
  name: string | null | undefined,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.includes("@")) return null;
  // UTF-16 units (zod counts those), never splitting a surrogate pair.
  return clipUtf16(trimmed, 200);
}

const ROLE_LABELS: Record<EventHumanRole, string> = {
  PERFORMER: "Performer",
  HOST: "Host",
  DJ: "DJ",
  INSTRUCTOR: "Instructor",
  SPEAKER: "Speaker",
  VENDOR: "Vendor",
  VOLUNTEER: "Volunteer",
  OTHER: "Other",
};

/** "Performer", "DJ", … or the custom label an editor typed for OTHER. */
export function lineupRoleLabel(
  role: EventHumanRole,
  customRoleLabel: string | null | undefined,
): string {
  if (role === "OTHER") {
    const custom = customRoleLabel?.trim();
    if (custom) return custom.length > 120 ? custom.slice(0, 120) : custom;
  }
  return ROLE_LABELS[role] ?? "Other";
}

/**
 * The event's organiser as copy: the owning org's name, else the owning
 * human's name. Null for an ownerless community listing (or no usable name).
 */
export async function resolveOrganiserName(
  repos: LineupSupportRepos,
  event: Pick<EventRecord, "orgId" | "humanId">,
): Promise<string | null> {
  if (event.orgId) {
    const org = await repos.organizations.getById(event.orgId);
    return displayNameForCopy(org?.name ?? null);
  }
  if (event.humanId) {
    const human = await repos.humans.getById(event.humanId);
    return displayNameForCopy(human?.name ?? null);
  }
  return null;
}

/**
 * Human admin slug — mirrors the web's `toHumanAdminSlug`
 * (apps/web/src/hooks/useEventOwnerEntities.ts) and
 * notify-event-application-received: `@username`, else the entity page's
 * `@slug`, else `@humanId`.
 */
export async function resolveHumanAdminSlug(
  repos: LineupSupportRepos,
  humanId: string,
): Promise<string> {
  const withIdentity = await repos.humans.getByIdWithIdentity(humanId);
  const username = withIdentity?.identity.username ?? null;
  if (username) return `@${encodeURIComponent(username)}`;

  const page = await repos.entityPages.getByOwner("HUMAN", humanId);
  if (page?.slug) return `@${encodeURIComponent(page.slug)}`;

  return `@${humanId}`;
}

export type LineupEditorRecipient = { humanId: string; lineupUrl: string };

/**
 * Who hears that someone left the lineup: the people who can edit it. For an
 * org event, every OWNER/ADMIN/EDITOR member (paged + deduped); for a
 * personal event, the owning human. Same resolution as
 * notify-event-application-received. Deliberately NOT included: the owning
 * human's delegates, and community moderators of an ownerless listing (a
 * community listing therefore has no recipients).
 *
 * Each recipient gets the lineup section of the builder under the admin slug
 * they reach the event through.
 */
export async function resolveLineupEditorRecipients(
  repos: LineupSupportRepos,
  event: Pick<EventRecord, "id" | "orgId" | "humanId">,
  baseUrl: string,
): Promise<LineupEditorRecipient[]> {
  const lineupUrl = (adminSlug: string) =>
    `${baseUrl}/admin/${adminSlug}/events/${event.id}/edit?section=lineup`;

  if (event.orgId) {
    const org = await repos.organizations.getById(event.orgId);
    // Org admin slug rule mirrors `toOrgAdminSlug` (web): slug, else raw id.
    const url = lineupUrl(encodeURIComponent(org?.slug || event.orgId));
    return (await listLineupEditorHumanIds(repos, event.orgId)).map(
      (humanId) => ({ humanId, lineupUrl: url }),
    );
  }

  if (event.humanId) {
    const slug = await resolveHumanAdminSlug(repos, event.humanId);
    return [{ humanId: event.humanId, lineupUrl: lineupUrl(slug) }];
  }

  return [];
}

/**
 * The org half of {@link resolveLineupEditorRecipients}: every
 * OWNER/ADMIN/EDITOR (ORG_EDIT_ROLES) member of the org, paged + deduped, in
 * member order — the booking notices' `listOrgEditMembers`, the same rule.
 * ONE logical membership read per org — callers batching many events read
 * each distinct org once.
 */
export async function listLineupEditorHumanIds(
  repos: Pick<Repos, "organizations">,
  orgId: string,
): Promise<string[]> {
  return listOrgEditMembers({ repos }, orgId);
}

/**
 * "The organiser will be told" — exactly: does the leave notice
 * (`leaveEventLineup` → `event.lineup-left`) have at least one recipient
 * OTHER than the person? Same recipient set as
 * {@link resolveLineupEditorRecipients}, minus the person:
 *   · org event → some edit-role member who is not the person (an org whose
 *     ONLY editor is the person tells nobody);
 *   · personal event → the owner is not the person;
 *   · ownerless community listing → false.
 * Pure over a pre-read editor list, so a page of lineups reads each distinct
 * org once (`listLineupEditorHumanIds`); pass `orgEditorIds` for the event's
 * org (ignored for a non-org event).
 */
export function leaveNoticeReachesSomeoneElse(
  event: Pick<EventRecord, "orgId" | "humanId">,
  personHumanId: string,
  orgEditorIds: readonly string[],
): boolean {
  if (event.orgId) return orgEditorIds.some((id) => id !== personHumanId);
  return Boolean(event.humanId && event.humanId !== personHumanId);
}


/**
 * ReporterPort convention: report a deliberate swallow, and never let a
 * throwing reporter change the outcome.
 */
export function reportSafely(
  reportError: ReporterPort | undefined,
  error: unknown,
  context: { tags: Record<string, string>; extra: Record<string, unknown> },
): void {
  try {
    reportError?.(error, context);
  } catch {
    // Best-effort — a throwing reporter must never change the outcome.
  }
}
