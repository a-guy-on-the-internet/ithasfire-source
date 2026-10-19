"use client";

import type { CSSProperties, ReactNode } from "react";
import { YStack, XStack } from "tamagui";
import { Text, Badge, NextLinkAnchor, useTranslations } from "@th/ui";

import {
  getStatusBadgeTone,
  type PlaceStatus,
} from "@/lib/verification-config";

// ─────────────────────────────────────────────────────────────────────────────
// "Who owns this venue?", "what state is it in?", "is it listed?", "what is
// its id?" — the read-only, out-of-band facts about a place.
//
// These four regions were born inside the old details form's 296px aside
// (`edit/_components/PlaceSettingsAside`, deleted with `/edit`, FR-401),
// which is a 296px complementary rail. They are lifted out unchanged so the
// merged venue-settings surface can render the same answers as a full-width
// SECTION without a second implementation drifting from this one. The aside
// rendered them — in `embedded` mode, which is what kept `/edit`
// byte-identical.
//
// Strict Swiss forbids cards inside cards, so the regions are divided by 1px
// `$borderColor` rules inside ONE panel rather than being separate boxes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structurally identical to core's `PlaceEditOwner` (get-place-for-edit.ts).
 * Declared locally rather than imported so this component does not widen the
 * core package's public surface for a display concern; the tRPC payload
 * satisfies it by shape.
 */
export type PlaceEditOwnerRow = {
  kind: "ORGANIZATION" | "HUMAN";
  id: string;
  name: string;
  /** null ⇒ no publicly reachable page ⇒ render the name UNLINKED. */
  pageSlug: string | null;
};

export type OwnershipStatusSectionProps = {
  placeId: string;
  /**
   * The resolved owner rows. THREE states, and they are not the same thing
   * (core keeps them distinguishable on purpose — see get-place-for-edit.ts):
   *
   *  - `undefined` → `includeOwners` was not sent. On a surface that does send
   *    it that is a bug, not a user-facing state, so the whole region is
   *    omitted rather than dressed up with copy.
   *  - `[]` → the lookup ran and produced nothing. Under the ownership gate at
   *    least one owner id always exists, so this is an anomaly (a deleted owner
   *    row, or an owner with no usable name); the server reports both to
   *    Sentry. It gets a neutral, muted line.
   *  - non-empty → the normal case.
   *
   * The `[]` copy deliberately does NOT say the owners failed to load: the same
   * array is empty for a venue whose owner row exists but is nameless, and
   * telling an owner their venue's ownership "failed" would be a false
   * statement about data they own.
   */
  owners: PlaceEditOwnerRow[] | undefined;
  status: PlaceStatus;
  listedInDirectory: boolean;
  /**
   * Drop the bordered panel AND lead every region with its divider rule, so
   * the regions sit as a continuation of whatever the host already drew above
   * them. Same prop, same meaning as `AttendeeReviewsPublicToggle`'s and
   * `VerificationSection`'s: the host supplies the frame.
   *
   * The venue settings page passes it — its "Ownership & status" section
   * heading comes first, so the ownership heading needs the rule that
   * separates the two. Standalone,
   * ownership IS first, and a divider above the first region would be
   * decoration rather than separation.
   */
  embedded?: boolean;
  /**
   * Level of the two region headings. `h3` standalone (they are the panel's
   * top-level headings); `h4` when a host section already carries an `h3`
   * above them — the venue settings page's "Ownership & status" — so the
   * document outline nests instead of flattening.
   */
  regionHeadingTag?: "h3" | "h4";
};

const PLACE_STATUS_LABEL_KEY: Record<PlaceStatus, string> = {
  ACTIVE: "admin.placeEditStatusActive",
  SUSPENDED: "admin.placeEditStatusSuspended",
  ARCHIVED: "admin.placeEditStatusArchived",
};

/**
 * Reset for the owner `<ul>` — a list reset, not sibling spacing.
 *
 * `list-style: none` makes Safari/VoiceOver drop the list role entirely
 * (it treats an unmarkered list as presentational), so the `<ul>` carries an
 * explicit `role="list"` to keep "list, 2 items" announced.
 */
const OWNER_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};

/**
 * Owner names are arbitrary user-controlled `EntityPage.displayName` text, so
 * one unbroken token can be wider than the ~260px the aside panel has inside
 * it. `overflowWrap: anywhere` breaks it; the `flexShrink`/`minWidth` on the
 * Text itself is what lets it get narrow enough to need to (RNW gives flex
 * items `flexShrink: 0` and no `minWidth: 0`, so without both the label holds
 * its max-content width). Below the 800px threshold the aside has no
 * `overflow-y: auto` to absorb the excess, so it would escape into the
 * document.
 */
const OWNER_NAME_STYLE: CSSProperties = { overflowWrap: "anywhere" };

const OWNER_KIND_STYLE: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: 1,
};

/** Montserrat carries `tnum`; the id is a column-aligned hex string. */
const PLACE_ID_STYLE: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  wordBreak: "break-all",
};

/**
 * One region of a settings panel. `withRule` draws the 1px divider ABOVE it,
 * so the first region of a panel carries none — dividers separate, they do not
 * decorate.
 *
 * Exported because the old details aside drew its verification region with the
 * same rule; two copies of a divider convention is how two panels start
 * disagreeing about their own spacing.
 */
