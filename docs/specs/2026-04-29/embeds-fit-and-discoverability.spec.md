# Media embeds — fit, fallback, discoverability, and a slash menu

> Not built yet (2026-10-08 docs consolidation): Bandcamp oEmbed lookup, link-card/lightbox mode, slash menu

**Date:** 2026-04-29
**Status:** draft (revised after first review)
**Priority:** P2 (visible quality)
**Depends on:** existing `mediaEmbed` ProseMirror node, `MediaEmbedRenderer`, `useHydrateMediaEmbeds`, `parse-embed-url`, `providers.ts`
**Supersedes:** N/A

---

## Problem

Three real complaints from organizers using the EventBuilder rich-text editor:

1. **Embeds occupy too much vertical space.** Spotify/Apple Music iframes are sized via CSS `aspect-ratio` (`1/1` for Spotify, `4/5` for Apple Music albums) which makes a single track render as a square the width of the column — far taller than the iframe's intrinsic ~150 px player. Looks bloated and amateur.
2. **Bandcamp "breaks."** Pasting a Bandcamp URL produces a static link card, not an interactive player. The renderer falls back to `renderMode: "link"` because Bandcamp's *public* URLs don't expose the numeric player id needed for an iframe (`packages/core/src/lib/embeds/providers.ts:79-88`). Behavior is correct per the comment, but disappointing — users expect a player.
3. **The "Insert media embed" toolbar button is undiscoverable.** Generic `<Video size={18} />` icon at `apps/web/src/app/admin/[slug]/events/new/_components/prose-editor/ProseEditor.tsx:1037`, sitting next to Image and Audio buttons, with no label and a hover-only tooltip. Help text appears only after the user has already clicked the button.

Plus a deeper observation surfaced during review: **inline iframes may not be the right default at all.** A heavy iframe block (provider JS, fixed height, breaks reading flow) for what's often a one-off "here's our trailer" link is hamfisted. A clean link card that pops open a lightbox player on click would be lighter, more on-style (Swiss content), and avoid all the per-provider sizing fuss.

## Goals

- Each iframe-mode embed renders close to its provider's intended pixel size.
- Bandcamp produces an interactive player from any public URL.
- Toolbar button is visually distinct and reachable via slash menu + keyboard shortcut.
- Build a real slash command menu (the editor has none today; it should).
- Ship a "link-card → click-to-play lightbox" mode and make it the default for non-video embeds.

## Context

| Surface | File |
|---|---|
| Provider config (defaults, `renderMode`, kind→aspect) | `packages/core/src/lib/embeds/providers.ts:34-118` |
| URL parser (Bandcamp, etc.) | `packages/core/src/lib/embeds/parse-embed-url.ts` (Bandcamp at 341-371) |
| Editor node view | `apps/web/src/app/admin/[slug]/events/new/_components/prose-editor/extensions/MediaEmbedNodeView.tsx` |
| Renderer (React, with header chrome) | `apps/web/src/components/embeds/MediaEmbed.tsx:120-181` |
| Server hydration (static HTML → iframe) | `apps/web/src/components/embeds/useHydrateMediaEmbeds.tsx` |
| Toolbar entry + insert bar | `apps/web/src/app/admin/[slug]/events/new/_components/prose-editor/ProseEditor.tsx:1035-1179` |
| Aspect-ratio refine (Zod) | `packages/schema/src/index.ts:484+` |
| OG image fetch infra | TBD — confirm whether we already have a link-preview/scrape pipeline before designing C |

## Design

### A. Per-provider×kind sizing — fixed pixel heights for audio, aspect-ratio only for video

Replace `aspect-ratio` CSS with `height` for non-video providers. Add a `height` field to `ProviderConfig` and a `heightFor(provider, kind)` helper alongside `aspectRatioFor(...)`.

