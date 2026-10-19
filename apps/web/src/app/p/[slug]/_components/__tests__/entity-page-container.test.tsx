import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// maplibre-gl (pulled in via PlaceLogisticsCard → LocationMapPreview) calls
// `URL.createObjectURL` at IMPORT time, which jsdom lacks. Nothing here
// renders a map — the tree is inspected, never rendered — so stub the module.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: () => null,
}));

import {
  EntityPageContent,
  type EntityPageContentData,
} from "../EntityPageContent";
import { HumanEntityLayout } from "../HumanEntityLayout";
import { OrgEntityLayout } from "../OrgEntityLayout";
import { PlaceEntityLayout } from "../PlaceEntityLayout";
import styles from "../entity-page-shell.module.css";

/**
 * Guard for the `entity-page` query container (venue WYSIWYG editor, R5).
 *
 * The page's layout rules are `@container entity-page (...)` queries. A
 * layout mounted WITHOUT that container silently loses every one of them (the
 * phone layout never applies, and nothing errors). EntityPageContent owns the
 * container, so every branch it picks must come out wrapped in it.
 *
 * The component is invoked as a plain function and the returned element tree
 * is inspected without rendering, so no providers or jest-dom matchers are
 * involved.
 */

type Owner = "PLACE" | "HUMAN" | "ORGANIZATION";

function buildData(type: Owner, layoutKey: string | null): EntityPageContentData {
  return {
    page: {
      id: "page-1",
      ownerType: type,
      ownerId: "owner-1",
      slug: "demo",
      displayName: "Demo",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
    },
    blocks: [],
    theme: layoutKey ? { layoutKey } : null,
    entity: {
      type,
      id: "owner-1",
      name: "Demo",
      verified: false,
      acceptsBookingRequests: false,
    },
  } as unknown as EntityPageContentData;
}

/** Call a function component and return the element it renders. */
function renderOnce(element: ReactElement): ReactElement {
  const type = element.type as (props: unknown) => ReactElement;
  return type(element.props);
}

function unwrap(data: EntityPageContentData) {
  const root = EntityPageContent({ data }) as ReactElement<{
    className?: string;
    children?: ReactElement;
  }>;
  const child = root.props.children;
  if (!isValidElement(child)) throw new Error("container has no element child");
  return { root, branch: renderOnce(child) };
}

describe("EntityPageContent: the entity-page query container", () => {
  // vitest proxies CSS modules (no `test.css.include`), so `styles.*` is a
  // name, never the CSS. Read the rule itself.
  it("declares .pageContainer as the entity-page inline-size container", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../entity-page-shell.module.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.pageContainer\s*\{([^}]*)\}/.exec(css);
    expect(rule, ".pageContainer rule").not.toBeNull();
    const decls = rule![1]!.replace(/\s+/g, " ");
    expect(decls).toMatch(/container-type:\s*inline-size\s*;/);
    expect(decls).toMatch(/container-name:\s*entity-page\s*;/);
  });

  it.each([
    ["PLACE standard", "PLACE", null, PlaceEntityLayout],
    ["HUMAN standard", "HUMAN", null, HumanEntityLayout],
    ["ORGANIZATION standard", "ORGANIZATION", null, OrgEntityLayout],
  ] as const)(
    "%s renders inside the container",
    (_label, type, layoutKey, Layout) => {
      const { root, branch } = unwrap(buildData(type, layoutKey));
      expect(root.type).toBe("div");
      expect(root.props.className).toBe(styles.pageContainer);
      expect(branch.type).toBe(Layout);
    },
  );

  it.each([
    ["PLACE", "stack"],
    ["PLACE", "grid"],
    ["HUMAN", "stack"],
    ["ORGANIZATION", "grid"],
  ] as const)("freeform %s %s renders inside the container", (type, layoutKey) => {
    const { root, branch } = unwrap(buildData(type, layoutKey));
    expect(root.props.className).toBe(styles.pageContainer);
    const freeform = branch as ReactElement<{
      className?: string;
      "data-layout"?: string;
    }>;
    expect(freeform.type).toBe("div");
    expect(freeform.props.className).toBe(styles.content);
    expect(freeform.props["data-layout"]).toBe(layoutKey);
  });
});
