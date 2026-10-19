import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { listPublicTiers } from "../memberships/list-public-tiers";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { fail } from "@th/errors";

export const getMembershipWidgetInputSchema = z
  .object({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
  })
  .strict();

export const getMembershipWidgetOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      subjectType: z.string(),
      domain: z.string(),
    }),
    owner: z.object({
      kind: z.enum(["organization", "human"]),
      id: z.string(),
      name: z.string(),
      /**
       * The owner's PUBLIC entity-page slug — the widget builds its Join
       * link-out as `/p/<joinSlug>?tab=memberships` (the exact target the
       * admin join-link dialog copies). Null when the owner has no publicly
       * servable page (none, or PRIVATE — `getPublicPage` refuses those), in
       * which case the widget renders the tiers without a Join CTA rather
       * than emitting a link that 404s.
       */
      joinSlug: z.string().nullable(),
    }),
    /**
     * ACTIVE tiers only, display fields only — the exact `listPublicTiers`
     * item shape (which this use case delegates to). Empty for a suspended
     * owner (quiet empty state, deliberately indistinguishable from "no
     * tiers" — see the rationale in list-public-tiers.ts).
     */
    tiers: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        description: z.string().nullable(),
        /** The owner's own claim about what members get. */
        benefitsDescription: z.string().nullable(),
        priceCents: z.number().int(),
        currency: z.string(),
        interval: z.enum(["MONTH", "YEAR"]),
        sortOrder: z.number().int(),
      }),
    ),
  })
  .strict();

export type GetMembershipWidgetInput = z.infer<
  typeof getMembershipWidgetInputSchema
>;
export type GetMembershipWidgetOutput = z.infer<
  typeof getMembershipWidgetOutputSchema
>;

export type GetMembershipWidgetDeps = {
  /**
   * Full `Repos` (not a Pick) because tier loading is DELEGATED to
   * `listPublicTiers`, whose deps are typed against `Repos`. Actually read:
   * embeds, organizations, humans, entityPages, membershipStandings,
   * membershipTiers.
   */
  repos: Repos;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
};

/**
 * Resolve the display data the /embed/memberships iframe needs: embed summary,
 * owner summary (with the entity-page slug the Join CTA links out to), and the
 * owner's PUBLIC membership tiers.
 *
 * Fail-closed on origin (same contract as `getBookingWidget`): a REVOKED
 * embed, a null/unparseable hostOrigin, or a non-allowlisted domain all reject
 * before any owner data is read. Only "memberships" embeds are served — other
 * subject types get the same UNSUPPORTED_SUBJECT_TYPE rejection as the
 * sibling widget reads.
 *
 * The widget deliberately has NO in-frame join flow: joining requires an
 * authed session, a platform-owned Stripe Customer, and an Elements confirm —
 * none of which belong in a third-party iframe (and the guest-checkout embed
 * path doesn't fit subscriptions: saved card + portal management need the
 * first-party context). The Join CTA opens `/p/<slug>?tab=memberships` in a
 * new top-level tab instead, where the standard join flow lives.
 */
export async function getMembershipWidget(
  deps: GetMembershipWidgetDeps,
  rawInput: unknown,
): Promise<GetMembershipWidgetOutput> {
  const logger = deps.logger?.child({ useCase: "getMembershipWidget" });

  const execute = async () => {
    const input = parseInput(getMembershipWidgetInputSchema, rawInput);

    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed || embed.status !== "ACTIVE") {
      throw fail("EMBED_NOT_FOUND");
    }

    assertEmbedOriginAllowed({
      embed,
      hostOrigin: input.hostOrigin,
      publicAppUrl: deps.publicAppUrl,
      logger,
    });

    if (embed.subjectType !== "memberships") {
      throw fail("UNSUPPORTED_SUBJECT_TYPE");
    }

    // ── Owner (org-first, same resolution as the write-path gate) ────
    let owner: {
      kind: "organization" | "human";
      id: string;
      name: string;
    };
    let ownerType: "ORGANIZATION" | "HUMAN";

    const org = await deps.repos.organizations.getById(embed.subjectId);
    if (org) {
      ownerType = "ORGANIZATION";
      owner = { kind: "organization", id: org.id, name: org.name };
    } else {
      const human = await deps.repos.humans.getById(embed.subjectId);
      if (!human) {
        throw fail("OWNER_NOT_FOUND");
      }
      ownerType = "HUMAN";
      // Same neutral fallback as getEmbedForWidget's human branch — never
      // render "null" as a heading.
      owner = { kind: "human", id: human.id, name: human.name ?? "Membership" };
    }

    // ── Join link target ─────────────────────────────────────────────
    // The entity page is where the join flow lives (/p/<slug>?tab=memberships,
    // same link buildJoinLink copies on the admin page). PRIVATE pages are
    // never served publicly (get-public-page.ts), so don't link to one.
    const page = await deps.repos.entityPages.getByOwner(ownerType, owner.id);
    const joinSlug = page && page.visibility !== "PRIVATE" ? page.slug : null;

    // ── Tiers (delegated — ACTIVE only, suspended owner ⇒ empty) ─────
    const { items } = await listPublicTiers(
      { repos: deps.repos, logger: deps.logger },
      { ownerType, ownerId: owner.id },
    );

    return {
      embed: {
        id: embed.id,
        subjectType: embed.subjectType,
        domain: embed.domain,
      },
      owner: { ...owner, joinSlug },
      tiers: items,
    };
  };

  if (logger) {
    return logger.withTime("getMembershipWidget", execute);
  }
  return execute();
}
