# Entity Page Editor — Live Layout Editor

**Date:** 2026-04-24  
**Status:** complete
**Priority:** P1 (Important)  
**Depends on:** EntityPage schema, PageBlock model, block-kinds.ts, PlaceProfileEditor, DraggableBlockList, follows system, HumanStats/OrgStats  
**Supersedes:** `apps/web/src/app/admin/[slug]/places/[placeId]/page/_components/PlaceProfileEditor.tsx` (place-only editor)

---

## Problem

Entity pages (places, humans, orgs) each need a public profile page with configurable content blocks. Today, only places have an editor (`PlaceProfileEditor`), and it's hardcoded to the place admin route. Humans and orgs have no way to configure their public pages. The editor also uses an abstract block list rather than showing the actual rendered output — users can't see what their page looks like while editing.

---

## Goal

A single **generic `EntityPageEditor`** component that works for all entity types (HUMAN, ORGANIZATION, PLACE). The editor renders the **actual page blocks live** — not abstract placeholders. In edit mode, each block gains a drag handle and a show/hide toggle. Users rearrange their page by dragging real rendered components in a clean columnar grid. Each entity type registers which blocks are available, but the editor infrastructure is shared.

Events are explicitly excluded — the event detail page at `/events/[slug]` IS the event's public page.

---

## Context

| What exists | Where |
|---|---|
| EntityPage, PageBlock, PageTheme models | `packages/db/prisma/entity-page.prisma` |
| Block kind definitions per owner type | `packages/core/src/use-cases/entity-pages/block-kinds.ts` |
| Block CRUD use case (add, edit, reorder, toggle, delete) | `packages/core/src/use-cases/entity-pages/manage-page-blocks.ts` |
| Page CRUD use cases | `packages/core/src/use-cases/entity-pages/` |
| Place-only editor | `apps/web/.../places/[placeId]/page/_components/PlaceProfileEditor.tsx` |
| DraggableBlockList (dnd-kit) | `apps/web/.../places/[placeId]/page/_components/DraggableBlockList.tsx` |
| Public page route + shell | `apps/web/src/app/p/[slug]/page.tsx`, `EntityPageShell.tsx` |
| Block registry + 13 implemented blocks | `apps/web/src/app/p/[slug]/_components/blocks/` |
| 8 stub blocks (shows, music, tracks, stats, etc.) | Same directory, return "coming soon" placeholders |
| Follow system (follow/unfollow, counts, preferences) | `packages/core/src/use-cases/follows/` |
| HumanStats (events, tickets, fans, genres, cities) | `packages/db/prisma/stats.prisma`, `compute-human-stats.ts` |
| OrgStats (events, tickets, venues, artists) | `packages/db/prisma/stats.prisma` |
| tRPC router | `packages/transport/trpc/src/routers/entity-pages.ts` |
| Follow tRPC router | `packages/transport/trpc/src/routers/follows.ts` |

---

## Design Philosophy

The editor is **not a CMS block editor** with abstract placeholders. It's a **live layout editor** where the user sees their actual page and drags real rendered components. Think Squarespace's inline editor, not WordPress's Gutenberg.

### Visual Principles (Swiss International)

- **Visible grid structure** — blocks snap to a columnar grid with structural borders. The grid is tangible, not hidden.
- **Edit mode chrome is minimal** — a subtle drag handle (⠿) on the left edge, a visibility toggle (eye icon) on the right edge, and a faint highlight border around the hovered block. That's it.
- **No modal editors** — block settings (when needed) appear in an inline expandable panel below the block, not in a modal.
- **Asymmetric column layout** — blocks can span 1 or 2 columns in a 2-column grid (desktop). Mobile collapses to single column.

---

## Data Model

No schema changes required. The existing models support everything:

- **`PageBlock.kind`** — determines which component renders
- **`PageBlock.orderIndex`** — determines position in the grid
- **`PageBlock.visible`** — show/hide toggle
- **`PageBlock.data`** — block-specific configuration (JSON)
- **`EntityPage.ownerType`** — determines available block kinds

### Block Data Shapes (new/enhanced)

```
stats block data: {
  showFields: string[]  // e.g. ["totalEventsPerformed", "avgDrawPerEvent", "followerCount"]
  layout: "row" | "grid"  // row = horizontal stat cards, grid = 2x2
}

follower_count block data: {
  // No config needed — reads from EntityPage.showFollowerCount + computed count
}

events block data: {
  maxItems: number       // default 6
  showPast: boolean      // default false
  layout: "grid" | "list"
}
```

---

## Architecture

### Component Hierarchy

