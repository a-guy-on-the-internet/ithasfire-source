import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import { fail } from "@th/errors";
import {
  isSafeThemeColor,
  THEME_COLOR_MAX_LENGTH,
} from "../../lib/theme-color";
import {
  entityPageFontKeyInputSchema,
  entityPageFontKeySchema,
  entityPageLayoutKeyInputSchema,
  entityPageLayoutKeySchema,
  normalizeEntityPageFontKey,
  normalizeEntityPageLayoutKey,
} from "./theme-options";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
} from "./entity-page-access";

// ── Schemas ────────────────────────────────────────────────────────────────

const pageOwnerTypeSchema = z.enum(["HUMAN", "ORGANIZATION", "PLACE"]);

/**
 * A theme colour: trimmed, at most 50 characters, and CSS colour syntax only
 * (hex, rgb()/rgba()/hsl()/hsla(), or a colour keyword; see
 * `lib/theme-color.ts`). The public page writes the value into an inline CSS
 * custom property, so anything wider is CSS injection. The page editor's
 * draft ops validate theme colours through this schema too (via
 * `updatePageThemeInputSchema.shape`).
 *
 * The message is a sentence because the web formatter shows a Zod issue's
 * message as is ("Please fix the following: colorBg: …").
 */
export const themeColorSchema = z
  .string()
  .trim()
  .max(THEME_COLOR_MAX_LENGTH)
  .refine(isSafeThemeColor, {
    message:
      "Enter a color as a hex code (#6366f1), rgb()/hsl() with plain numbers, or a color name",
  });

export const updatePageThemeInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: pageOwnerTypeSchema,
    ownerId: z.string().min(1),
    colorPrimary: themeColorSchema.nullable().optional(),
    colorBg: themeColorSchema.nullable().optional(),
    colorText: themeColorSchema.nullable().optional(),
    fontKey: entityPageFontKeyInputSchema.optional(),
    layoutKey: entityPageLayoutKeyInputSchema.optional(),
  })
  .strict();

export const updatePageThemeOutputSchema = z
  .object({
    theme: z.object({
      id: z.string(),
      pageId: z.string(),
      colorPrimary: z.string().nullable(),
      colorBg: z.string().nullable(),
      colorText: z.string().nullable(),
      fontKey: entityPageFontKeySchema.nullable(),
      layoutKey: entityPageLayoutKeySchema.nullable(),
    }),
  })
  .strict();

export type UpdatePageThemeInput = z.infer<typeof updatePageThemeInputSchema>;
export type UpdatePageThemeOutput = z.infer<typeof updatePageThemeOutputSchema>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type UpdatePageThemeDeps = {
  /**
   * `places`, `events` and `tx` serve the community moderator path only
   * (access rules, the claim-lock re-check and the audit row).
   */
  repos: Pick<Repos, "entityPages" | "authz" | "places" | "events" | "tx">;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function updatePageTheme(
  deps: UpdatePageThemeDeps,
  rawInput: unknown,
): Promise<UpdatePageThemeOutput> {
  const logger = deps.logger?.child({ useCase: "updatePageTheme" });

  const execute = async (): Promise<UpdatePageThemeOutput> => {
    const input = parseInput(updatePageThemeInputSchema, rawInput);

    const editor = await resolveEntityPageEditor(deps, input);

    const page = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    const themeChange = {
      pageId: page.id,
      ...(input.colorPrimary !== undefined && {
        colorPrimary: input.colorPrimary,
      }),
      ...(input.colorBg !== undefined && { colorBg: input.colorBg }),
      ...(input.colorText !== undefined && { colorText: input.colorText }),
      ...(input.fontKey !== undefined && { fontKey: input.fontKey }),
      ...(input.layoutKey !== undefined && { layoutKey: input.layoutKey }),
    };

    // The owner writes as before; a community moderator writes under the
    // place's claim lock, re-checked, with the audit row in the same tx.
    const theme =
      editor.kind === "owner"
        ? await deps.repos.entityPages.upsertTheme(themeChange)
        : await deps.repos.tx(async (tx) => {
            const now = deps.clock.now();
            await recheckCommunityPageEditor(tx, editor, now);
            const before = await tx.entityPages.getTheme(page.id);
            const written = await tx.entityPages.upsertTheme(themeChange);
            const from = before ? themeAuditSnapshot(before) : null;
            const to = themeAuditSnapshot(written);
            await logCommunityPageUpdate(
              tx,
              editor,
              {
                actorHumanId: input.actorHumanId,
                pageId: page.id,
                op: "updatePageTheme",
                fields: (Object.keys(to) as (keyof typeof to)[])
                  .filter((key) => (from?.[key] ?? null) !== to[key])
                  .map((key) => `theme.${key}`),
                from,
                to,
              },
              now,
            );
            return written;
          });

    return updatePageThemeOutputSchema.parse({
      theme: {
        ...theme,
        fontKey: normalizeEntityPageFontKey(theme.fontKey),
        layoutKey: normalizeEntityPageLayoutKey(theme.layoutKey),
      },
    });
  };

  if (logger) {
    return logger.withTime("updatePageTheme", execute);
  }
  return execute();
}

// ── Audit helper ───────────────────────────────────────────────────────────

function themeAuditSnapshot(theme: {
  colorPrimary: string | null;
  colorBg: string | null;
  colorText: string | null;
  fontKey: string | null;
  layoutKey: string | null;
}) {
  return {
    colorPrimary: theme.colorPrimary,
    colorBg: theme.colorBg,
    colorText: theme.colorText,
    fontKey: theme.fontKey,
    layoutKey: theme.layoutKey,
  };
}
