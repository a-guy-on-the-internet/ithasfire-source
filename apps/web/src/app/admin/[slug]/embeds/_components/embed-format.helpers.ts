// One Inline / Button choice for the events embed, and the resize note that is
// true for the snippet on screen.
//
// The preview's Display control and the code card's format switcher used to be
// two independent controls, so the preview could show a "Get Tickets" button
// while the code under it was an inline iframe. Both now read ONE format value
// held by EmbedsView; these pure maps keep the two controls in step.

/** The events embed's code formats. html / react / sdk all render inline. */
export type SnippetFormat = "html" | "react" | "sdk" | "modal";

/** What the preview's Display control shows for the events embed. */
export type EventsDisplay = "inline" | "modal";

/** The Display value a code format implies: only Modal is a button. */
export function displayForFormat(format: SnippetFormat): EventsDisplay {
  return format === "modal" ? "modal" : "inline";
}

/**
 * The code format a Display pick selects. Inline lands on HTML, the default
 * paste-anywhere snippet; Button is the Modal snippet. (SegmentedControl only
 * fires on a real change, so picking Inline while React or SDK is showing
 * never happens — Inline is already selected then.)
 */
export function formatForDisplay(display: EventsDisplay): SnippetFormat {
  return display === "modal" ? "modal" : "html";
}

/**
 * Which resize note is true for the snippet on screen:
 * - `hfResize`: an inline iframe snippet that ships the hf-resize.js line
 *   (events HTML in either view, the inline booking form, memberships). The
 *   frame grows to fit on the host page as long as that line stays.
 * - `sdk`: hf-embed.js sizes the frame itself (no `height` option is passed,
 *   so it auto-resizes from a 600px start).
 * - `fixedReact`: the React snippet has NO hf-resize.js line, so the frame
 *   keeps its starting height unless the host adds the script.
 * - `null`: a button that opens a window (events Modal, the booking button) —
 *   there is no frame on the page to size.
 */
export type ResizeNote = "hfResize" | "sdk" | "fixedReact" | null;

export function resizeNoteFor(args: {
  variant: "events" | "booking" | "memberships";
  format: SnippetFormat;
  bookingMode: "modal" | "inline";
}): ResizeNote {
  if (args.variant === "booking")
    return args.bookingMode === "inline" ? "hfResize" : null;
  if (args.variant === "memberships") return "hfResize";
  switch (args.format) {
    case "html":
      return "hfResize";
    case "sdk":
      return "sdk";
    case "react":
      return "fixedReact";
    case "modal":
    default:
      return null;
  }
}

/**
 * Typed domain input → the bare lowercase hostname the server stores.
 *
 * MIRRORS the server's two steps, in order: the upsert input schema's
 * `.trim()` + `.toLowerCase()` on `domain`
 * (packages/core/src/use-cases/embeds/upsert-embed.ts), then
 * `coerceEmbedDomainToHostname` in
 * packages/core/src/use-cases/embeds/_shared/embed-domain.ts. The lowercase
 * step matters: `URL` only lowercases hosts of special schemes (http, https…),
 * so "myapp://Foo.com" keeps its capitals without it. Mirrored, not imported:
 * that module is
 * core-internal (`_shared`, not exported from `@th/core`), and the UI layer
 * talks to core through tRPC. Keep the two in step; the server stays the
 * authority, this only lets the page recognise a domain it already lists.
 */
export function normaliseEmbedDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const hostname = new URL(candidate).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Whether typed input names a domain the subject already lists as ACTIVE.
 * Upsert is by (subject, hostname), so "https://Foo.com/" re-adding a listed
 * "foo.com" EDITS that row — the caller must then not seed view config onto
 * it.
 *
 * REVOKED rows don't count: the upsert reactivates a revoked row (the prisma
 * embeds adapter writes `status: "ACTIVE"`), and it should come back with the
 * view config the page shows now, not the one stored when it was revoked. So
 * a revoked domain is treated as new and the caller sends the view fields.
 */
export function isDomainAlreadyListed(
  typed: string,
  listed: readonly { domain: string; status?: string }[],
): boolean {
  const host = normaliseEmbedDomain(typed);
  if (!host) return false;
  return listed.some(
    (embed) =>
      (embed.status ?? "ACTIVE") === "ACTIVE" &&
      (normaliseEmbedDomain(embed.domain) ?? embed.domain) === host,
  );
}

/**
 * Step 2's "✓ <domain> can show the widget" line: the last domain added, but
 * only under the subject it was added to, and only while that row is still
 * ACTIVE (a revoke right after an add must not leave the line behind).
 */
export function confirmedDomainFor(
  lastAdded: { subjectKey: string; domain: string } | null,
  subjectKey: string | null,
  activeEmbeds: readonly { domain: string }[],
): string | null {
  if (!lastAdded) return null;
  if (lastAdded.subjectKey !== subjectKey) return null;
  return activeEmbeds.some((e) => e.domain === lastAdded.domain)
    ? lastAdded.domain
    : null;
}
