import type { EmbedScope } from "./embed-scope";
import { DEFAULT_EMBED_SCOPE } from "./embed-scope";
import type { EmbedView } from "./embed-view";
import { DEFAULT_EMBED_VIEW } from "./embed-view";

/**
 * Copy-paste snippet builders for the embed surfaces.
 *
 * ONE home for every snippet an organiser can copy, so the two doors onto the
 * same `embeds.list` data — the admin `EmbedsView` (all subject types) and the
 * per-venue `BookingEmbedSection` — can never drift apart. `HF_STUB_LINE` in
 * particular was previously defined twice and had to be kept byte-identical by
 * hand.
 *
 * Pure functions on purpose: no React, no state, no `getSiteUrl()` — callers
 * pass `siteUrl` in. That keeps them unit-testable (see `__tests__`).
 */

/**
 * Async-safe stub for the SDK snippets: queues `HF.createWidget` calls made
 * before the async hf-embed.js executes; the SDK drains `_q` on load. This
 * replaces the old `DOMContentLoaded` listener pattern, which raced the async
 * SDK on small pages (DOMContentLoaded fired first → "HF is not defined").
 *
 * MUST stay in sync with the queue-drain contract in
 * `apps/web/public/embed/hf-embed.js`.
 */
export const HF_STUB_LINE = `<script>window.HF=window.HF||{_q:[],createWidget:function(o){this._q.push(["createWidget",o])}};</script>`;

/** `[param, 6-char hex]` pairs, e.g. `[["brandColor", "FF5721"]]`. */
export type EmbedThemeEntries = readonly (readonly [string, string])[];

export type EmbedSnippetOptions = {
  themeEntries?: EmbedThemeEntries;
  /**
   * Which events an organization/human widget renders. `own` (the server
   * default) is OMITTED so snippets stay clean; `null`/undefined for subject
   * types that ignore scope (event / place).
   */
  scope?: EmbedScope | null;
  /**
   * Which browse view the pasted snippet PINS. `list` (the stored default for
   * every row) is OMITTED, exactly like `scope: "own"` — a snippet with no
   * `?view=` follows the embed's configured `defaultView` (FR-003), which is
   * what makes the canonical URL retargetable from the admin page.
   * `null`/undefined for surfaces with no views (the booking form).
   */
  view?: EmbedView | null;
};

/** `own` is the server default — emitting it would be noise. */
const isNonDefaultScope = (scope: EmbedScope | null | undefined): scope is EmbedScope =>
  Boolean(scope) && scope !== DEFAULT_EMBED_SCOPE;

/** `list` is the column default — emitting it would be noise (same rule as scope). */
const isNonDefaultView = (view: EmbedView | null | undefined): view is EmbedView =>
  Boolean(view) && view !== DEFAULT_EMBED_VIEW;

/**
 * Query string for a widget iframe URL — theme overrides plus a non-default
 * `scope` / `view`. Returns `""` (not `"?"`) when there is nothing to append.
 */
export function buildEmbedQueryString(options: EmbedSnippetOptions = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of options.themeEntries ?? []) params.set(key, value);
  if (isNonDefaultScope(options.scope)) params.set("scope", options.scope);
  if (isNonDefaultView(options.view)) params.set("view", options.view);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Object-literal property lines for an `HF.createWidget({...})` call, joined
 * with the trailing commas the shape needs. Building the list first (rather
 * than inlining `length > 0 ? "," : ""` per line) is what keeps the optional
 * `theme` / `scope` lines from producing a dangling comma.
 */
function widgetPropLines(
  base: readonly string[],
  options: EmbedSnippetOptions,
): string {
  const props = [...base];
  const themeEntries = options.themeEntries ?? [];
  if (themeEntries.length > 0) {
    props.push(
      `theme: { ${themeEntries.map(([k, v]) => `${k}: "${v}"`).join(", ")} }`,
    );
  }
  if (isNonDefaultScope(options.scope)) props.push(`scope: "${options.scope}"`);
  if (isNonDefaultView(options.view)) props.push(`view: "${options.view}"`);
  return props.map((line) => `    ${line}`).join(",\n");
}

