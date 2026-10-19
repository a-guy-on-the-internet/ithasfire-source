/**
 * Where a booking agreement is EDITED, by who is looking at it.
 *
 * Two surfaces render the same editor:
 *
 *  - `/admin/{slug}/bookings/agreement/{id}` — the venue/organizer's copy,
 *    inside their admin shell, one click from the booking it belongs to. The
 *    editor party never has to leave the booking to finish the agreement.
 *  - `/agreements/{id}` — the standalone page. A HUMAN performer's copy (a
 *    person acting as the act has no admin for requests they sent), and the
 *    fallback for an editor who is a party through something the owner-entity
 *    list does not carry (a place grant without org membership).
 *
 * WHO MOVES (decision 2026-08-26): an organization is always inside its
 * admin shell, on either side — a group acting as the performer has an admin
 * exactly like a venue does, and its "requests to you as an act" inbox already
 * links there. So: the viewer's matching entity for the actor's party is an
 * ORGANIZATION → admin, whichever side; a HUMAN entity → admin only when the
 * viewer is the editor; a human performer → stays.
 *
 * Pure (no React) so the redirect decision can be unit-tested in isolation.
 * Every href in the app goes through these three builders — a route rename
 * is one edit, not a grep.
 */

import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";
import { settingsSectionHref } from "@/app/account/settings/_lib/settings-routes";

export type AgreementPartyType = "human" | "organization";

export function standaloneAgreementHref(agreementId: string): string {
  return `/agreements/${agreementId}`;
}

export function adminAgreementHref(slug: string, agreementId: string): string {
  return `/admin/${slug}/bookings/agreement/${agreementId}`;
}

/**
 * The booking the agreement came from, in the admin inbox. `?request=` opens
 * that row's detail; a request-less agreement lands on the inbox itself.
 */
export function adminBookingHref(
  slug: string,
  bookingRequestId: string | null,
): string {
  const base = `/admin/${slug}/bookings`;
  return bookingRequestId
    ? `${base}?request=${encodeURIComponent(bookingRequestId)}`
    : base;
}

/**
 * The performer's list of the requests they sent (and the agreements hanging
 * off them) — Account settings → Booking requests. A human act has no admin
 * shell, so this is their "back to the list".
 */
export function performerBookingRequestsHref(): string {
  return settingsSectionHref("booking-requests");
}

/**
 * Where the retired `/agreements` LIST page sends a viewer once their owner
 * entities are known (decision 2026-08-26, "agreements inside the booking"):
 *
 *  - exactly one organization → that org's booking inbox (its Agreement tab
 *    is the list now);
 *  - several organizations → `/admin`, which renders the entity chooser when
 *    the viewer has more than one org (`AdminRoot`);
 *  - no organization (a human performer, or owners unknown/empty) → the
 *    performer's Booking requests settings section.
 *
 * Pure so the rule is unit-testable; the page decides WHEN owners are settled.
 */
export function resolveAgreementsListRedirect(
  owners: readonly OwnerEntityWithSlug[] | undefined,
): string {
  const orgs = (owners ?? []).filter((o) => o.kind === "org");
  if (orgs.length === 1) return adminBookingHref(orgs[0]!.adminSlug, null);
  if (orgs.length > 1) return "/admin";
  return performerBookingRequestsHref();
}

export interface AgreementPartyRef {
  actorSide: "proposer" | "counterparty";
  agreement: {
    proposerType: AgreementPartyType;
    proposerId: string;
    counterpartyType: AgreementPartyType;
    counterpartyId: string;
  };
}

/**
 * The viewer's OWN owner entity for the party they are on, or null. Matched by
 * party type + id (an org party needs an org entry, a human party the human
 * entry) so the other party's entity can never be mistaken for the viewer's.
 */
export function findAgreementPartyOwner(
  { actorSide, agreement }: AgreementPartyRef,
  owners: readonly OwnerEntityWithSlug[] | undefined,
): OwnerEntityWithSlug | null {
  if (!owners) return null;
  const partyType =
    actorSide === "proposer"
      ? agreement.proposerType
      : agreement.counterpartyType;
  const partyId =
    actorSide === "proposer" ? agreement.proposerId : agreement.counterpartyId;
  return (
    owners.find((o) =>
      partyType === "organization"
        ? o.kind === "org" && o.orgId === partyId
        : o.kind === "human" && o.humanId === partyId,
    ) ?? null
  );
}

/**
 * Whether a redirect is POSSIBLE for this viewer once owners are known — the
 * standalone page waits on the owners read only when this is true, so a human
 * performer never sees a spinner for a decision that can only be "stay".
 */
export function agreementMayRedirect(
  input: Pick<AgreementRedirectInput, "viewerSide" | "actorSide" | "agreement">,
): boolean {
  if (input.viewerSide === "editor") return true;
  const partyType =
    input.actorSide === "proposer"
      ? input.agreement.proposerType
      : input.agreement.counterpartyType;
  return partyType === "organization";
}

export interface AgreementRedirectInput {
  agreementId: string;
  /** `bookingAgreements.get` → `viewerSide`. Only `editor` ever moves. */
  viewerSide: "editor" | "act" | null;
  /** `bookingAgreements.get` → `actorSide`: which party the viewer is. */
  actorSide: "proposer" | "counterparty";
  agreement: {
    proposerType: AgreementPartyType;
    proposerId: string;
    counterpartyType: AgreementPartyType;
    counterpartyId: string;
  };
  /**
   * The viewer's owner entities (`useEventOwnerEntities().ownersWithSlugs`).
   * `undefined` while unknown — the caller must not decide yet.
   */
  owners: readonly OwnerEntityWithSlug[] | undefined;
}

/**
 * Where the standalone page should send this viewer, or null to stay.
 *
 * `actorSide` is server-resolved, so the UI never guesses which party is
 * "the venue". The slug comes from the viewer's OWN entity for that party
 * (`findAgreementPartyOwner`). No match (edit access via a place grant, no
 * org membership) → null: the standalone page still works there, a 404
 * under a wrong slug would not. See the header for who moves.
 */
export function resolveAgreementAdminRedirect(
  input: AgreementRedirectInput,
): string | null {
  const owner = findAgreementPartyOwner(input, input.owners);
  if (!owner) return null;
  if (owner.kind !== "org" && input.viewerSide !== "editor") return null;
  return adminAgreementHref(owner.adminSlug, input.agreementId);
}
