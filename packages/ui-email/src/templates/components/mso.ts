import { createElement, type ReactElement } from "react";

/**
 * Outlook desktop (the Word engine) ignores `max-width`, so a 600px
 * `<Container>` stretches to the full window there. The fix is a "ghost
 * table": a fixed 600px table that only MSO clients see, inside conditional
 * comments.
 *
 * React can't emit comments, and a `dangerouslySetInnerHTML` wrapper would
 * leave a `<div>` around each half (the open half's `<td>` would sit inside a
 * `<div>` that closes before the content). So the frame renders two inert
 * marker elements, and `render()` swaps them for the comments with
 * `expandMsoMarkers` right after React Email serialises the tree.
 */
const OPEN_TAG = "th-mso-ghost-open";
const CLOSE_TAG = "th-mso-ghost-close";

const OPEN_MARKER = `<${OPEN_TAG}></${OPEN_TAG}>`;
const CLOSE_MARKER = `<${CLOSE_TAG}></${CLOSE_TAG}>`;

const GHOST_OPEN =
  '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->';
const GHOST_CLOSE = "<!--[if mso]></td></tr></table><![endif]-->";

/** Place immediately before the 600px container. */
export const MsoGhostOpen = (): ReactElement => createElement(OPEN_TAG);
/** Place immediately after the 600px container. */
export const MsoGhostClose = (): ReactElement => createElement(CLOSE_TAG);

/** Replace the ghost-table markers with Outlook conditional comments. */
export const expandMsoMarkers = (html: string): string =>
  html
    .split(OPEN_MARKER)
    .join(GHOST_OPEN)
    .split(CLOSE_MARKER)
    .join(GHOST_CLOSE);
