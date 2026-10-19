# Site Builder / Mini-Site Platform

> Status: complete
> Domain: Profiles, Organizations, Places, Public pages, Embeds, Admin UI
> Owner: product / platform

## Summary

Provide a flexible mini-site system that lets ticket organizers, venues, and performers create a small, opinionated public site on Ithas Fire. The UI should feel playful and component-driven (moveable components / blocks), while remaining safe, performant, and SEO-friendly.

We will ship incrementally:

- P0 (MVP): Org pages only (`/o/{slug}`) — minimal block set, theme editor, public page, admin editor.
- P1: Add Place pages (`/v/{slug}`) and site features that are venue-specific (calendar, booking link).
- P2: Add Human pages (`/u/{slug}`) and artist-focused blocks (music embeds, tour list).
- P3: Unified polymorphic backend (single `SitePage` + `SiteModule` + `SiteTheme`) and richer block library.

The spec below covers goals, data model options, API contract, frontend routes, security and moderation, tests, rollout and metrics.

---

## Goals (success criteria)

1. Every org has a public, shareable, SEO-friendly page listing upcoming events.
2. Organizers can edit a themed page composed of ordered blocks (hero, bio, upcoming events, links, photos).
3. Pages are safe by default: no raw user-supplied HTML/CSS that can create XSS/phishing.
4. Pages power embeddable widgets (calendar list) and are discoverable by search.
5. Implementation is incremental: deliver org-only MVP in ~1-2 weeks, then expand.

Non-goals (for MVP): full drag-and-drop layout builder with arbitrary positioning (absolute placement), raw HTML/CSS editing, or plugin scripts.

---

## MVP scope (org-first)

- Backend: API to fetch org page, list modules, update modules (admin-only), update theme (admin-only), reorder modules.
- Data: New `OrgPage`, `OrgModule`, `OrgTheme` tables or a polymorphic `SitePage` family (see "Data model" below). MVP will implement `OrgPage` to reduce migration risk; later we will migrate to polymorphic model.
- Frontend: Public route `/o/{slug}` that server-renders a themed page; admin editor under org admin sidebar with block add/edit/reorder; theme picker UI.
- Security: No `custom_html` blocks in MVP. Allow controlled embeds via an allowlist and server-side validation.

---

## Data model — options and recommendation

Two approaches considered:

A. Incremental (recommended for fast ship):

- Add `OrgPage`, `OrgTheme`, `OrgModule` models that mirror existing `Profile*` models.
- No migration of `Profile` rows needed.
- Build admin UI and public renderer for orgs only.
- Later, when adding places/humans, add `PlacePage` and `HumanPage` similarly.

Pros: low risk, fast to ship, minimal schema churn.

Cons: duplication that will later require a refactor to unify.

B. Polymorphic (long term, cleaner):

- Create `SiteOwnerType` enum: `HUMAN | ORGANIZATION | PLACE`.
- Add `SitePage` table with fields: id, ownerType, ownerId, slug, visibility, canonicalUrl?, createdAt, updatedAt.
- `SiteModule` table (ordered blocks): id, sitePageId, kind, orderIndex, data JSON.
- `SiteTheme` table: sitePageId PK, colorPrimary, colorBg, colorText, fontKey, layoutKey, metadata JSON.

Pros: single code path, unified rendering and editor code, easier to maintain feature parity across types.

Cons: more initial migration work; must migrate existing `Profile` rows.

Recommendation: Start with approach A (Org-specific) for MVP. Include a tested migration path and an eventual refactor plan to B.

### Proposed Org-specific schema (MVP)

```prisma
model OrgPage {
  id        String   @id @default(uuid())
  orgId     String   @unique // FK to Organization.id
  slug      String   @unique
  visibility PageVisibility @default(PUBLIC)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  theme OrgTheme?
  modules OrgModule[]
}

model OrgTheme {
  orgPageId    String @id
  colorPrimary String?
  colorBg      String?
  colorText    String?
  fontKey      String?
  layoutKey    String?
  metadata     Json?  @default("{}")

  orgPage OrgPage @relation(fields: [orgPageId], references: [id], onDelete: Cascade)
}

model OrgModule {
  id         String  @id @default(uuid())
  orgPageId  String
  kind       String  // enum-ish; see block catalog
  orderIndex Int     @default(0)
  data       Json    @default("{}")

  orgPage OrgPage @relation(fields: [orgPageId], references: [id], onDelete: Cascade)

  @@index([orgPageId, orderIndex])
}

enum PageVisibility { PUBLIC PRIVATE }
```

Notes:

- `kind` is a small finite set and should be validated at the application layer with Zod.
- `data` contains typed JSON per `kind`. See Block Catalog below.

---

## Block Catalog (initial MVP block kinds)

Each block type has a typed JSON `data` shape with Zod schemas in `packages/core`. The editor presents a friendly form for each block's data.

MVP (org-first) block set:

- `hero`

  - data: {

    title: string,

    subtitle?: string,

    bannerImageUrl?: string,

    actions?: [{ label: string, url: string }] // e.g. "Buy Tickets"

  }

- `about`

  - data: { body: string } // sanitized Markdown/plain text

- `upcoming_events`

  - data: { limit: number = 5, includeCancelled?: boolean = false }

  - Rendered from Events where orgId = owner

- `past_events`

  - data: { limit: number = 10 }

- `links`

  - data: { links: [{ label:string, url:string, iconKey?:string }] }

  - Link count limited (e.g. 12) to reduce spam

- `photos`

  - data: { images: [{ url:string, alt?:string, caption?:string }] }

  - Images stored in your file storage; limit to N images per block

- `calendar_embed`

  - data: { mode: "compact"|"detailed", startDate?:string, endDate?:string }

  - Renders an embeddable calendar of upcoming events (internal render)

- `music_embed` (allowlisted providers only)

  - data: { provider: "spotify"|"soundcloud"|"bandcamp", url: string }

  - Server validates provider & URL via pattern + optional oEmbed fetch

- `contact`

  - data: { email?:string, phone?:string, website?:string, address?:string }

  - Render as mailto / tel links; validate fields server-side

Disallowed for MVP: `custom_html_sanitized`, arbitrary script tags, arbitrary iframes. If later re-introduced, it must be behind gating, strict sandboxing, and a dedicated audit process.

---

## API / Use-cases (core + transport)

Design choices:

- Core use-cases live in `packages/core/src/use-cases/sites/*`.
- Transport (tRPC) exposes thin routes that call core and map errors.
- Repos (ports) add `orgPages` / `sitePages` interfaces.

Suggested core use-cases (MVP):

- `getPublicOrgPage` (input: orgSlug) -> returns org metadata, modules (ordered), theme
- `listPublicEventsForEntity` (entityType=ORGANIZATION|PLACE|HUMAN, id or slug, timeRange?) -> used by `upcoming_events` block and embeds
- `getOrgPageForAdmin` (auth required: org-admin) -> page + modules + theme
- `upsertOrgModule` (auth) -> create/update module data (with validation)
- `reorderOrgModules` (auth) -> change order indices
- `upsertOrgTheme` (auth) -> validate and persist theme
- `publishOrgPage` (auth) -> mark published/unpublished
- `requestOrgImageUpload` / `setOrgImageFromUpload` -> file storage flows for banner/avatar/photos

Transport routes (tRPC):

- `sites.getPublicOrgPage` (public GET)
- `sites.getOrgPageForAdmin` (authed)
- `sites.upsertModule` (authed)
- `sites.reorderModules` (authed)
- `sites.upsertTheme` (authed)
- `sites.requestUpload` / `sites.setImageFromUpload` (authed)

Schemas: Implement Zod schemas for all inputs and outputs. Reuse `types/repos` shape for modules/theme where possible.

---

## Frontend — routes and components

Public:

- `/o/[slug]/page.tsx` — SSR/SSG: server-rendered page that

  - fetches `getPublicOrgPage` on server, injects theme CSS variables into head

  - returns canonical URL, meta tags (OG/Twitter), JSON-LD Organization markup, and renders module components in order

Admin/editor:

- Admin UI: under `apps/web/src/app/admin/[slug]/site/*`

  - `index.tsx` — editor shell with preview pane and editor controls

  - `ThemeEditor.tsx` — color pickers (constrained swatches + hex validator), font dropdown, layout presets

  - `ModuleList.tsx` — draggable list of modules using `@dnd-kit/core` or `dnd-kit/sortable`

  - `ModuleEditor/<kind>.tsx` — per-kind edit forms (hero, about, links, photos)

  - `SitePreview.tsx` — live WYSIWYG preview (reads modules and theme)

Design notes:

- Editor should operate on a temporary local model then persist with `upsertModule`/`upsertTheme` calls (debounced where appropriate)
- Provide undo for last action (optimistic UI) where straightforward
- Allow "Save Draft" vs "Publish" — page visibility toggles

Embeds:

- `apps/web/src/app/embed/[embedId]` will read `Embed` which can map to a site module or to a site event list. For `upcoming_events` embed, add query params for `limit`, `themeKey`.

---

## Security model (must be explicit)

