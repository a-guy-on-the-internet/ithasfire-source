# Lineup Listen Embeds

**Date:** 2026-07-21
**Status:** approved
**Priority:** P2 (High Value)
**Depends on:** EventHuman (event.prisma), EntityPage + PageBlock (entity-page.prisma), media-embed pipeline (`packages/core/src/lib/embeds`), `list-public-event-humans`, MediaEmbed / EpkEmbed (web)
**Supersedes:** —

---

## Problem

Event pages list the lineup, but a visitor who doesn't know an act has no way to hear them without leaving the page. Performers already curate music on their profiles (tracks / music / links blocks), and organizers already build lineups — nobody should have to enter anything new for the event page to be listenable.

---

## Goal

When an artist is added to an event lineup, the public event page automatically offers a playable music embed for them, derived at read time from their performer profile. Organizers get it for free the moment they add someone to the lineup; performers control it implicitly through what they curate on their own page. Visitors get a "Listen" chip per lineup act that expands an inline player.

---

## Context

| What exists | Where |
|---|---|
| Embed URL parser + provider allowlist (Spotify incl. `artist`, SoundCloud, Apple Music, Bandcamp, YouTube, Vimeo) with CSP/sizing metadata | `packages/core/src/lib/embeds/parse-embed-url.ts`, `providers.ts` |
| Sandboxed player component (iframe/link render modes) | `apps/web/src/components/embeds/MediaEmbed.tsx` |
| Client re-parse discipline (server never ships raw iframe src; client re-derives from URL) | `apps/web/src/app/p/[slug]/_components/blocks/epk-embed.tsx` |
| Public lineup payload (VOLUNTEER-filtered, bulk human-name resolution) | `packages/core/src/use-cases/event-humans/list-public-event-humans.ts` |
| Profile music curation: `tracks` block (`tracks: [{url,title}]`), `music` block (`embeds: [{url}]`), `links` block (`links: [{label,url}]`) | entity-page blocks; rendered via EpkEmbed |
| Block visibility rules (public page renders only `visible` blocks on a PUBLIC page) | `packages/core/src/use-cases/entity-pages/get-public-page.ts` |
| Entity-page repo accessors (`getByOwner`, `listBlocks` — per-page only) | `packages/ports/src/repos/entity-pages.ts` |
| Spotify enrichment API (top tracks, previews, monthly listeners) — built, unwired | `packages/core/src/use-cases/spotify/` — **out of scope here** |

---

## Data Model

No schema changes. Derivation is read-time only; nothing is persisted.

Repo additions (port + Prisma adapter, no migration):

- `EntityPagesRepo.getByOwners(ownerType: PageOwnerType, ownerIds: string[]): Promise<EntityPageRecord[]>` — batched `getByOwner`.
- `EntityPagesRepo.listBlocksByPageIds(pageIds: string[]): Promise<PageBlockRecord[]>` — batched `listBlocks`, preserving per-page `sortOrder`.

Both exist purely to keep the lineup derivation at 2 queries instead of 2N.

---

## Use Cases

### 1. Parser enhancement — SoundCloud profile URLs (`packages/core/src/lib/embeds/parse-embed-url.ts`)

`soundcloud.com/{user}` (exactly one path segment) currently returns `null`. Accept it as `kind: "user"`:

