import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import { humanProfileUrlFor } from "../../place-reviews/list-place-lineup-history";
import { performerOwnerKey } from "./performer-display-names";

// ─────────────────────────────────────────────────────────────────────────────
// The bill as READ (lineup-booking-requests v2, FR-004): act rows → display
// items. One place for the wire shape and for the two rules every reader
// shares:
//   · identity — a platform act's name and page link are resolved in ONE
//     batched pass per call (humans + orgs + their pages), never per row;
//   · honesty — a free-text act NEVER carries a link (`href: null` even when
//     the sender typed a URL): a typed URL must not look like a linked,
//     confirmed platform identity.
// Who may see which rows (the venue never sees a DECLINED act) is the
// caller's decision, taken with `hideDeclined`.
// ─────────────────────────────────────────────────────────────────────────────

export const bookingRequestActSourceSchema = z.enum([
  "SELF",
  "TAGGED",
  "EXTERNAL",
]);

export const bookingRequestActConfirmationSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "DECLINED",
]);

/** EventHuman's role vocabulary (`EventHumanRole`), reused on the bill. */
export const bookingRequestActRoleSchema = z.enum([
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
]);

export const bookingRequestBillItemSchema = z
  .object({
    id: z.uuid(),
    source: bookingRequestActSourceSchema,
    /**
     * Platform acts: the PUBLIC page's display name, else the human / org
     * name — null when neither resolves. EXTERNAL: the typed name.
     */
    displayName: z.string().nullable(),
    /**
     * Relative link to the act's PUBLIC page (`/humans/{slug}`,
     * `/orgs/{slug}`), null when there is none. ALWAYS null for EXTERNAL.
     */
    href: z.string().nullable(),
    /** PENDING renders as "invited" — never as confirmed (NFR-002). */
    confirmation: bookingRequestActConfirmationSchema,
    role: bookingRequestActRoleSchema,
    /** Free-text label beside role OTHER (v3 L13); null otherwise. */
    customRoleLabel: z.string().nullable(),
    /**
     * Position on the bill AS THIS AUDIENCE SEES IT: dense 0..n-1 over the
     * items returned (0 = headliner, shown as "Headlining"). Never the stored
     * column — after the venue filter hides passed acts, a raw sortOrder's
     * gaps would tell the venue someone was hidden (v3 FR-004 / NFR-002), and
     * a sender-removed act leaves a gap too.
     */
    sortOrder: z.number().int().nonnegative(),
    /** The SELF row — the sender's own act ("you" on the sender's views). */
    isSender: z.boolean(),
    /**
     * The platform identity of an act that has JOINED (CONFIRMED SELF /
     * TAGGED rows) — what the agreement's payee picker offers (v3 FR-011,
     * L2). Null for an invited or passed act (no consent yet → its id does
     * not leave the server) and ALWAYS null for a by-name act (it is not a
     * platform identity, NFR-002).
     */
    joinedAs: z
      .object({
        ownerType: z.enum(["human", "organization"]),
        ownerId: z.uuid(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BookingRequestBillItem = z.infer<
  typeof bookingRequestBillItemSchema
>;

export type BillIdentity = { displayName: string | null; href: string | null };

/** Relative link to an organization's public page (`apps/web/src/app/orgs`). */
export function orgPageUrlFor(pageSlug: string | null): string | null {
  const slug = pageSlug?.trim();
  return slug ? `/orgs/${slug}` : null;
}

/**
 * Names + page links for every platform act in `acts`, keyed by
 * {@link performerOwnerKey}. At most FOUR reads for the whole batch (humans,
 * their pages, orgs, their pages) — zero when no act has an owner.
 *
 * Only PUBLIC pages contribute a display name or a link: a PRIVATE /
 * UNLISTED page is not something a bill should point strangers at (the
 * same predicate the taggable check uses).
 */
export async function resolveBillIdentities(
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">,
  acts: readonly Pick<BookingRequestActRecord, "actOwnerType" | "actOwnerId">[],
): Promise<Map<string, BillIdentity>> {
  const humanIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const act of acts) {
    if (!act.actOwnerType || !act.actOwnerId) continue;
    if (act.actOwnerType === "human") humanIds.add(act.actOwnerId);
    else orgIds.add(act.actOwnerId);
  }

  const identities = new Map<string, BillIdentity>();
  if (humanIds.size === 0 && orgIds.size === 0) return identities;

  const [humans, humanPages, orgs, orgPages] = await Promise.all([
    humanIds.size > 0 ? repos.humans.getByIds([...humanIds]) : [],
    humanIds.size > 0
      ? repos.entityPages.getByOwners("HUMAN", [...humanIds])
      : [],
    orgIds.size > 0 ? repos.organizations.getByIds([...orgIds]) : [],
    orgIds.size > 0
      ? repos.entityPages.getByOwners("ORGANIZATION", [...orgIds])
      : [],
  ]);

  const publicHumanPages = new Map(
    humanPages
      .filter((p) => p.ownerType === "HUMAN" && p.visibility === "PUBLIC")
      .map((p) => [p.ownerId, p] as const),
  );
  const publicOrgPages = new Map(
    orgPages
      .filter((p) => p.ownerType === "ORGANIZATION" && p.visibility === "PUBLIC")
      .map((p) => [p.ownerId, p] as const),
  );

  for (const human of humans) {
    const page = publicHumanPages.get(human.id);
    identities.set(performerOwnerKey("human", human.id), {
      displayName: page?.displayName?.trim() || human.name?.trim() || null,
      href: humanProfileUrlFor(page?.slug ?? null),
    });
  }
  for (const org of orgs) {
    const page = publicOrgPages.get(org.id);
    identities.set(performerOwnerKey("organization", org.id), {
      displayName: page?.displayName?.trim() || org.name?.trim() || null,
      href: orgPageUrlFor(page?.slug ?? null),
    });
  }
  return identities;
}

/** The identity of ONE act out of a {@link resolveBillIdentities} batch. */
export function billIdentityOf(
  act: Pick<
    BookingRequestActRecord,
    "source" | "actOwnerType" | "actOwnerId" | "externalName"
  >,
  identities: ReadonlyMap<string, BillIdentity>,
): BillIdentity {
  if (act.source === "EXTERNAL" || !act.actOwnerType || !act.actOwnerId) {
    // Free text: its own name, never a link (see the module header).
    return { displayName: act.externalName ?? null, href: null };
  }
  return (
    identities.get(performerOwnerKey(act.actOwnerType, act.actOwnerId)) ?? {
      displayName: null,
      href: null,
    }
  );
}

/**
 * One request's act rows → wire items, in `sortOrder` (the port's order).
 * `hideDeclined` is the venue-facing filter (FR-004: a declined act is
 * HIDDEN from every venue render, struck only for the sender). Removed rows
 * (v3 FR-001) never render for anyone — the port hides them by default, and
 * a caller that read them with `includeRemoved` gets them dropped here too.
 *
 * `sortOrder` on the items is RENUMBERED densely over what is returned (see
 * the schema): the venue counts 1, 2, 3 whether or not an act between them
 * passed.
 */
export function toBillItems(
  acts: readonly BookingRequestActRecord[],
  identities: ReadonlyMap<string, BillIdentity>,
  options: { hideDeclined: boolean },
): BookingRequestBillItem[] {
  return acts
    .filter((act) => !act.removedAt)
    .filter((act) => !(options.hideDeclined && act.confirmation === "DECLINED"))
    .map((act, position) => {
      const identity = billIdentityOf(act, identities);
      return {
        id: act.id,
        source: act.source,
        displayName: identity.displayName,
        href: identity.href,
        confirmation: act.confirmation,
        role: act.role,
        customRoleLabel:
          act.role === "OTHER" ? (act.customRoleLabel ?? null) : null,
        sortOrder: position,
        isSender: act.source === "SELF",
        joinedAs:
          act.source !== "EXTERNAL" &&
          act.confirmation === "CONFIRMED" &&
          act.actOwnerType &&
          act.actOwnerId
            ? { ownerType: act.actOwnerType, ownerId: act.actOwnerId }
            : null,
      };
    });
}