High-level rule: NO arbitrary client-supplied markup/CSS that is injected into pages. Only structured data rendered through server-side templates/components.

Specifically:

- Disallow `custom_html` blocks in MVP.
- For text fields, accept plain text or sanitized Markdown. Use a well-known sanitizer library (e.g., `DOMPurify` on server or `sanitize-html`) if rendering sanitized HTML from Markdown. Prefer server-side sanitization in core use-cases.
- Links: server-validate using URL parsing; block `javascript:`, `data:` schemes; limit redirect hops when following oEmbed endpoints.
- Embeds: implement an allowlist of providers (Spotify, YouTube, SoundCloud, Bandcamp). Validate embed URLs against provider patterns. Optionally fetch oEmbed metadata on creation and cache it.
- Images: uploads go to your file storage. Scan uploads via virus/unsafe content scanner if available (or add later). Enforce content-type and size limits.
- CSP: public pages should include a conservative Content-Security-Policy header. For any third-party embed, consider sandboxed iframes with `allow` limited (e.g., `allow=\"autoplay; encrypted-media\"`), or proxy/embed via your own iframe wrapper that isolates third-party content.
- Rate-limits/quotas: limit number of modules per site (e.g., 20) and size of each module JSON; throttle rapid site updates (protect against floods).
- Moderation: provide admin moderation APIs and a background job that flags suspicious pages (many outbound links, known spam patterns). Build a manual takedown UI in internal admin.

XSS mitigation checklist:

- Do not interpolate user input into script contexts.
- Use tight Zod validation for all `data` JSON shapes.
- Escape all text rendered into templates; only allow sanitized HTML from Markdown which is sanitized server-side.
- Audit file upload paths and ensure stored images cannot host HTML files.

Privacy:

- Pages are public by default for orgs, but allow private/hidden toggle for future use.
- Avoid exposing PII in public modules (store email but render as contact form server-side if org prefers to hide raw emails).

---

## Moderation and anti-abuse

- Soft limits: per-org maximum modules, per-module image count, per-image size.

- Spam heuristics: high outbound link ratio, newly created org with many pages, identical content across many pages.

- Reporting: add "Report page" button on public pages that creates an internal ticket with link + snapshot.

- Admin tools: list pages ordered by creation/update, search by owner, bulk takedown, mark pages as "under review".

- Optionally integrate with external services: Akismet-like spam detection, or a simple ML classifier.

---

## Tests (unit, integration, E2E)

Core tests:

- Unit tests for Zod validators for every block kind.

- Use-case tests (packages/core) for `getPublicOrgPage`, `upsertOrgModule`, `reorderOrgModules`, including negative tests for invalid data.

Adapter tests:

- Adapter repo tests for `orgPages` repo functions (make sure `upsert` and `get` work across transactions)

Transport tests:

- tRPC router contract tests for `sites.*` endpoints.

Frontend tests:

- Component tests for the editor (module form validation), theme picker.

- Integration tests: simulate adding modules, reordering, saving, and viewing the public page (Vitest/React Testing Library).

E2E:

- Playwright tests for the full flow: org admin creates page, adds hero and upcoming_events, saves, publishes, and public page shows events + right meta tags. Record videos and save into `apps/web/test-results` per existing conventions.

Security tests:

- Automated XSS regression suite: inject payload-like strings into text fields and ensure output is sanitized/escaped.

- Allowlist tests for embed URLs.

---

## Migration & rollout plan

Phase A – Org-only MVP (fast ship)

1. Create `OrgPage`, `OrgModule`, `OrgTheme` Prisma models and run `prisma migrate dev --name org-site-mvp`.

2. Implement repos and core use-cases for org pages.

3. Implement tRPC `sites` router endpoints.

4. Implement admin UI under org admin with module editor and theme editor.

5. Implement public `/o/[slug]` page with SSR and SEO meta.

6. Add feature flag `orgSites.enabled` and gate UI.

7. Run tests and staging rollout behind flag.

Phase B – Place pages

1. Add `PlacePage`, `PlaceModule`, `PlaceTheme` (or migrate to polymorphic) depending on refactor decision.

2. Add place-specific block(s): `venue_calendar`, `booking_request` link.

3. Add public route `/v/[slug]` and admin UI under place admin.

Phase C – Human pages

1. Add `HumanPage` or migrate to polymorphic site model.

2. Add artist blocks: `music_embed`, `tour_list` (or `events_by_artist`), `social_feed`.

3. Public route `/u/[slug]`.

Phase D – Polymorphic refactor (optional, but recommended once feature parity exists)

1. Add `SitePage`, `SiteModule`, `SiteTheme` polymorphic models.