// ── Tickets widget ───────────────────────────────────────────────────────────

/**
 * Canonical widget URL. `book: true` targets the "Request to book" form;
 * `memberships: true` targets the membership-tiers widget; `calendar: true`
 * targets the LEGACY /embed/calendar/ alias.
 *
 * The alias is no longer emitted by the admin page — a calendar snippet is now
 * the canonical route plus `view: "calendar"` — but the fork stays because the
 * URLs it builds are live contracts on third-party sites (FR-003), and it is
 * what `buildCalendarIframeSnippet` still pins in tests.
 */
export function buildEmbedWidgetUrl(
  siteUrl: string,
  embedId: string,
  options: EmbedSnippetOptions & {
    book?: boolean;
    memberships?: boolean;
    calendar?: boolean;
  } = {},
): string {
  const basePath = options.book
    ? "/embed/book/"
    : options.memberships
      ? "/embed/memberships/"
      : options.calendar
        ? "/embed/calendar/"
        : "/embed/";
  // `view` is a param on the CANONICAL route only: the booking form has no
  // views at all (D-004/FR-012) and the /embed/calendar/ alias already pins
  // one, so repeating it there would be noise.
  const query = buildEmbedQueryString(
    basePath === "/embed/" ? options : { ...options, view: null },
  );
  return `${siteUrl}${basePath}${embedId}${query}`;
}

export function buildTicketsIframeSnippet(args: {
  siteUrl: string;
  embedId: string;
  height: number;
  options?: EmbedSnippetOptions;
}): string {
  const { siteUrl, embedId, height, options = {} } = args;
  const src = buildEmbedWidgetUrl(siteUrl, embedId, options);
  return [
    `<iframe`,
    `  src="${src}"`,
    `  width="100%"`,
    `  height="${height}"`,
    `  style="border:none; overflow:hidden;"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin"`,
    `  allow="payment"`,
    `  title="Events"`,
    `  id="hf-embed-${embedId}"`,
    `></iframe>`,
    `<script src="${siteUrl}/embed/hf-resize.js" data-origin="${siteUrl}" async></script>`,
  ].join("\n");
}

export function buildTicketsReactSnippet(args: {
  embedId: string;
  /** Fully-built widget URL (theme + scope already applied). */
  src: string;
  height: number;
}): string {
  return [
    `export function EventsWidget() {`,
    `  return (`,
    `    <>`,
    `      <iframe`,
    `        src="${args.src}"`,
    `        width="100%"`,
    `        height={${args.height}}`,
    `        style={{ border: "none", overflow: "hidden" }}`,
    `        loading="lazy"`,
    `        allow="payment"`,
    `        title="Events"`,
    `        id="hf-embed-${args.embedId}"`,
    `      />`,
    `      {/* Include hf-resize.js on your page for auto-resize */}`,
    `    </>`,
    `  );`,
    `}`,
  ].join("\n");
}

export function buildTicketsSdkSnippet(
  siteUrl: string,
  embedId: string,
  options: EmbedSnippetOptions = {},
): string {
  return [
    HF_STUB_LINE,
    `<script src="${siteUrl}/embed/hf-embed.js" async></script>`,
    `<div id="hf-embed-${embedId}"></div>`,
    `<script>`,
    `  HF.createWidget({`,
    widgetPropLines(
      [`embedId: "${embedId}"`, `container: "#hf-embed-${embedId}"`],
      options,
    ),
    `  });`,
    `</script>`,
  ].join("\n");
}

