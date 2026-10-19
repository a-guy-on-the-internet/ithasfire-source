import { describe, expect, it, vi } from "vitest";

import { themeColorSchema, updatePageTheme } from "../update-page-theme";
import type { UpdatePageThemeDeps } from "../update-page-theme";
import {
  ENTITY_PAGE_FONT_KEYS,
  ENTITY_PAGE_LAYOUT_KEYS,
} from "../theme-options";

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTOR_ID = "human-1";

const EXISTING_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: ACTOR_ID,
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

const DEFAULT_THEME = {
  id: "theme-1",
  pageId: "page-1",
  colorPrimary: null,
  colorBg: null,
  colorText: null,
  fontKey: null,
  layoutKey: null,
};

function makeDeps(
  overrides?: Partial<{
    entityPages: Record<string, any>;
    canManagePlaceResult: { allowed: boolean };
  }>,
): UpdatePageThemeDeps {
  return {
    repos: {
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        upsertTheme: vi.fn(async (data: any) => ({
          ...DEFAULT_THEME,
          ...data,
        })),
        ...overrides?.entityPages,
      },
      authz: {},
    } as any,
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(async () => {}),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(
        async () => overrides?.canManagePlaceResult ?? { allowed: true },
      ),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("updatePageTheme", () => {
  it("upserts theme with provided color values", async () => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      colorPrimary: "#ff5500",
      colorBg: "#000000",
    });

    expect(result.theme.colorPrimary).toBe("#ff5500");
    expect(result.theme.colorBg).toBe("#000000");
    expect(result.theme.pageId).toBe("page-1");
  });

  it("upserts theme with font and layout keys", async () => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      fontKey: "montserrat",
      layoutKey: "grid",
    });

    expect(result.theme.fontKey).toBe("montserrat");
    expect(result.theme.layoutKey).toBe("grid");
  });

  it.each(ENTITY_PAGE_FONT_KEYS)("accepts font key %s", async (fontKey) => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      fontKey,
      layoutKey: "stack",
    });

    expect(result.theme.fontKey).toBe(fontKey);
    expect(result.theme.layoutKey).toBe("stack");
  });

  it.each(ENTITY_PAGE_LAYOUT_KEYS)(
    "accepts layout key %s",
    async (layoutKey) => {
      const deps = makeDeps();

      const result = await updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        layoutKey,
      });

      expect(result.theme.layoutKey).toBe(layoutKey);
    },
  );

  it("normalizes font and layout keys", async () => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      fontKey: " Serif ",
      layoutKey: " GRID ",
    });

    expect(result.theme.fontKey).toBe("serif");
    expect(result.theme.layoutKey).toBe("grid");
  });

  it("rejects unknown font keys", async () => {
    const deps = makeDeps();

    await expect(
      updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        fontKey: "not-a-font",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(deps.repos.entityPages.upsertTheme).not.toHaveBeenCalled();
  });

  it("rejects unknown layout keys", async () => {
    const deps = makeDeps();

    await expect(
      updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        layoutKey: "masonry",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(deps.repos.entityPages.upsertTheme).not.toHaveBeenCalled();
  });

  it("clears a field when explicitly set to null", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        upsertTheme: vi.fn(async (data: any) => ({
          ...DEFAULT_THEME,
          colorPrimary: "#ff0000",
          ...data,
        })),
      },
    });

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      colorPrimary: null,
    });

    expect(result.theme.colorPrimary).toBeNull();
  });

  it("throws not_found when page does not exist", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => null),
        upsertTheme: vi.fn(),
      },
    });

    await expect(
      updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        colorPrimary: "#000",
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("throws forbidden when human tries to edit another human's theme", async () => {
    const deps = makeDeps();

    await expect(
      updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: "other-human",
        colorPrimary: "#000",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("calls requireOrgRole for ORGANIZATION pages", async () => {
    const orgPage = {
      ...EXISTING_PAGE,
      ownerType: "ORGANIZATION" as const,
      ownerId: "org-1",
    };
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => orgPage),
        upsertTheme: vi.fn(async (data: any) => ({
          ...DEFAULT_THEME,
          ...data,
        })),
      },
    });

    await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      colorPrimary: "#123456",
    });

    expect(deps.authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        orgId: "org-1",
      }),
    );
  });

  it("throws forbidden when PLACE access is denied", async () => {
    const deps = makeDeps({ canManagePlaceResult: { allowed: false } });

    await expect(
      updatePageTheme(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
        colorPrimary: "#123456",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(deps.repos.entityPages.upsertTheme).not.toHaveBeenCalled();
  });
});

// Theme colours are written into inline CSS custom properties on the public
// page, so only CSS colour syntax may be stored (security review 2026-10-08).
describe("updatePageTheme: colour grammar", () => {
  const VALID = [
    "#fff",
    "#FFFA",
    "#6366f1",
    "#6366F1CC",
    "rgb(99, 102, 241)",
    "rgb(99 102 241)",
    "rgba(99, 102, 241, 0.5)",
    "rgb(99 102 241 / 50%)",
    "hsl(239, 84%, 67%)",
    "hsl(239deg 84% 67%)",
    "hsla(239, 84%, 67%, .5)",
    "rebeccapurple",
    "transparent",
    "burlywood",
    "Red",
  ];

  const HOSTILE = [
    "url(https://evil.example/p.gif)",
    "red;position:fixed;inset:0;z-index:2147483647",
    "red;",
    "color:red",
    "var(--th-color-primary)",
    "rgb(var(--x))",
    "rgb(0 0 0);background:url(x)",
    "calc(1px + 2px)",
    "expression(alert(1))",
    "\\72 ed",
    '"red"',
    "'red'",
    "red}body{display:none",
    "{red}",
    "</style><script>alert(1)</script>",
    "<b>",
    "#ggg",
    "#12345",
    "red blue",
    "rgb()",
    "",
    "   ",
    "a".repeat(51),
  ];

  it.each(VALID)("accepts %s", async (color) => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      colorPrimary: color,
      colorBg: color,
      colorText: color,
    });

    expect(result.theme.colorPrimary).toBe(color);
    expect(deps.repos.entityPages.upsertTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        colorPrimary: color,
        colorBg: color,
        colorText: color,
      }),
    );
  });

  it("trims a colour before checking and storing it", async () => {
    const deps = makeDeps();

    const result = await updatePageTheme(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      colorBg: "  #6366f1 ",
    });

    expect(result.theme.colorBg).toBe("#6366f1");
  });

  for (const field of ["colorPrimary", "colorBg", "colorText"] as const) {
    it.each(HOSTILE)(`refuses ${field} = %j and writes nothing`, async (color) => {
      const deps = makeDeps();

      await expect(
        updatePageTheme(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          [field]: color,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(deps.repos.entityPages.upsertTheme).not.toHaveBeenCalled();
    });
  }

  it("names the colour syntax in the refusal message", () => {
    const parsed = themeColorSchema.safeParse("url(https://evil.example/p.gif)");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/hex code/);
  });
});