- Same slug charset/length validation as existing segments.
- **Reserved-path blocklist** (never a user): `discover`, `search`, `stream`, `upload`, `you`, `pages`, `charts`, `feed`, `messages`, `notifications`, `settings`, `terms-of-use`, `imprint`, `jobs`, `logout`, `signin`, `popular`, `tags`. Blocklisted single segments return `null`.
- Embed URL: same `w.soundcloud.com/player/?url={canonical}` widget form already used for tracks/sets (the widget plays a user's uploads).
- Sizing: `inferSizing("soundcloud", "user")` returns the taller playlist-style height (match `set`), not the single-track height.
- `mediaEmbedNodeSchema` in `@th/schema` mirrors the provider list, not kinds — verify no schema change is needed; if kinds are enumerated anywhere, add `user`.

### 2. Pure selection helper — `pickListenUrl(blocks: PageBlockRecord[]): string | null` (`packages/core/src/lib/embeds/` or `use-cases/event-humans/_shared/`)

Given a page's **visible** blocks in stored order, return the first URL that satisfies:

1. `tracks` block → first `tracks[].url` that `parseEmbedUrl` resolves to an **iframe** render (any provider — the block is explicitly music-curated).
2. else `music` block → first `embeds[].url`, same rule.
3. else `links` block → first `links[].url` that parses to an iframe embed for a **music provider only** (`spotify`, `soundcloud`, `appleMusic`) — never YouTube/Vimeo (a social-links YouTube URL is usually not music), never `renderMode: "link"` providers (not inline-playable).

Pure function, unit-tested directly. Malformed/empty block data never throws — skip and continue.

### 3. Lineup derivation — extend `list-public-event-humans`

- After the existing human-name bulk resolve: collect linked `humanId`s → `entityPages.getByOwners("human", ids)` → keep pages with `visibility === "PUBLIC"` → `listBlocksByPageIds` → per page, filter to visible blocks → `pickListenUrl`.
- External entries (`humanId === null`, `externalUrl` set): `listenUrl = externalUrl` iff it parses as an iframe embed for a music provider (same rule as links-block candidates).
- Output schema: add `listenUrl: z.string().nullable()` to each row. The server ships the **URL only** — the client re-derives embed attrs via `parseEmbedUrl` (EpkEmbed discipline; no raw iframe src crosses the wire).
- Derivation failures degrade to `listenUrl: null`, never break the lineup. This is a read path with a natural fallback, so a thrown repo error still propagates normally (no new swallow branches; if one is added it MUST take `reportError` per the Sentry convention).
- ORGANIZATION lineup members do not exist on EventHuman — humans only. (Org/band EPK music surfaces on the org page itself; out of scope.)

### 4. Transport

`eventHumans.listPublic` already flows through the use case — the new field rides the existing output schema. No new procedure.

---

## UI / Flow

`EventContent.tsx` lineup section (web public event page; embeds/admin preview render the same — the chip is harmless there):

- Lineup rows whose entry carries `listenUrl` AND `parseEmbedUrl(listenUrl)` resolves client-side get a **"Listen" chip** (play icon + label, i18n key, en+es) on the row.
- Tapping the chip expands an inline player panel under the row rendering `<MediaEmbed>`; tapping again collapses it.
- **Lazy mount is a hard requirement:** the `MediaEmbed` (and therefore its iframe) must not be in the DOM until first expansion. A 10-act lineup must load **zero** player iframes on page load (except the auto-expanded headliner below). After first expansion the panel may stay mounted while collapsed (hidden) to avoid replaying loads on toggle — either keep-mounted-after-first-open or unmount-on-collapse is acceptable; never mount-before-first-open.
- **Headliner auto-expand:** the first lineup entry (existing lineup sort order) that has a renderable listen embed auto-expands on **desktop** only (`mobile` prop false). On mobile everything starts collapsed (data cost). Only ever one auto-expanded row.
- Multiple rows may be open simultaneously (no accordion coupling).
- Immersive-hero styling rules do not apply — the lineup section is below-fold on the cream surface; chip follows the standard below-fold token usage.
- Accessibility: chip is a `button` with `aria-expanded` + `aria-controls`; the panel is labelled by the act's name.

---

## Acceptance Criteria

- [ ] `parseEmbedUrl("https://soundcloud.com/somartist")` → soundcloud embed, `kind: "user"`, playlist-height sizing; `soundcloud.com/discover` (and all blocklist entries) → `null`; existing track/set parsing unchanged.
- [ ] `pickListenUrl` honors tracks → music → links priority; links-block candidates restricted to spotify/soundcloud/appleMusic iframe embeds; malformed block data skipped without throwing.
- [ ] `eventHumans.listPublic` rows carry `listenUrl`; derived only from PUBLIC pages' visible blocks; hidden block / hidden page / no page → `null`; external entry with a Spotify artist `externalUrl` → that URL; VOLUNTEER filtering unchanged.
- [ ] Lineup derivation adds at most 2 queries regardless of lineup size (batched accessors).
- [ ] Event page: lineup rows with a listenable URL show the Listen chip; expanding renders the player; **no player iframe exists in the DOM pre-expansion** (assert in a component test); headliner auto-expands on desktop, not on mobile.
- [ ] A Spotify **artist** profile URL in a profile's links block yields a playable top-tracks player on the event page (the core "pull from profiles" scenario).
- [ ] Unit tests: parser (user kind + blocklist), pickListenUrl, listPublic derivation (page/block visibility, external entries, batching), lineup chip lazy-mount + auto-expand component tests.
- [ ] i18n: chip label + collapse label in en + es.

---

## Open Questions

- None blocking. Spotify enrichment (native previews, monthly listeners badge) deliberately deferred to a later phase on the existing `spotify.getArtist` backend.
