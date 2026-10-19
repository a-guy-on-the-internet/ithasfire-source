# Event builder (ProseMirror) + event images (R2)

This doc defines the canonical structure of `Event.body` (JSONB) and how dynamic event images work.

We use:

- **Option A**: images are stored in a first-class DB table (`Image` with `ownerType=EVENT`).
- ProseMirror content references images **by ID** (`imageId`).
- Clients fetch image URLs by calling a resolver use-case with **one-to-many** image IDs.

## Goals

- Allow creators to lay out event pages dynamically with blocks (ProseMirror JSON).
- Support many images per event, referenced from content.
- Support **direct-to-R2** uploads (presigned PUT) with server-side finalization.
- Support garbage collection of unused images.

## Non-goals

- Do not embed CDN URLs directly into ProseMirror content.
- Do not store the event image registry in `Event.body`.
- Do not rely on clients to maintain `attached` state.

## Source of truth

- `Event.body` is the source of truth for which dynamic images are **in use**.
- The image registry lives in the DB (`Image` model, `ownerType=EVENT`).
- The backend reconciles `Image.attached` from `Event.body`.

## Canonical `Event.body` envelope

The `Event.body` JSONB column stores an envelope:

- `version`: schema version for the envelope.
- `meta`: non-editable presentation settings (banner selection, etc.).
- `doc`: a standard ProseMirror document.

### Shape

```json
{
  "version": 1,
  "meta": {
    "bannerImage": {
      "kind": "eventImage",
      "id": "evtimg_9f0c4b6d-8d1d-4a35-b9e4-6cbb0f5a9d5a"
    }
  },
  "doc": {
    "type": "doc",
    "content": []
  }
}
```

### Why an envelope?

- We can evolve the event builder without breaking old content.
- We keep presentation controls (`meta`) separate from editable content (`doc`).
- We can reference banner selection without walking the entire ProseMirror tree.

## ProseMirror image referencing

Dynamic images are referenced in the ProseMirror document by `imageId`.

### Block node: `imageBlock`

We model images as block nodes for easier layout control.

Example:

```json
{
  "type": "imageBlock",
  "attrs": {
    "imageId": "evtimg_22222222-2222-4222-8222-222222222222",
    "alt": "Crowd shot",
    "align": "center",
    "width": "full"
  }
}
```

#### `imageBlock.attrs`

- `imageId` (required): ID of an `Image` row.
- `alt` (optional)
- `caption` (optional)
- `align` (optional): `left | center | right`
- `width` (optional): `narrow | content | full`

## Banner image

Banner selection is stored in `Event.body.meta.bannerImage`.

### Banner reference

```json
{
  "meta": {
    "bannerImage": {
      "kind": "eventImage",
      "id": "<imageId>"
    }
  }
}
```

### Banner fallback (renderer rules)

If `meta.bannerImage` is missing or invalid (e.g. stale content) the renderer should:

1. Choose the first `imageBlock` in the ProseMirror doc (depth-first) and if present render it as the banner.
2. Otherwise fall back to the **profile avatar** of the relevant owner (human/org) if known.

> Note: the backend should still reject invalid IDs during saves.
> The fallback exists to keep older/stale events renderable.

## Validation rules (server-side)

When saving `Event.body`, the backend MUST reject content that references invalid images.

For every referenced `imageId` (in both `doc` and `meta.bannerImage`):

- ID must exist.
- `Image.ownerId` must match the event ID.
- `Image.uploadedAt` must be set.
- `Image.deletedAt` must be null.

If any referenced id fails validation, reject the write with an `invalid_input`-style error.

## Attachment reconciliation

Whenever `Event.body` is updated, the backend reconciles `Image.attached`.

Referenced IDs are the union of:

- All `imageBlock.attrs.imageId` in `doc`.
- `meta.bannerImage.id` if set.

Within a single transaction:

1. Persist the new `Event.body`.
2. Set `attached=true` for referenced ids.
3. Set `attached=false` for previously-attached ids that are no longer referenced.
4. Stamp `attachedAt` / `detachedAt` as appropriate.

## Upload lifecycle (direct-to-R2)

We use a request → upload → finalize pattern:

1. **Request upload**: server mints a presigned PUT URL for R2 and creates an `Image` row (with `ownerType=EVENT`).
2. **Client upload**: client uploads bytes directly to R2 using the signed URL.
3. **Finalize**: server verifies the object exists and marks `uploadedAt`.

## Image URL resolver use-case (one-to-many)

Clients don’t store URLs in ProseMirror. They resolve URLs as needed.

### Proposed use-case contract

Input:

- `actorHumanId` (for auth)
- `eventId`
- `imageIds: string[]` (one-to-many)

Output:

- `images: Array<{ id: string; publicUrl: string; width?: number; height?: number; contentType?: string; }>`

Rules:

- Reject IDs that belong to a different event.
- Either:
  - Strict mode: reject if any ID is missing (preferred for editor), or
  - Lenient mode: ignore missing IDs (preferred for public rendering).

## Garbage collection

Unused images are deleted asynchronously.

Candidates (suggested policy):

- `attached=false`
- `uploadedAt != null`
- `deletedAt == null`
- `detachedAt < now - gracePeriod` (e.g. 24 hours)

GC job steps:

1. Find candidates in pages.
2. Delete R2 object by key.
3. Mark row deleted (`deletedAt`) or hard-delete.

## Security & permissions

- Any **event editor** can upload/finalize/resolve images.
- Reconciliation runs only during event edits (same permission level).

## Appendix: full example

```json
{
  "version": 1,
  "meta": {
    "bannerImage": {
      "kind": "eventImage",
      "id": "evtimg_11111111-1111-4111-8111-111111111111"
    }
  },
  "doc": {
    "type": "doc",
    "content": [
      {
        "type": "heading",
        "attrs": { "level": 1 },
        "content": [{ "type": "text", "text": "My Event Title" }]
      },
      {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "Welcome to the event." }]
      },
      {
        "type": "imageBlock",
        "attrs": {
          "imageId": "evtimg_22222222-2222-4222-8222-222222222222",
          "alt": "Crowd shot",
          "align": "center",
          "width": "full"
        }
      }
    ]
  }
}
```
