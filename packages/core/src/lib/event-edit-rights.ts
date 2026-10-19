import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES } from "./rbac";

export type EventEditRightsAuthz = Pick<
  Repos["authz"],
  "getOrgMembership" | "getHumanDelegation"
>;

/**
 * WHO HOLDS AN EDIT ROLE ON AN OWNED EVENT — the one implementation.
 *
 * Every "can this actor act on this event" bar for a human-owned event runs
 * through here (directly, or through {@link ensureActorHoldsHumanEventRole}):
 * `authz.canEditEvent` (`db-authz-adapter.ts`), the hidden-event read gate
 * (`use-cases/events/_shared/event-public-readability.ts`), the gate BYPASS
 * and `ensureActorCanEditEvent` (`_shared/ensure-actor-can-edit-event.ts`),
 * `getEventForEdit`, `saveEventForHuman`, `publishEvent`, the lineup/tags
 * guard, ticket types, and the rest of the builder surface. Before this
 * existed they carried their own copies and drifted.
 *
 *  - org-owned   → a member of the owning org whose role is in `roles`. The
 *                  human owner is NOT consulted, even if set.
 *  - human-owned → the owner, or a `HumanDelegate` of the owner whose role is
 *                  in `roles`. A VIEWER / FINANCE / SCANNER delegate is not
 *                  an editor.
 *  - ownerless   → nobody. COMMUNITY listings are ownerless by DB
 *                  constraint; their moderator arm is the caller's business
 *                  (see `ensure-owner-or-community-moderator.ts` for why it is
 *                  kept out of here).
 *
 * `roles` defaults to {@link ORG_EDIT_ROLES}. A use case whose ORG arm asks a
 * narrower set (unpublish / delete / archive / complete require
 * `ORG_ADMIN_ROLES`) passes the SAME set here, so a delegate gets exactly what
 * an org member with that role would: an EDITOR delegate can publish but not
 * unpublish, exactly like an org EDITOR.
 *
 * DELEGATES DO WHAT THE PRINCIPAL DOES (owner ruling 2026-09-28): an
 * edit-role delegate opens, saves, publishes, prices, comps,
 * cancels (refunds included), migrates orders and transfers tickets on the
 * principal's personal events, and bypasses the principal's own password /
 * application gates — except to THEMSELVES: no comp, transfer, $0-tier claim
 * or self-approved application puts a ticket in the delegate's own hands (see
 * {@link ensureDelegateNotSelfRecipient}; `claimFreeTickets` and
 * `reviewEventApplicationSubmission` included). The event's OWNER never moves — a delegate's save keeps
 * `humanId = principal` — while audit rows (and the
 * publish host attestation) record the delegate as the actor.
 *
 * PAYOUT ROUTING STAYS OWNER-ONLY: splits (get/update), fee mode, agreements
 * and agreement lines, booking-agreement finalisation and the payout
 * schedule. Those use {@link ensurePayoutRoutingActor}, never this.
 */
export async function actorHoldsEventEditRole(
  authz: EventEditRightsAuthz,
  owner: { orgId: string | null; humanId: string | null },
  actorHumanId: string | null | undefined,
  roles: readonly OrgRole[] = ORG_EDIT_ROLES,
): Promise<boolean> {
  if (!actorHumanId) return false;

  if (owner.orgId) {
    const membership = await authz.getOrgMembership({
      orgId: owner.orgId,
      humanId: actorHumanId,
    });
    return Boolean(membership && roles.includes(membership.role));
  }

  if (owner.humanId) {
    if (owner.humanId === actorHumanId) return true;
    const delegation = await authz.getHumanDelegation({
      principalId: owner.humanId,
      delegateId: actorHumanId,
    });
    return Boolean(delegation && roles.includes(delegation.role));
  }

  return false;
}

/**
 * The HUMAN-OWNED arm of an event guard, as a throw. Call sites keep their
 * org arm (`requireOrgMembership`, whose error code and role set are theirs)
 * and replace `event.humanId !== actorHumanId` with this.
 *
 * Refuses with `NOT_RESOURCE_OWNER` / `meta.entity = "event"` — byte-identical
 * to the owner-only refusal it replaces, so a stranger cannot tell the
 * delegate branch exists. A null `ownerHumanId` (ownerless row) is refused.
 */