```
<EntityPageEditor>
  ├── <EditorToolbar>           — edit/preview toggle, save, add block
  ├── <EntityPageHeader>        — banner, avatar, name, bio (inline editable)
  └── <BlockGrid>               — the draggable grid
       ├── <EditableBlock>      — wraps each rendered block with edit chrome
       │    ├── <DragHandle>    — ⠿ grip on left edge
       │    ├── <BlockRenderer> — the actual block component from block-registry
       │    ├── <VisibilityToggle> — eye/eye-off on right edge
       │    └── <BlockSettings> — inline expandable config (optional, per block kind)
       └── <AddBlockButton>     — "+" at the bottom or between blocks
```

### Key Design Decisions

**1. Shared component, not shared route**

The `EntityPageEditor` is a component, not a page. Each entity type mounts it in its own admin route:

- Places: `/admin/[slug]/places/[placeId]/page` (replaces `PlaceProfileEditor`)
- Humans: `/admin/[slug]/profile/page` or `/account/settings/profile` (new route)
- Orgs: `/admin/[slug]/page` (new route)

**2. Block registry is per-owner-type**

```typescript
// block-registry.ts
const BLOCK_REGISTRY: Record<PageOwnerType, BlockKind[]> = {
  HUMAN: ["about", "stats", "upcoming_events", "photos", "links", "tracks", ...],
  PLACE: ["about", "location_map", "capacity_info", "upcoming_events", "photos", ...],
  ORGANIZATION: ["about", "team", "upcoming_events", "managed_places", "photos", ...],
};
```

The editor reads the owner type and only offers blocks from that registry in the "Add Block" menu.

**3. Live rendering with edit overlay**

Each block is rendered using the existing `BlockRenderer` from the public page. The editor wraps it in `<EditableBlock>` which adds:

- A transparent overlay with drag handle + visibility toggle (appears on hover)
- A highlighted border on hover/drag (`$brandSecondary` orange, 2px)
- An opacity reduction when `visible: false` (50% opacity + strikethrough badge)
- A click handler that expands inline block settings (if the block kind has configurable data)

**4. Drag-and-drop via dnd-kit**

Reuses the existing `@dnd-kit/core` + `@dnd-kit/sortable` setup from `DraggableBlockList`. The difference is that items are full rendered blocks, not abstract list items.

**5. Optimistic reordering**

On drag end, immediately update local state (reorder the array), then fire the `managePageBlocks({ action: "reorder", orderedBlockIds })` mutation. On error, revert.

---

## Use Cases

No new use cases needed. The existing `manage-page-blocks.ts` handles all operations:

- `add` — validated per owner type via `VALID_BLOCK_KINDS`
- `edit` — partial update of `data` or `kind`
- `reorder` — atomic index reassignment
- `toggleVisibility` — flip `visible` boolean
- `delete` — remove block

The existing `update-page.ts` handles profile metadata (slug, displayName, bio, avatar, banner).

The existing `update-page-theme.ts` handles theme customization.

### New: Stats Block Data Source

The `stats` block renderer needs to fetch computed stats. Add a tRPC query:

```typescript
// entityPages.getBlockStats
// Input: { entityPageId, ownerType }
// Output: relevant stats from HumanStats | OrgStats | PlaceStats
```

This is a read-only query — stats are computed by background jobs (`compute-human-stats`, `compute-org-stats`), not by the editor.

---

## UI / Flow

### Edit Mode

1. User navigates to their entity page editor (e.g., `/admin/acme-events/page`)
2. The page renders their live entity page with an `EditorToolbar` at the top
3. Toolbar has: **Edit** / **Preview** toggle, **Save** button, **Add Block** dropdown
4. In Edit mode:
   - Each block shows a drag handle on hover (left edge, `⠿` icon)
   - Each block shows a visibility toggle on hover (right edge, eye icon)
   - Blocks can be dragged to reorder
   - Clicking a block expands inline settings below it (if applicable)
   - Hidden blocks render at 50% opacity with an "HIDDEN" badge
5. In Preview mode:
   - Page renders exactly as the public would see it
   - Hidden blocks are not shown
   - No edit chrome

### Add Block Flow

1. User clicks "+" button (between blocks or at bottom)
2. A dropdown shows available block kinds for their entity type
3. Each option shows: icon + name + one-line description
4. Selecting a kind creates a new block with default data and appends it at the clicked position
5. The new block immediately appears in the grid with its inline settings expanded

### Block Settings (Inline)

When a block is clicked in edit mode, an inline panel slides open below it:

