import { createHash } from "node:crypto";

/**
 * Resolves WHICH image represents an event in a link preview or an email.
 *
 * Lives in `@th/types` rather than in `apps/web` because three unrelated
 * consumers need the SAME answer: the web app's `generateMetadata`, the OG
 * route that renders the fallback, and the notification renderers in `@th/core`
 * that fill `heroImageUrl` on RSVP / waitlist emails. It stays URL-agnostic —
 * every caller passes its own `baseUrl`, so this module never learns about
 * `apps/web`'s site config (or any domain).
 *
 * Deliberately NOT re-exported from the package barrel: it imports
 * `node:crypto`, and `@th/types` is also consumed by the React Native apps.
 * Import it by subpath (`@th/types/seo/eventOgImage`).
 */

export type EventOgImageInput = {
  id: string;
  /**
   * The event's CANONICAL slug — the routing key of the generated stub.
   *
   * Not `id`, even though the stub is conceptually per-event: the only public,
   * identity-free accessor in the stack (`events.getEventSeo`) is keyed by
   * slug, so an id-keyed OG route would have no way to load the event without
   * inventing a privileged read. Event slugs are MULTI-SEGMENT
   * (`org/us/general/title--ab12cd`), so the stub URL is built segment-wise and
   * the route that serves it is a catch-all.
   */
  slug: string;
  title: string;
  startsAt: Date | string | null | undefined;
  timezone?: string | null;
  updatedAt?: Date | string | null;
  images?: readonly (string | null | undefined)[] | null;
  /**
   * The PUBLIC venue label, when there is one.
   *
   * Disclosure-gated upstream (`buildEventSeo` names a venue only when it is
   * both venue-confirmed and directory-listed), so this is empty for most
   * community listings — see {@link eventStubVenueLine} for what the stub draws
   * instead.
   */
  venueName?: string | null;
  /** Public city. A RENDERED half of the stub's place line, not just a fallback. */
  city?: string | null;
  /** Public region/state. Rendered alongside `city`; see {@link eventStubVenueLine}. */
  region?: string | null;
};

export type ResolvedEventOgImage =
  | { kind: "hero"; url: string }
  | { kind: "stub"; url: string; signature: string };

/** The static poster every failure path lands on. Ships in `apps/web/public`. */
export const STATIC_OG_FALLBACK_PATH = "/og-image-v2.png";

/** Separator for the signature preimage — see `eventOgImageSignature`. */
const SIGNATURE_SEPARATOR = "\u001f";

/**
 * The LAYOUT generation of the generated stub, mixed into every signature.
 *
 * The key's job is "a stale image must never outlive a change", and a redesign
 * is such a change: without this, an event whose fields happen not to move
 * would keep serving the PREVIOUS composition's PNG from the edge and from
 * every unfurl cache that already holds its `?v=`. Bump this whenever the
 * stub's composition changes — not for a colour tweak, but for anything a
 * reader would recognise as a different card.
 *
 *   c1 — "Direction C · Date Stub": filled accent column, DOW / DD / MO,
 *        caption over title over place line, no wordmark.
 *   c2 — caption row dropped (see {@link eventStubCaption}); the body is the
 *        artifact's card HTML exactly, title over place line.
 */
const STUB_LAYOUT_VERSION = "c3";

/**
 * Normalizes a site origin into a trailing-slash-free base, or "" when it is
 * unusable.
 *
 * Rebuilds from the PARSED parts rather than just trimming slashes: a base
 * carrying a query or fragment (`https://x.com/?utm=1`) would otherwise splice
 * into `https://x.com/?utm=1/og/event/…`, which is not a URL anyone meant. Same
 * rule as `normalizeAppBaseUrl` in `@th/core`'s `public-urls`, duplicated here
 * only because `@th/types` may not import `@th/core`.
 */
const normalizeOgBaseUrl = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
};

const toIsoOrEmpty = (value: Date | string | null | undefined): string => {
  if (value === null || value === undefined) return "";
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? "" : date.toISOString();
};

