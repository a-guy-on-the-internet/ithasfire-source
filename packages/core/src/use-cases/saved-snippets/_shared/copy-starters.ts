import type { TxRepos } from "@th/ports/repos";
import type { SavedSnippetListKey } from "@th/types/repos/saved-snippets";
import { SAVED_SNIPPETS_MAX_PER_KIND } from "@th/types/repos/saved-snippets";

import {
  DEFAULT_STARTER_LOCALE,
  starterSnippetsFor,
  toStarterLocale,
  type StarterLocale,
} from "./starter-reasons";

export type CopyStartersTxRepos = Pick<TxRepos, "savedSnippets" | "humans" | "audit">;

/**
 * Take the (owner, kind) list's lock and, the first time the list is ever
 * used, copy the platform starters into it (FR-013). MUST run inside
 * `repos.tx()` and FIRST in it — every later read in the transaction (the
 * cap count, the list) then sees the list the caller is about to write.
 *
 * Once `startersCopiedAt` is stamped it is never cleared (only account
 * erasure deletes the list row), so deleting every reason never brings the
 * starters back.
 *
 * Locale: the caller's `requestedLocale` (the UI's), else the actor's stored
 * `Human.locale`, else English. The stored locale is read only when a copy
 * actually happens.
 *
 * Starters land AFTER anything already in the list and never push it past
 * the cap. (Through the use cases a list is empty until its starters are
 * copied, because create copies first; the guard is for rows written any
 * other way.)
 */
export async function lockListAndCopyStarters(
  tx: CopyStartersTxRepos,
  args: {
    key: SavedSnippetListKey;
    actorHumanId: string;
    requestedLocale?: StarterLocale | null;
    now: Date;
  },
): Promise<{ copied: number }> {
  const { key, actorHumanId, now } = args;
  const state = await tx.savedSnippets.lockList(key);
  if (state.startersCopiedAt) return { copied: 0 };

  const locale =
    args.requestedLocale ??
    toStarterLocale((await tx.humans.getById(actorHumanId))?.locale) ??
    DEFAULT_STARTER_LOCALE;

  const existing = await tx.savedSnippets.listByOwner(key);
  const room = Math.max(0, SAVED_SNIPPETS_MAX_PER_KIND - existing.length);
  const starters = starterSnippetsFor(key.kind, locale).slice(0, room);
  const base = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;

  // Sequential: `tx` is an interactive-transaction client.
  for (let i = 0; i < starters.length; i += 1) {
    await tx.savedSnippets.create({
      ...key,
      label: starters[i]!.label,
      body: starters[i]!.body,
      sortOrder: base + i,
      isStarter: true,
    });
  }
  await tx.savedSnippets.markStartersCopied(key, now);
  await tx.audit.log({
    entity: "saved_snippet_list",
    entityId: null,
    action: "saved_snippets.starters_copied",
    data: {
      actorHumanId,
      ownerType: key.ownerType,
      ownerId: key.ownerId,
      kind: key.kind,
      locale,
      count: starters.length,
    },
    at: now,
  });
  return { copied: starters.length };
}