| Provider | Kind | Sizing |
|---|---|---|
| Spotify | track | 152 px height |
| Spotify | album, playlist, show, episode | 352 px height |
| Apple Music | song | 175 px height |
| Apple Music | music-video | **16:9 aspect-ratio** (it's a video) |
| Apple Music | album, playlist | 450 px height |
| SoundCloud | track | 166 px height |
| SoundCloud | playlist, set | 450 px height |
| YouTube, Vimeo | (any) | 16:9 aspect-ratio |
| Bandcamp | (any) | 470 px height (when iframe path lands — see B) |

**Override stored `aspectRatio`:** new fixed heights always win. We'll see how saved content looks; assume it's better.

### B. Bandcamp — server-side oEmbed lookup on URL paste

Don't ask users to fish iframe URLs out of their dashboard. Bandcamp publishes an **oEmbed endpoint** at `https://bandcamp.com/oembed?url=<public-url>&format=json` that returns the iframe HTML for any public album/track/video URL. Use it.

Flow:

1. User pastes a public Bandcamp URL into the insert bar.
2. Server-side action (tRPC mutation) calls Bandcamp oEmbed.
3. Parse the iframe `src` from the response (`<iframe src="https://bandcamp.com/EmbeddedPlayer/album=NNN/...">`).
4. Store the canonical EmbeddedPlayer URL as `embedUrl` and set `renderMode: "iframe"`.
5. Renderer uses the stored URL.

This avoids client-side scraping (CORS) and keeps the parser deterministic. Falls back to a link card if oEmbed returns 404 (deleted/private content).

`parseBandcamp` becomes async-capable, or we add a sibling `resolveBandcamp` use case that runs after `parseEmbedUrl` and upgrades `renderMode: "link"` → `"iframe"` for Bandcamp.

### C. Link-card-with-lightbox as default render mode

Today: every iframe-mode embed renders an inline iframe immediately. Heavy, intrusive, breaks the Swiss-content reading flow.

Proposed default for non-video providers (Spotify, Apple Music, SoundCloud, Bandcamp):

- **Inline:** clean link card — provider tinted left border, small play icon, title, "Play on Spotify"-style label. Strict-Swiss compatible: hard borders, no shadows, monochrome with provider accent only on the play affordance.
- **Click → lightbox:** opens a centered modal with the real iframe at the provider's intended height. Close on ESC / backdrop click.
- **Optional escape hatch:** an editor-side toggle "Show inline player instead of card" for events where the artist *wants* the autoplay-friendly inline player (gallery pages, EPKs).

Video providers (YouTube, Vimeo) **stay inline** — that's the natural shape of video.

This collapses the "Bandcamp link card vs Spotify iframe" inconsistency. Both behave the same way: card inline, player on click.

OG image fetch: confirm whether existing infra exists (probably yes via link-preview blocks). If yes, reuse for card thumbnail (album art / video poster). If not, scope C minimum to colored card without thumbnail and defer image fetch infra to a follow-up.

### D. Toolbar discoverability + slash menu

**Icon swap.** `<Video />` → `<Link2 />`. Different shape from Image and Audio buttons. Tooltip says "Embed link · ⌘⇧E".

**Keyboard shortcut.** `Cmd/Ctrl+Shift+E` opens the insert bar.

**New: slash command menu.** The editor has none today; this spec carries adding it. Implementation:

- Add a ProseMirror `Suggestion` plugin (or TipTap `@tiptap/extension-mention`-style) listening for `/` at the start of a line/paragraph.
- Suggestion menu surfaces commands: `/embed`, `/spotify`, `/apple-music`, `/soundcloud`, `/bandcamp`, `/youtube`, `/vimeo`, plus existing block ops we want to surface (`/heading`, `/divider`, `/quote`, `/image`).
- Selecting a provider-specific command opens the insert bar pre-focused with the provider hint.
- Selecting `/embed` opens the bar with no hint.

Slash command infra is reusable for future blocks. Treat this as a foundation, not just an embed feature.

## Out of scope

- Custom per-embed dimensions (user-overridable `width`/`height`). Locked-by-provider×kind is fine.
- Per-embed style overrides (theme color, border radius). Strict Swiss everywhere.
- New providers (Apple Podcasts, Mixcloud, Tidal). Tracked separately.
- Migration of existing stored `aspectRatio` values; renderer override + lightbox change naturally moves rendering forward without data migration.

## Open questions resolved

| Q | Resolution |
|---|---|
| Honor stored aspectRatio? | No — new fixed heights always win. |
| Bandcamp public URL → iframe? | Yes, via server-side oEmbed lookup. |
| Apple Music music-video sizing? | 16:9 aspect-ratio. |
| Toolbar icon? | `Link2`. |
| Slash command infra? | Doesn't exist; build it as part of this spec. |
| OG image infra? | Believed to exist; verify before designing card thumbnail. If not, ship colored card without thumbnail. |
| Card style? | Strict Swiss. No wrapping chrome on the inline iframe variant for video. |
| Default mode? | Link-card-with-lightbox for audio providers; inline iframe for video providers. |

## Acceptance

- Spotify track URL → 152 px-tall card; click opens 152 px iframe in lightbox.
- Spotify album URL → 352 px card; click opens 352 px iframe.
- Apple Music album → 450 px card; music-video → inline 16:9 iframe.
- SoundCloud track → 166 px card; playlist → 450 px card.
- Bandcamp public URL → resolves via oEmbed → 470 px card; click opens iframe player.
- YouTube/Vimeo → still inline 16:9 iframe (no card mode).
- Toolbar `Link2` button shows tooltip "Embed link · ⌘⇧E".
- `Cmd⇧E` opens insert bar.
- Typing `/spotify` inline shows suggestion menu, picks the Spotify embed bar.
- Existing event content with stored embeds renders without regression (cards or iframes per provider/kind).

## Effort

- **A — fixed heights** ~1 hr.
- **B — Bandcamp oEmbed lookup** ~2 hr (server-side fetch, error handling, store canonical URL).
- **C — link-card + lightbox** ~3-4 hr (card component, lightbox modal, OG-image infra check).
- **D — toolbar + slash menu** ~3-4 hr (slash menu plugin is the bulk; toolbar swap is trivial).

Total: ~9-11 hr focused work. Recommend stages:

1. Stage 1: A (sizing) + D toolbar icon + shortcut. Ships immediately, low risk. ~2 hr.
2. Stage 2: B (Bandcamp oEmbed). Fixes a real broken-feeling product gap. ~2 hr.
3. Stage 3: C (lightbox) + slash menu. Bigger UX shift; bench-test with real organizers before shipping. ~5-7 hr.

Each stage is a clean PR.