export function buildTicketsModalSnippet(
  siteUrl: string,
  embedId: string,
  options: EmbedSnippetOptions = {},
): string {
  // A calendar-view modal opens a month grid, so "Get Tickets" would misname
  // the button. The label is a plain string in the copied snippet — organisers
  // edit it freely, and the SDK's own default is unchanged.
  const triggerText = options.view === "calendar" ? "View calendar" : "Get Tickets";
  return [
    HF_STUB_LINE,
    `<script src="${siteUrl}/embed/hf-embed.js" async></script>`,
    `<div id="hf-modal-${embedId}"></div>`,
    `<script>`,
    `  HF.createWidget({`,
    widgetPropLines(
      [
        `embedId: "${embedId}"`,
        `container: "#hf-modal-${embedId}"`,
        `mode: "modal"`,
        `triggerText: "${triggerText}"`,
      ],
      options,
    ),
    `  });`,
    `</script>`,
  ].join("\n");
}

// ── Calendar widget (legacy alias builders — retained, not emitted) ─────────
//
// The admin page emits ONE snippet set for the events embed (FR-008): the
// tickets builders, whose URL carries `?view=calendar` when the organiser
// picks Calendar. The two builders below target the /embed/calendar/ alias
// instead. They are NOT dead code: the alias URL they produce is a live
// contract already pasted on third-party sites, so it is regression-pinned
// here (and in `__tests__/embed-snippets.test.ts`) rather than deleted.

/**
 * A month grid needs more vertical room than the tickets list. Still the
 * calendar-view snippet + preview height on the admin page (there is no
 * calendar height slider — hf-resize.js takes over on the host page); the host
 * can still override the `height` attribute in the copied snippet.
 */
export const CALENDAR_DEFAULT_HEIGHT = 760;

/**
 * Calendar browse view of the widget via the LEGACY route alias: a
 * month/week calendar of the subject's events where eligible events open the
 * SAME in-iframe detail/checkout flow as the tickets widget (which is why
 * `allow="payment"` stays). hf-resize.js matches `iframe[src*="/embed/"]`, so
 * `/embed/calendar/…` auto-resizes with the same script line as the tickets
 * iframe.
 */
export function buildCalendarIframeSnippet(args: {
  siteUrl: string;
  embedId: string;
  height: number;
  options?: EmbedSnippetOptions;
}): string {
  const { siteUrl, embedId, height, options = {} } = args;
  const src = buildEmbedWidgetUrl(siteUrl, embedId, {
    ...options,
    calendar: true,
  });
  return [
    `<iframe`,
    `  src="${src}"`,
    `  width="100%"`,
    `  height="${height}"`,
    `  style="border:none; overflow:hidden;"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin"`,
    `  allow="payment"`,
    `  title="Events calendar"`,
    `  id="hf-embed-${embedId}"`,
    `></iframe>`,
    `<script src="${siteUrl}/embed/hf-resize.js" data-origin="${siteUrl}" async></script>`,
  ].join("\n");
}

/** React form of the legacy-alias calendar iframe (see above — not emitted). */
export function buildCalendarReactSnippet(args: {
  embedId: string;
  /** Fully-built calendar widget URL (theme + scope already applied). */
  src: string;
  height: number;
}): string {
  return [
    `export function EventsCalendarWidget() {`,
    `  return (`,
    `    <>`,
    `      <iframe`,
    `        src="${args.src}"`,
    `        width="100%"`,
    `        height={${args.height}}`,
    `        style={{ border: "none", overflow: "hidden" }}`,
    `        loading="lazy"`,
    `        allow="payment"`,
    `        title="Events calendar"`,
    `        id="hf-embed-${args.embedId}"`,
    `      />`,
    `      {/* Include hf-resize.js on your page for auto-resize */}`,
    `    </>`,
    `  );`,
    `}`,
  ].join("\n");
}

// ── Memberships widget ───────────────────────────────────────────────────────

/**
 * Starting height for the inline memberships iframe before hf-resize.js takes
 * over — a single row of tier cards plus the header. Same drift-proofing as
 * `BOOKING_FORM_DEFAULT_HEIGHT`: the admin preview imports this too.
 */
export const MEMBERSHIPS_DEFAULT_HEIGHT = 480;