export async function ensureActorHoldsHumanEventRole(
  authz: EventEditRightsAuthz,
  ownerHumanId: string | null | undefined,
  actorHumanId: string,
  roles: readonly OrgRole[] = ORG_EDIT_ROLES,
): Promise<void> {
  const allowed = await actorHoldsEventEditRole(
    authz,
    { orgId: null, humanId: ownerHumanId ?? null },
    actorHumanId,
    roles,
  );
  if (!allowed) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
  }
}

/**
 * PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). Who gets paid, and
 * how — splits, fee mode (ABSORB / PASS_THROUGH), agreements and their lines,
 * booking-agreement finalisation, the payout schedule — is the ONE thing an
 * edit-role delegate may not do on the principal's personal event.
 *
 * Org-owned events are the caller's org arm (unchanged) and pass through
 * here untouched. A human-owned event admits its owner only; an ownerless
 * row admits nobody. `code` lets a caller keep the refusal it always threw.
 */
export function ensurePayoutRoutingActor(
  owner: { orgId: string | null; humanId: string | null },
  actorHumanId: string,
  code: "NOT_RESOURCE_OWNER" | "INSUFFICIENT_ROLE" = "NOT_RESOURCE_OWNER",
): void {
  if (owner.orgId) return;
  if (owner.humanId && owner.humanId === actorHumanId) return;
  if (code === "INSUFFICIENT_ROLE") throw fail("INSUFFICIENT_ROLE");
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
}

/**
 * Is `actorHumanId` an edit-role DELEGATE (not the owner) of the HUMAN owner
 * `ownerId`? For the owner-scoped LISTS a principal's event builder reads on
 * their behalf — `listMyEvents` (the order-migration target picker) and
 * `listPromos` (the share dialog). Those keep `requireOwnerAccess` for every
 * other case; this only adds the delegate arm (owner ruling 2026-09-28).
 * Always false for an ORGANIZATION owner or for the owner themself.
 */
export async function isEditDelegateOfHumanOwner(
  authz: EventEditRightsAuthz,
  owner: { ownerType: "HUMAN" | "ORGANIZATION"; ownerId: string },
  actorHumanId: string,
): Promise<boolean> {
  if (owner.ownerType !== "HUMAN" || owner.ownerId === actorHumanId) {
    return false;
  }
  return actorHoldsEventEditRole(
    authz,
    { orgId: null, humanId: owner.ownerId },
    actorHumanId,
  );
}

type PayoutTermsDraftCarrier = {
  payoutTermsDraft?: unknown;
  agreementDraft?: unknown;
};

/**
 * PAYOUT ROUTING in template / series DEFAULTS (owner ruling 2026-09-28).
 * `defaults.payoutTermsDraft` (payee lines + fee mode) is payout routing
 * waiting to be materialised, and a human's edit-role delegates can now write
 * their principal's templates and series. For a write to a HUMAN-owned
 * template or series by anyone but the owner:
 *
 *  - a NON-NULL incoming draft is refused, exactly as
 *    {@link ensurePayoutRoutingActor} refuses the live splits editor
 *    (`NOT_RESOURCE_OWNER`); and
 *  - whatever draft is STORED is carried over into the new defaults, so a
 *    delegate's save (which replaces `defaults` wholesale) never clears it.
 *
 * The owner, and every ORGANIZATION-owned write, get `incoming` back
 * untouched. Returns the defaults to persist.
 */