/** First non-empty entry of `images`, or null. */
export const pickHeroImageUrl = (
  images: readonly (string | null | undefined)[] | null | undefined,
): string | null => {
  if (!images) return null;
  for (const candidate of images) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

/** The artifact's separator between the halves of a composed stub line. */
const STUB_SEPARATOR = " · "; // MIDDLE DOT, covered by all four OG faces.

/**
 * The single line of place text the Date Stub draws at the foot of its body.
 *
 * "Venue · City, ST" → "City, ST" → "Venue" → nothing.
 *
 * WHY BOTH HALVES. The approved artifact ("Direction C · Date Stub") sets this
 * line as `Carol Ann's · Nashville, TN` — the venue AND where it is. An earlier
 * cut treated city/region as a pure FALLBACK and drew only one of the two,
 * which is why the signature used to be allowed to ignore city/region whenever
 * a venue was named. It no longer is; see the test that flipped with this
 * change.
 *
 * WHY THE FALLBACK STILL EXISTS. `location.name` is disclosure-gated
 * server-side: a venue is named only when it is venue-confirmed AND
 * directory-listed. The population this whole feature serves — community
 * listings with no poster — is overwhelmingly at venues that are neither, so
 * the line degrades to "City, ST" rather than going blank. `city`/`region`
 * come off the SAME public payload and are already published in the page's own
 * `event:location:city` / `event:location:region` meta tags, so there is no
 * disclosure regression here.
 *
 * STRICTLY city/region. Never the street line, the postcode or coordinates —
 * those are exactly what the OBSCURED mode exists to withhold, and this string
 * lands in a publicly cached PNG that no session can vary.
 *
 * Shared by the signature and the renderer on purpose: the signature's contract
 * is "hash every input the stub renders", and a second implementation of this
 * composition is how that contract would quietly break.
 */
export const eventStubVenueLine = (
  event:
    | Pick<EventOgImageInput, "venueName" | "city" | "region">
    | null
    | undefined,
): string => {
  const name = (event?.venueName ?? "").trim();
  const city = (event?.city ?? "").trim();
  const region = (event?.region ?? "").trim();
  const place = city && region ? `${city}, ${region}` : city || region;
  if (name && place) return `${name}${STUB_SEPARATOR}${place}`;
  return name || place;
};

/**
 * The caption (kicker) above the title — DELIBERATELY INERT. Returns "" today.
 *
 * The artifact's caption idiom is `CATEGORY · VENUE`, and it appears on the
 * HERO specimen only; the card composition a 1200x630 share image actually is
 * has no caption at all, just `.t` over `.v`. So the caption is a two-part
 * idiom whose FIRST half is the category — and the category is not available
 * here. The OG route loads its event from the anonymous, identity-free
 * `events.getEventSeo` payload, which carries `seoType` (a schema.org subtype
 * like `MusicEvent`) and no human-readable category. A privileged read is not
 * an option: this artifact is served under a long shared cache with no `Vary`,
 * so nothing it draws may be answerable differently for different callers.
 * Inferring a category from the title is not an option either.
 *
 * Rendering the second half alone was tried and rejected: it is half an idiom,
 * and it degrades into a verbatim echo of the place line directly beneath it —
 * on a long venue name the same string was truncated TWICE in one frame, once
 * uppercase and once not. Omitting the row is closer to the artifact than
 * keeping a broken half of it.
 *
 * This function is kept as the EXTENSION SEAM rather than deleted. The day a
 * public category reaches that payload, composing `CATEGORY · VENUE` here and
 * rendering the row is the whole change — and because this is already a
 * component of the signature preimage (hashing to "" meanwhile), the cache key
 * starts moving with the caption on its own, with nobody having to remember to
 * come back and add it.
 */
export const eventStubCaption = (
  _event: Pick<EventOgImageInput, "venueName"> | null | undefined,
): string => "";

/**
 * The cache key of a generated Date Stub.
 *
 * Hashes EVERY input the stub renders, and — the part that matters — the hero
 * image URL as well, even though a stub is by definition rendered only when
 * there ISN'T one. That is exactly the point: when an organiser later uploads a
 * real poster, the hashed image component moves from `""` to the new URL, so
 * the signature NECESSARILY changes even if nothing else about the event moved,
 * and the old stub URL stops being the URL anyone asks for. A stale generated
 * stub outliving a real poster is the failure mode this exists to prevent.
 *
 * The key is only half the guarantee: because already-delivered emails and
 * already-posted links can never be re-scraped for the new key, the ROUTE also
 * refuses to serve a stub under an unbounded cache and redirects a stale `?v=`
 * to the current one. See the cache constants in `app/og/event/[...slug]`.
 *
 * `updatedAt` alone is NOT sufficient and must never be used alone: attaching an
 * image writes an `EventImage` row and is not guaranteed to bump
 * `Event.updatedAt`, so an updatedAt-only key would freeze the stub forever.
 *
 * Exported separately so the invalidation property is directly unit-testable.
 */
export const eventOgImageSignature = (event: EventOgImageInput): string => {
  const parts = [
    // The COMPOSITION, not an input of the event: a redesign must rotate every
    // key even for an event whose own fields never moved.
    STUB_LAYOUT_VERSION,
    toIsoOrEmpty(event?.updatedAt),
    pickHeroImageUrl(event?.images) ?? "",
    toIsoOrEmpty(event?.startsAt),
    // TRIMMED, because the renderer trims: `generateMetadata` feeds a title
    // that `mapEventToSeo` already normalized while the route feeds the raw
    // payload title, so an untrimmed preimage would let the two sides disagree
    // permanently over nothing but stray whitespace.
    (event?.title ?? "").trim(),
    // The rendered venue LINE, not the raw name — see `eventStubVenueLine`.
    eventStubVenueLine(event),
    // And the rendered CAPTION, which is "" for every event today because the
    // row is not drawn (see `eventStubCaption`). Hashing an empty string looks
    // pointless and is not: it is what makes the key move BY ITSELF on the day
    // the caption starts rendering, instead of that change silently reusing
    // every already-cached `?v=`.
    eventStubCaption(event),
  ];
  // US (U+001F) cannot appear in a URL, an ISO timestamp or a sanitized title,
  // so the join is unambiguous: ("ab", "") and ("a", "b") cannot collide.
  return createHash("sha256")
    .update(parts.join(SIGNATURE_SEPARATOR))
    .digest("hex")
    .slice(0, 16);
};

/**
 * Percent-escapes each slug segment while keeping `/` a real separator.
 *
 * `.` and `..` are dropped as well as empty segments. `.` is an UNRESERVED
 * character, so `encodeURIComponent("..")` returns `".."` untouched and a
 * traversal segment would survive into the path — harmless today only because
 * slugs are sanitized upstream, which is precisely the kind of "safe because of
 * somebody else" this function's contract ("neuters anything odd inside a
 * segment") is supposed to not depend on.
 */
export const eventOgSlugPath = (slug: string): string =>
  slug
    .split("/")
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
    .map((segment) => encodeURIComponent(segment))
    .join("/");

/**
 * PURE and TOTAL: never throws.
 *
 * Totality is load-bearing — this runs inside `generateMetadata` and inside the
 * notification renderers, where a throw costs a whole page's metadata or a whole
 * email (the renderer runs before `notify()` claims its idempotency key). Any
 * internal failure degrades to the static poster instead.
 *
 * ABSOLUTE whenever `baseUrl` is a usable http(s) origin, which is the only
 * case either real caller can produce: `apps/web` passes `getSiteUrl()`, and
 * `eventEmailImageUrl` returns early when `normalizeAppBaseUrl` rejects its
 * base. With an UNUSABLE base there is nothing to be absolute against, so the
 * degraded arm returns the root-relative static path rather than inventing an
 * origin or splicing a malformed one — the honest answer, and the previous
 * "absolute even on the degraded path" claim was false for exactly that input.
 */
export const resolveEventOgImage = (
  event: EventOgImageInput,
  baseUrl: string,
): ResolvedEventOgImage => {
  let base = "";
  try {
    base = normalizeOgBaseUrl(baseUrl);
    if (!base) throw new Error("unusable baseUrl");

    const hero = pickHeroImageUrl(event?.images);
    if (hero) {
      // Arm 1 of the chain: a real hero image always wins.
      return { kind: "hero", url: hero };
    }

    const slugPath = eventOgSlugPath(String(event?.slug ?? ""));
    if (!slugPath) throw new Error("event has no slug");

    // Arm 2: the generated Date Stub.
    const signature = eventOgImageSignature(event);
    return {
      kind: "stub",
      url: `${base}/og/event/${slugPath}?v=${signature}`,
      signature,
    };
  } catch {
    // Arm 3: never a broken image slot. Absolute whenever the base was usable;
    // see the doc comment for the one input where it cannot be.
    return { kind: "hero", url: `${base}${STATIC_OG_FALLBACK_PATH}` };
  }
};