export function SettingsRegion({
  children,
  withRule = true,
}: {
  children: ReactNode;
  withRule?: boolean;
}) {
  return (
    <YStack
      gap="$2"
      {...(withRule
        ? {
            borderTopWidth: 1,
            borderTopColor: "$borderColor" as const,
            paddingTop: "$3" as const,
          }
        : {})}
    >
      {children}
    </YStack>
  );
}

export function OwnershipStatusSection({
  placeId,
  owners,
  status,
  listedInDirectory,
  embedded = false,
  regionHeadingTag = "h3",
}: OwnershipStatusSectionProps) {
  const t = useTranslations();

  const body = (
    <>
      {/* ── Ownership ───────────────────────────────────────────────────
          Omitted ENTIRELY when `owners` is undefined: that means the caller
          never asked for the projection, which says nothing about this venue's
          owners, and a heading over an apology would be inventing a
          user-facing state out of a caller bug. `[]` is different — that one
          is about the data, and it gets a line. */}
      {owners !== undefined && (
        <SettingsRegion withRule={embedded}>
          <Text variant="overline" weight="bold" tag={regionHeadingTag}>
            {String(t("admin.placeEditOwnersHeading"))}
          </Text>

          {owners.length === 0 ? (
            <Text
              variant="caption"
              tone="muted"
              data-testid="place-edit-owners-empty"
            >
              {String(t("admin.placeEditOwnersNone"))}
            </Text>
          ) : (
            <YStack tag="ul" role="list" gap="$3" style={OWNER_LIST_STYLE}>
              {owners.map((owner) => (
                <YStack tag="li" key={`${owner.kind}:${owner.id}`} gap="$1">
                  {owner.pageSlug ? (
                    <NextLinkAnchor
                      href={
                        owner.kind === "ORGANIZATION"
                          ? `/orgs/${owner.pageSlug}`
                          : `/humans/${owner.pageSlug}`
                      }
                      className="th-place-edit-link"
                    >
                      <span className="th-place-edit-link-rule">
                        {/* tone="inherit" so the label tracks the anchor's
                            colour through hover/focus instead of pinning its
                            own resting ink. */}
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          tone="inherit"
                          flexShrink={1}
                          minWidth={0}
                          style={OWNER_NAME_STYLE}
                        >
                          {owner.name}
                        </Text>
                      </span>
                    </NextLinkAnchor>
                  ) : (
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      flexShrink={1}
                      minWidth={0}
                      style={OWNER_NAME_STYLE}
                    >
                      {owner.name}
                    </Text>
                  )}
                  <Text variant="caption" tone="muted" style={OWNER_KIND_STYLE}>
                    {String(
                      t(
                        owner.kind === "ORGANIZATION"
                          ? "admin.placeEditOwnerKindOrganization"
                          : "admin.placeEditOwnerKindPerson",
                      ),
                    )}
                  </Text>
                </YStack>
              ))}
            </YStack>
          )}
        </SettingsRegion>
      )}

      {/* ── Status & listing (both READ-ONLY on this surface) ───────── */}
      {/* The rule is drawn only when something precedes it: embedded there is
          always the host's content above, standalone only when the ownership
          region rendered. A divider above nothing is decoration. */}
      <SettingsRegion withRule={embedded || owners !== undefined}>
        <Text variant="overline" weight="bold" tag={regionHeadingTag}>
          {String(t("admin.placeEditStatusHeading"))}
        </Text>

        <XStack
          gap="$2"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
        >
          <Text variant="caption" tone="muted" flexShrink={1} minWidth={0}>
            {String(t("admin.placeEditStatusRowLabel"))}
          </Text>
          {/* Same tone function the Places table and the mobile card use: a
              venue's status must not change colour on the way from the list
              into the editor. */}
          <Badge tone={getStatusBadgeTone(status)} size="sm">
            {String(t(PLACE_STATUS_LABEL_KEY[status]))}
          </Badge>
        </XStack>

        <XStack
          gap="$2"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
        >
          <Text variant="caption" tone="muted" flexShrink={1} minWidth={0}>
            {String(t("admin.placeEditListingRowLabel"))}
          </Text>
          <Badge tone={listedInDirectory ? "success" : "neutral"} size="sm">
            {listedInDirectory
              ? String(t("admin.placeEditListedBadge"))
              : String(t("admin.placeEditNotListedBadge"))}
          </Badge>
        </XStack>

        <Text variant="caption" tone="muted">
          {String(t("admin.placeEditDirectoryNote"))}
        </Text>
      </SettingsRegion>

      {/* ── Place id ─────────────────────────────────────────────────────
          Support asks for it by name; an owner never needs to read it. Last,
          muted, and break-all so a 36-char id cannot widen the panel. */}
      <SettingsRegion>
        <Text
          variant="caption"
          tone="muted"
          style={PLACE_ID_STYLE}
          data-testid="place-edit-place-id"
        >
          {String(t("admin.placeEditPlaceId", { placeId }))}
        </Text>
      </SettingsRegion>
    </>
  );

  if (embedded) {
    return body;
  }

  return (
    <YStack
      gap="$3"
      padding="$4"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surface"
    >
      {body}
    </YStack>
  );
}
