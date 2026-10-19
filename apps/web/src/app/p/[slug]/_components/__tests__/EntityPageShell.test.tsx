import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import type { GetPublicPageOutput } from "@th/core/use-cases/entity-pages";

// maplibre-gl (pulled in via PlaceLogisticsCard → LocationMapPreview) calls
// `URL.createObjectURL` at IMPORT time, which jsdom lacks. Nothing here
// renders a map — the tree is inspected, never rendered — so stub the module.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: () => null,
}));

import { EntityPageShell } from "../EntityPageShell";
import { MembershipsPanel } from "../memberships/MembershipsPanel";

/**
 * RSC-leak regression pin (recurring-memberships review, round 3).
 *
 * EntityPageShell is a SERVER component: every prop it hands to a client
 * component is serialised into the RSC flight payload inside the HTML — which
 * /p/[slug] caches anonymously (`revalidate = 60`). Passing member-gated
 * (`section == "memberships"`) block content as a prop therefore published it
 * to every anonymous viewer.
 *
 * `getPublicPage` now drops non-main sections in core, but this test feeds
 * the shell a payload where a member block HAS leaked through (simulating a
 * core regression) and asserts the shell serialises none of it anywhere in
 * its element tree — the member content marker must not appear in any props,
 * and MembershipsPanel must not receive any block-content prop at all
 * (it fetches member blocks itself via the authed
 * `memberships.memberBlocks` procedure).
 *
 * The component is invoked as a plain function (server components are) and
 * the RETURNED element tree is inspected without rendering — child
 * components never execute, so this examines exactly what would be
 * serialised as props.
 */

const MEMBER_ONLY_MARKER = "MEMBER_ONLY_DISCORD_INVITE_marker";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-01T00:00:00.000Z");

function buildData(): GetPublicPageOutput {
  return {
    page: {
      id: "page-1",
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      slug: "demo-org",
      displayName: "Demo Org",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      allowFollows: true,
      showFollowerCount: false,
      category: null,
      templateAppliedCategories: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    blocks: [
      {
        id: "b-main",
        pageId: "page-1",
        kind: "about",
        orderIndex: 0,
        data: { content: "public copy" },
        visible: true,
        section: "main",
      },
      {
        // Simulated CORE REGRESSION: a member-gated block that slipped into
        // the public payload. The shell must not forward it anywhere.
        id: "b-members",
        pageId: "page-1",
        kind: "links",
        orderIndex: 1,
        data: { content: MEMBER_ONLY_MARKER },
        visible: true,
        section: "memberships",
      },
    ],
    theme: null,
    entity: {
      type: "ORGANIZATION",
      id: ORG_ID,
      name: "Demo Org",
      slug: "demo-org",
      trustTier: "STANDARD",
      trustBadgeLabel: null,
      acceptsBookingRequests: false,
    },
    communityAttribution: null,
  };
}

const TIER = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Sustaining Member",
  description: null,
  benefitsDescription: null,
  priceCents: 1000,
  currency: "usd",
  interval: "MONTH" as const,
  sortOrder: 0,
};

/** Depth-first search of a React element tree WITHOUT rendering it. */
function findElementsByType(
  node: unknown,
  type: unknown,
  out: ReactElement[] = [],
): ReactElement[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findElementsByType(child, type, out);
    return out;
  }
  const el = node as ReactElement & { props?: Record<string, unknown> };
  if ("type" in el && "props" in el) {
    if (el.type === type) out.push(el);
    for (const value of Object.values(el.props ?? {})) {
      findElementsByType(value, type, out);
    }
  }
  return out;
}

/** JSON of everything that would serialise as props, symbols dropped. */
function serializeTree(tree: unknown): string {
  return JSON.stringify(tree, (_key, value) =>
    typeof value === "symbol" ? undefined : value,
  );
}

describe("EntityPageShell — member-block RSC leak pin", () => {
  it("serialises NO member-section block content anywhere in its element tree", () => {
    const tree = EntityPageShell({
      data: buildData(),
      membershipTiers: [TIER],
    });

    expect(serializeTree(tree)).not.toContain(MEMBER_ONLY_MARKER);
  });

  it("passes MembershipsPanel no block-content prop at all", () => {
    const tree = EntityPageShell({
      data: buildData(),
      membershipTiers: [TIER],
    });

    const panels = findElementsByType(tree, MembershipsPanel);
    expect(panels).toHaveLength(1);
    const props = panels[0]!.props as Record<string, unknown>;
    // Exact prop surface — a future `memberBlocks`-style prop reintroduces
    // the leak and must fail here.
    expect(Object.keys(props).sort()).toEqual([
      "entityName",
      "ownerId",
      "ownerType",
      "tiers",
    ]);
    expect(serializeTree(props)).not.toContain(MEMBER_ONLY_MARKER);
  });

  it("still keeps member-section blocks out of the main page body (defense in depth)", () => {
    const tree = EntityPageShell({
      data: buildData(),
      membershipTiers: [],
    });

    // No tiers ⇒ no Membership tab; the overview renders directly and must
    // carry only the main-section block.
    expect(serializeTree(tree)).toContain("public copy");
    expect(serializeTree(tree)).not.toContain(MEMBER_ONLY_MARKER);
  });
});

/**
 * Entity naming split (a venue has ONE name).
 *
 * The shell resolves ONE name and hands it to `MembershipsPanel` as
 * `entityName`. The Membership tab only mounts for HUMAN and ORGANIZATION, so
 * this is exactly the arm that must KEEP preferring `page.displayName` — it is
 * still those owners' editable field. A PLACE page never reaches this prop
 * (`showMembershipTab` excludes it), so the shell's PLACE branch is not
 * observable from here; it is pinned where it is visible, in
 * `venue-one-name.test.tsx` and `to-seo-entity-page.test.ts`.
 *
 * Both fixtures below give the page a displayName that DIFFERS from the
 * entity's name, so the assertion can only pass one way round.
 */
function buildNamedData(
  ownerType: "HUMAN" | "ORGANIZATION",
  pageDisplayName: string,
  entityName: string,
): GetPublicPageOutput {
  const base = buildData();
  return {
    ...base,
    page: { ...base.page, ownerType, displayName: pageDisplayName },
    entity:
      ownerType === "HUMAN"
        ? { type: "HUMAN", id: ORG_ID, name: entityName }
        : { ...base.entity, name: entityName },
  } as GetPublicPageOutput;
}

describe("EntityPageShell — HUMAN/ORG keep the page displayName", () => {
  it("passes an ORGANIZATION's page displayName to MembershipsPanel", () => {
    const tree = EntityPageShell({
      data: buildNamedData("ORGANIZATION", "Act Name", "Registered Org LLC"),
      membershipTiers: [TIER],
    });

    const props = findElementsByType(tree, MembershipsPanel)[0]!.props as {
      entityName: string;
    };
    expect(props.entityName).toBe("Act Name");
    expect(props.entityName).not.toBe("Registered Org LLC");
  });

  it("passes a HUMAN's page displayName to MembershipsPanel", () => {
    const tree = EntityPageShell({
      data: buildNamedData("HUMAN", "Stage Name", "Legal Human Name"),
      membershipTiers: [TIER],
    });

    const props = findElementsByType(tree, MembershipsPanel)[0]!.props as {
      entityName: string;
    };
    expect(props.entityName).toBe("Stage Name");
    expect(props.entityName).not.toBe("Legal Human Name");
  });
});
