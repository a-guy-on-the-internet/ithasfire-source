import type { FormatCallback } from "html-to-text";

/**
 * How a link reads in the derived plain-text part (`renderText` in
 * ../index.ts). By default html-to-text writes `Label [https://…]`. A link
 * that carries `data-text-link="colon"` reads `Label: https://…` instead, the
 * form the invite email's "Stop invites from <organiser>: <url>" line uses.
 */
export const TEXT_LINK_ATTR = "data-text-link";
export const TEXT_LINK_COLON = "colon";

/** The html-to-text formatter name registered for colon links. */
export const COLON_LINK_FORMAT = "colonLink";

export const COLON_LINK_SELECTOR = `a[${TEXT_LINK_ATTR}="${TEXT_LINK_COLON}"]`;

/** `Label: href`, or the bare href when the link has no text. */
export const formatColonLink: FormatCallback = (elem, walk, builder) => {
  const href = elem.attribs?.href?.replace(/^mailto:/, "") ?? "";
  if (!href) {
    walk(elem.children, builder);
    return;
  }
  let text = "";
  builder.pushWordTransform((str: string) => {
    if (str) text += str;
    return str;
  });
  walk(elem.children, builder);
  builder.popWordTransform();
  builder.addInline(text ? `: ${href}` : href, { noWordTransform: true });
};
