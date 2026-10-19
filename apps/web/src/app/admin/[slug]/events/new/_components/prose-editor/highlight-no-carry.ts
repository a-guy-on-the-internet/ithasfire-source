import Highlight from "@tiptap/extension-highlight";

/**
 * Highlight without carry-over: Enter at the end of highlighted text starts
 * the next block plain. Tiptap re-applies a mark across a split when its
 * `keepOnSplit` is true (the default); Link already sets it false. Bold,
 * italic, underline and strike keep the default and still carry over, which
 * is what word processors do with them; a highlight is a callout for one
 * phrase, and carrying it into the next block painted a whole new heading.
 *
 * Editing behaviour only: the saved mark and its HTML are the same, so
 * prose-utils' `generateHTML` keeps the stock extension.
 */
export const HighlightNoCarry = Highlight.extend({ keepOnSplit: false });