2. Backfill `SitePage` rows for existing `OrgPage`, `PlacePage`, `Profile` rows (careful migration script required).

3. Update repos, use-cases, and transport to operate on `SitePage`.

4. Remove legacy per-entity page tables.

Rollout notes:

- Blue-green launch / feature-flagged rollout recommended.

- Monitor error rates, suspicious page creations, and user feedback for 2 weeks after launch.

---

## Observability & metrics

Instrument these metrics from day one:

- Number of pages created / updated (per day)

- Modules created per page, average modules per site

- Page render latency (server-side) P50/P95/P99

- Spam rate: number of pages flagged by heuristics / reports

- XSS incidents (0 expected): any alerts from sanitizer failures or customer reports

- Top block kinds used (to prioritize future work)

Alerts:

- > 10% increase in page creation rate per org in a short window

- Any sanitizer exception or failed sanitized render

- High error rates (>1% 5xx) on `sites.getPublicOrgPage`

---

## Acceptance criteria for MVP

- Org admin can create/update a page and add at least `hero`, `about`, `upcoming_events`, and `links` blocks.

- Public `/o/{slug}` returns SSR page with correct OG/Twitter meta and JSON-LD Organization markup.

- No XSS vulnerabilities in block text, link URLs, or metadata (automated security tests pass).

- Theme editor persists color/font choices and applies as CSS variables on public page.

- Editor is gated behind a feature flag and available to org owners only.

---

## Implementation checklist (developer-facing)

Backend:

- [ ] Prisma models: `OrgPage`, `OrgModule`, `OrgTheme`.

- [ ] Ports: add `orgPages` repo interface and adapter implementation.

- [ ] Core use-cases: `getPublicOrgPage`, `getOrgPageForAdmin`, `upsertOrgModule`, `reorderOrgModules`, `upsertOrgTheme`.

- [ ] Zod schemas for module `data` shapes.

- [ ] tRPC router `packages/transport/trpc/src/routers/sites.ts` with endpoints and auth checks.

Frontend:

- [ ] Public page `/o/[slug]/page.tsx` server-side rendering.

- [ ] Admin editor pages under `apps/web/src/app/admin/[slug]/site/*`.

- [ ] Drag-and-drop with `dnd-kit`.

- [ ] Theme picker component (color swatches + hex validation).

Testing & infra:

- [ ] Unit & integration tests for core use-cases.

- [ ] Playwright E2E for create->publish->view flow.

- [ ] Add feature flag `orgSites.enabled`.

- [ ] Add moderation/admin tools and reporting endpoint.

Docs & product:

- [ ] Update docs `docs/README.md` and `docs/specs` index.

- [ ] Add short doc for how to use the editor and recommended image sizes.

---

## Security/risk tradeoffs and mitigation summary

- Deny raw HTML/CSS in MVP — use sanitized Markdown or plain text only.

- Use strict server-side validation with Zod for module data.

- Validate and allowlist embed providers; prefer proxied/iframe-wrapped embed widgets.

- CSP + sandboxed iframes for third-party content.

- Rate-limit updates and add moderation workflows.

---

## Example module JSONs

Hero:

```json
{
  "title": "The Rusty Anchor",
  "subtitle": "Live music every Friday",
  "bannerImageUrl": "https://cdn.example.com/…/banner.jpg",
  "actions": [{ "label": "Buy tickets", "url": "https://…/checkout" }]
}
```

Links:

```json
{
  "links": [
    { "label": "Instagram", "url": "https://instagram.com/the_rusty_anchor" },
    { "label": "Buy Tickets", "url": "https://…/tickets" }
  ]
}
```

Music embed (Spotify):

```json
{
  "provider": "spotify",
  "url": "https://open.spotify.com/artist/…"
}
```

---

## Next steps (for engineering)

1. Decide on approach A (fast org-only) vs B (polymorphic). I recommend A to ship quickly.

2. Create the Prisma migration for OrgPage/OrgModule/OrgTheme and implement the repos.

3. Implement core use-cases and Zod validators for blocks.

4. Implement the tRPC router and admin UI (editor + preview).

5. Add tests and run the staging rollout behind a feature flag.

---

## Notes and references

- Sanitize Markdown server-side; use a strict sanitizer and a whitelisted set of elements.

- See `docs/specs/platform/venue-calendar.spec.md` for calendar UX details.

- Follow the project's architecture conventions: use cases in `packages/core`, ports in `packages/ports`, adapters in `packages/adapters`, and transport under `packages/transport/trpc`.



---


"""
Spec created by engineering agent on behalf of product.
"""
