import type { ComponentType } from "react";

/**
 * One entry of the block insert menu (the "/" menu and the "+" button).
 *
 * `run` is the SAME handler the toolbar's button calls for that block, built
 * by ProseEditor, so a block inserted from the menu goes through the same
 * upload, URL prompt and command as one inserted from the toolbar.
 */
export type InsertMenuItem = {
  id: string;
  /** Shown, in the reader's language. */
  label: string;
  /**
   * The English label and a few aliases ("h1", "photo", "youtube"). Matched
   * as well as the label, so "/head" finds Encabezado in the Spanish UI too.
   */
  aliases: readonly string[];
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  run: () => void;
};

/** Lower-cased, accents stripped: "Línea" and "linea" are the same word. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * The items whose label or aliases match `query`, best first: a word that
 * STARTS with the query ranks above one that merely contains it, and the
 * menu's own order breaks ties. An empty query matches everything.
 */
export function filterInsertItems<T extends Pick<InsertMenuItem, "label" | "aliases">>(
  items: readonly T[],
  query: string,
): T[] {
  const q = fold(query.trim());
  if (!q) return [...items];
  const ranked: Array<{ item: T; rank: number; order: number }> = [];
  items.forEach((item, order) => {
    const words = [item.label, ...item.aliases]
      .map(fold)
      .flatMap((text) => [text, ...text.split(/[\s-]+/)]);
    const rank = words.some((w) => w.startsWith(q))
      ? 0
      : words.some((w) => w.includes(q))
        ? 1
        : -1;
    if (rank >= 0) ranked.push({ item, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.map((entry) => entry.item);
}

/** The DOM id of option `index` in the listbox `listboxId`. */
export function insertOptionId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}