export function guardPayoutTermsDraftWrite<D extends PayoutTermsDraftCarrier>(
  args: {
    ownerScope: "HUMAN" | "ORGANIZATION";
    ownerId: string;
    actorHumanId: string;
    incoming: D | null | undefined;
    stored: PayoutTermsDraftCarrier | null | undefined;
  },
): D | null | undefined {
  const owner =
    args.ownerScope === "HUMAN"
      ? { orgId: null, humanId: args.ownerId }
      : { orgId: args.ownerId, humanId: null };
  const incomingDraft =
    args.incoming?.payoutTermsDraft ?? args.incoming?.agreementDraft ?? null;
  if (incomingDraft !== null) {
    ensurePayoutRoutingActor(owner, args.actorHumanId);
  }
  const routesPayouts =
    args.ownerScope !== "HUMAN" || args.ownerId === args.actorHumanId;
  if (routesPayouts) return args.incoming;

  const storedDraft =
    args.stored?.payoutTermsDraft ?? args.stored?.agreementDraft ?? null;
  if (storedDraft === null) return args.incoming;
  return {
    ...(args.incoming ?? {}),
    payoutTermsDraft: storedDraft,
    ...(args.stored && "agreementDraft" in args.stored
      ? { agreementDraft: args.stored.agreementDraft }
      : {}),
  } as D;
}

const normalizeEmail = (email: string | null | undefined): string | null => {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The mailbox an address actually delivers to, for "is this the same
 * person?" comparisons ONLY (never for lookups or sending): lowercase + trim,
 * `+tag` stripped from the local part for every domain, and for Gmail the
 * dots dropped and `googlemail.com` folded into `gmail.com`. So
 * `dele+x@gmail.com`, `d.e.l.e@gmail.com` and `DELE@googlemail.com` are all
 * `dele@gmail.com`.
 */
export function canonicalEmail(
  email: string | null | undefined,
): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return normalized;
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return local ? `${local}@${domain}` : normalized;
}

/**
 * A DELEGATE must not benefit themselves (owner ruling 2026-09-28): acting on
 * the principal's personal event, a delegate may not name THEMSELVES the
 * recipient of a ticket — an organizer transfer or a comp.
 *
 * Only a delegate is checked. Org-owned events, ownerless rows and the human
 * owner acting on their own event pass straight through with no lookup —
 * "owners and org members keep today's behaviour".
 *
 * "Themselves" is matched on every form a recipient can take:
 *  - `recipientHumanId` equal to the actor;
 *  - `recipientEmail` equal to the actor's account email in
 *    {@link canonicalEmail} form (case, whitespace, `+tag`, Gmail dots,
 *    googlemail), or resolving (`humans.getByEmail`) to the actor's Human;
 *  - `recipientHumanId` whose account email canonically equals the actor's
 *    (a second Human sharing the delegate's mailbox).
 *
 * Call it BEFORE any write that resolves the recipient (e.g.
 * `ensureGuestHuman`), so a refusal leaves nothing behind.
 *
 * @throws `DELEGATE_SELF_BENEFIT_FORBIDDEN`
 */
export async function ensureDelegateNotSelfRecipient(
  humans: Pick<Repos["humans"], "getByIdWithIdentity" | "getByEmail">,
  args: {
    eventOwner: { orgId: string | null; humanId: string | null };
    actorHumanId: string;
    recipientHumanId?: string | null;
    recipientEmail?: string | null;
  },
): Promise<void> {
  const { eventOwner, actorHumanId } = args;
  if (eventOwner.orgId || !eventOwner.humanId) return;
  if (eventOwner.humanId === actorHumanId) return;

  const refuse = () => {
    throw fail("DELEGATE_SELF_BENEFIT_FORBIDDEN");
  };

  if (args.recipientHumanId && args.recipientHumanId === actorHumanId) {
    refuse();
  }

  const actor = await humans.getByIdWithIdentity(actorHumanId);
  const actorEmail = canonicalEmail(actor?.identity.email);

  const recipientEmail = normalizeEmail(args.recipientEmail);
  if (recipientEmail) {
    // Compared canonically (tags, Gmail dots, googlemail); LOOKED UP as typed.
    if (actorEmail && canonicalEmail(recipientEmail) === actorEmail) refuse();
    const byEmail = await humans.getByEmail(recipientEmail);
    if (byEmail?.human.id === actorHumanId) refuse();
  }

  if (args.recipientHumanId && actorEmail) {
    const recipient = await humans.getByIdWithIdentity(args.recipientHumanId);
    if (canonicalEmail(recipient?.identity.email) === actorEmail) refuse();
  }
}