/**
 * Inline membership-tiers widget: the owner's ACTIVE tiers with a Join CTA
 * that opens `/p/<slug>?tab=memberships` in a new top-level tab. There is
 * deliberately no in-iframe join (subscriptions need the first-party
 * context), so like the booking form it takes no payment and omits
 * `allow="payment"`; `scope`/`view` are meaningless for a memberships subject
 * and never passed. hf-resize.js matches `iframe[src*="/embed/"]`, so
 * `/embed/memberships/…` auto-resizes with the same script line.
 */
export function buildMembershipsIframeSnippet(args: {
  siteUrl: string;
  embedId: string;
  height: number;
  options?: Omit<EmbedSnippetOptions, "scope" | "view">;
}): string {
  const { siteUrl, embedId, height, options = {} } = args;
  const src = buildEmbedWidgetUrl(siteUrl, embedId, {
    memberships: true,
    themeEntries: options.themeEntries,
  });
  return [
    `<iframe`,
    `  src="${src}"`,
    `  width="100%"`,
    `  height="${height}"`,
    `  style="border:none; overflow:hidden;"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin"`,
    `  title="Membership"`,
    `  id="hf-embed-${embedId}"`,
    `></iframe>`,
    `<script src="${siteUrl}/embed/hf-resize.js" data-origin="${siteUrl}" async></script>`,
  ].join("\n");
}

// ── Booking widget ───────────────────────────────────────────────────────────

/**
 * Starting height for the inline booking iframe before hf-resize.js takes
 * over. The admin preview imports this too, so the frame an organiser sees
 * and the snippet they copy can't drift apart.
 */
export const BOOKING_FORM_DEFAULT_HEIGHT = 560;

/**
 * The "Request to book" button. Booking ships two variants: this modal
 * trigger, and `buildBookingIframeSnippet` for placing the form inline in
 * the host page.
 *
 * `scope` is not accepted — it is meaningless for a `place` subject (the
 * server ignores it), so offering it here would be a lie.
 */
export function buildBookingSnippet(
  siteUrl: string,
  embedId: string,
  options: Omit<EmbedSnippetOptions, "scope"> = {},
): string {
  return [
    HF_STUB_LINE,
    `<script src="${siteUrl}/embed/hf-embed.js" async></script>`,
    `<div id="hf-book-${embedId}"></div>`,
    `<script>`,
    `  HF.createWidget({`,
    widgetPropLines(
      [
        `embedId: "${embedId}"`,
        `container: "#hf-book-${embedId}"`,
        `widget: "booking"`,
        `mode: "modal"`,
        `triggerText: "Request to book"`,
      ],
      { themeEntries: options.themeEntries },
    ),
    `  });`,
    `</script>`,
  ].join("\n");
}

/**
 * Inline variant: the booking form sits directly in the host page. The form
 * takes no payment, so `allow="payment"` is omitted; `scope` is never passed
 * (see `buildBookingSnippet`). hf-resize.js matches `iframe[src*="/embed/"]`,
 * so `/embed/book/…` auto-resizes with the same script line as the tickets
 * iframe.
 */
export function buildBookingIframeSnippet(args: {
  siteUrl: string;
  embedId: string;
  height: number;
  options?: Omit<EmbedSnippetOptions, "scope">;
}): string {
  const { siteUrl, embedId, height, options = {} } = args;
  const src = buildEmbedWidgetUrl(siteUrl, embedId, {
    book: true,
    themeEntries: options.themeEntries,
  });
  return [
    `<iframe`,
    `  src="${src}"`,
    `  width="100%"`,
    `  height="${height}"`,
    `  style="border:none; overflow:hidden;"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin"`,
    `  title="Request to book"`,
    `  id="hf-embed-${embedId}"`,
    `></iframe>`,
    `<script src="${siteUrl}/embed/hf-resize.js" data-origin="${siteUrl}" async></script>`,
  ].join("\n");
}