- **About block**: Rich text editor for content, heading text input
- **Stats block**: Checkboxes for which stats to show, layout toggle (row/grid)
- **Events block**: Max items slider, show past toggle, layout toggle
- **Links block**: Add/remove/reorder links (label + URL + optional icon)
- **Photos block**: Upload/remove images, reorder
- **Location map block**: No settings (auto-populated from place data)
- **Team block**: No settings (auto-populated from org members)

Blocks with no configurable data (like `location_map`, `team`, `resident_artists`) show no settings panel — they're data-driven and auto-populated.

### Column Layout

Desktop (≥ 1024px):
- 2-column grid with 24px gap
- Most blocks span full width (2 columns)
- `stats` and `links` blocks can be configured to span 1 column (side-by-side)
- Block `data.columnSpan` field: `1 | 2` (default: 2)

Tablet (768–1024px):
- 2-column grid, all blocks forced to full width

Mobile (< 768px):
- Single column, blocks stack vertically

---

## Migration Path

### Phase 1: Extract generic editor (this spec)

1. Create `apps/web/src/components/entity-pages/EntityPageEditor.tsx`
2. Create `apps/web/src/components/entity-pages/EditableBlock.tsx`
3. Create `apps/web/src/components/entity-pages/EditorToolbar.tsx`
4. Create `apps/web/src/components/entity-pages/AddBlockMenu.tsx`
5. Create `apps/web/src/components/entity-pages/BlockSettingsPanel.tsx`
6. Refactor `PlaceProfileEditor` to use `EntityPageEditor` with `ownerType="PLACE"`
7. Wire up human profile route (`/account/settings/page`) with `ownerType="HUMAN"`
8. Wire up org page route (`/admin/[slug]/page`) with `ownerType="ORGANIZATION"`

### Phase 2: Live rendering (this spec)

1. Replace abstract `DraggableBlockList` with live-rendered `EditableBlock` wrappers
2. Each `EditableBlock` renders the real `BlockRenderer` component inside a drag container
3. Add hover chrome (drag handle, visibility toggle, highlight border)
4. Add inline settings panels for configurable blocks

### Phase 3: Stats + auto-populated blocks (follow-up)

1. Implement `stats` block renderer (reads from HumanStats/OrgStats)
2. Implement `team` block (reads org members)
3. Implement `resident_artists` block (reads EventHuman associations)
4. Implement `managed_places` block (reads org's places)
5. Implement `past_events` block (reads completed events)

---

## Acceptance Criteria

- [ ] `EntityPageEditor` component accepts `ownerType` and renders the correct block palette
- [ ] Blocks render as their actual public-facing components, not abstract placeholders
- [ ] Edit mode shows drag handle + visibility toggle on hover for each block
- [ ] Blocks can be dragged to reorder (optimistic update, mutation on drop)
- [ ] Hidden blocks render at 50% opacity with "HIDDEN" badge in edit mode
- [ ] Hidden blocks are not shown in preview mode
- [ ] "Add Block" dropdown only shows blocks valid for the entity's owner type
- [ ] New blocks appear at the correct position with inline settings expanded
- [ ] Inline settings panel opens below the block on click (for blocks with configurable data)
- [ ] Places route (`/admin/[slug]/places/[placeId]/page`) uses the new generic editor
- [ ] Human route (new) uses the generic editor with `ownerType="HUMAN"`
- [ ] Org route (new) uses the generic editor with `ownerType="ORGANIZATION"`
- [ ] Preview/Edit toggle switches between chrome-on and chrome-off views
- [ ] 2-column grid on desktop, single column on mobile
- [ ] `borderRadius: 0` on all elements (Swiss style)
- [ ] Keyboard accessible: Tab focuses blocks, Enter expands settings, Space toggles visibility
- [ ] WCAG 2.2 AA: drag handle has aria-label, visibility toggle has aria-pressed

---

## Decisions (Resolved)

- **Block-specific inline editors**: Start with the 5 most common (about, stats, events, links, photos). Each additional block kind gets its own spec as needed. Incremental rollout.
- **Column span control**: Each block kind defines which row/column spans it supports. Blocks render differently based on their span — e.g., stats renders as a horizontal row at full width but a compact 2x2 grid at half width. Users pick from the spans the block supports.
- **Theme editor**: Integrated into the live editor toolbar — no separate tab. The user sees theme changes reflected immediately on the live page.
- **Auto-populated blocks**: All data-driven blocks (team, resident_artists, managed_places, past_events) support configuration: max items, sort order, and layout variant. They pull live data but the display is configurable.
- **Entity page for humans**: Lives in both `/account/settings/page` (personal settings) AND the admin shell's human tab (humans have an admin shell for their own events). Same editor component mounted in two routes.
