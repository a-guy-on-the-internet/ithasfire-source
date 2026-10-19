# Announcements Feature Spec

> **Status:** v1 complete, deferred items captured below.
> **Admin route:** `/admin/[slug]/announcements`
> **Nav entry:** Already added — Megaphone icon, "Announcements" label in `ADMIN_SECTIONS`.

## Purpose

Organizer-facing broadcast messaging: event cancellations, schedule changes,
ticket-holder updates, and general audience communications. This replaces the
placeholder "Alerts" page that was renamed to "Announcements."

---

## v1 Scope (minimal viable)

### Backend

| Layer    | Artifact                       | Notes |
| -------- | ------------------------------ | ----- |
| Schema   | `Announcement` model (Prisma)  | `id`, `orgId`, `eventId?`, `subject`, `bodyDoc` (ProseMirror JSON), `bodyHtml`, `audienceType` enum (`ALL_TICKET_HOLDERS`, `EVENT_TICKET_HOLDERS`, `CONTACT_LIST`), `audienceRef?` (eventId or contactListId), `sentAt`, `sentBy`, `createdAt` |
| Port     | `AnnouncementRepo`             | `create`, `findById`, `listByOrg` (paginated + cursor) |
| Use case | `send-announcement`            | Validate input (Zod), resolve audience, render HTML from ProseMirror body via `proseMirrorDocToHtml`, enqueue emails via existing `notify` / email channel, persist `Announcement` record, audit log. Must be idempotent (one send per announcement ID). |
| Use case | `list-announcements`           | Paginated list for the admin history view. |
| Adapter  | Prisma `AnnouncementRepo`      | Standard CRUD adapter. |
| Transport | tRPC `announcements.send`, `announcements.list` | Org-scoped, RBAC via `ensureOrgRole`. |

### Frontend

| Component | Description |
|-----------|-------------|
| `/admin/[slug]/announcements/page.tsx` | History table (subject, audience, date, sent-by) + "Compose" button |
| `ComposeAnnouncementDialog.tsx` | Modal with: subject line input, audience picker (dropdown: all ticket holders / specific event / contact list), ProseEditor for body, "Send Now" button with confirmation |
| Email template | `AnnouncementEmail` in `packages/ui-email` — renders subject + HTML body. Includes unsubscribe link keyed to `announcements` notification-preference category. |

### Integration points

- **Notification preferences:** The `announcements` category already exists in
  `packages/core/src/use-cases/comms/categories.ts`. Recipients who have opted
  out of `announcements` must be filtered before send.
- **Contact lists / import-contacts:** Reuse existing `merge-contact-lists` and
  `import-contacts` use cases for the `CONTACT_LIST` audience type.
- **ProseEditor:** Reuse the rich text editor (see "Rich text editor" section below).

---

## Rich text editor

The ProseEditor currently lives at:
```
apps/web/src/app/admin/[slug]/events/new/_components/prose-editor/
```

### Current coupling assessment

The editor itself is **mostly generic**. The `ImageBlock` TipTap extension now
stores an `imageId` attribute (genericized from `eventImageId`) and resolves URLs
through an `imageUrlMap` prop. Everything else (toolbar, bubble menu, StarterKit
config, Link extension, styled containers) is domain-agnostic.

**What to do for v1:** Use the ProseEditor as-is *without* the image upload
feature. The `onImageUpload` and `imageUrlMap` props are already optional — when
omitted, the image button is hidden and `ImageBlock` is not registered. This
means announcements get bold/italic/strikethrough, links, headings, lists,
blockquotes, and horizontal rules out of the box with zero refactoring.

### Image model genericization (completed)

The `Image` model is now generic with `ownerType` (`EVENT` | `ORG`) and
`ownerId` fields. The `ImageBlock` attribute has been renamed from
`eventImageId` to `imageId`. When image uploads are needed in announcements:

1. **Move** `prose-editor/` to a shared location:
   - Option A: `apps/web/src/components/prose-editor/` (app-level shared)
   - Option B: `packages/ui/src/prose-editor/` (cross-app shared, heavier lift
     because `@th/ui` doesn't currently bundle TipTap)
   - **Recommendation:** Option A for now. It stays in the web app but is
     importable from any admin page without path gymnastics.

2. **Abstract the upload handler:** The `ImageUploadHandler` type is already
   generic (`(file: File) => Promise<ImageBlockAttributes | null>`). The only
   change needed is that the *caller* provides a different upload endpoint
   (event images vs. announcement images vs. generic uploads). No editor
   changes required.

3. **Update `prose-utils.ts`:** `proseMirrorDocToHtml` and `htmlToProseMirrorDoc`
   are fully generic. Move them alongside the editor.

4. **Update imports:** `EventBuilder.tsx`, `EventPreview.tsx`, and
   `useEventImageUpload.ts` would import from the new shared path. The
   announcements compose form would import from the same place.

---

## Deferred features (post-v1)

### Scheduled / delayed sends

- Add `scheduledFor` datetime field to `Announcement` model.
- Use a cron job (or the existing `apps/jobs` Cloud Run task) to pick up
  unsent announcements where `scheduledFor <= now()`.
- UI: date/time picker in compose dialog, status badge in history table.

### SMS and push notification channels

- Extend `send-announcement` to fan out across channels (email, SMS, push)
  based on recipient preferences.
- Requires: Twilio/SMS adapter, Expo push adapter, per-channel
  `announcements` preference toggles.
- Cost implications: SMS is pay-per-message; needs usage tracking + org
  billing integration.

### Template library

- Predefined announcement templates (event cancellation, schedule change,
  general update) with placeholder tokens (`{{eventName}}`, `{{venueName}}`).
- UI: template picker in compose dialog, "Save as template" action.
- Storage: `AnnouncementTemplate` Prisma model, org-scoped.

### Rich text editor enhancements

- Image uploads in announcements (see genericization plan above).
- Embed blocks (YouTube, Spotify preview for artist events).
- Token/variable insertion toolbar (`{{firstName}}`, `{{eventName}}`).
- Full rich text → plain text fallback for SMS channel.

### Analytics

- Open rate tracking (tracking pixel in email).
- Click tracking (link rewriting through a redirect endpoint).
- Dashboard in announcements history: sent, delivered, opened, clicked.
- Per-announcement detail view with recipient-level status.

### Audience segmentation

- Beyond "all ticket holders" / "event ticket holders" / "contact list":
  - Ticket tier filtering (e.g., only VIP holders).
  - Geographic filtering (by ticket-holder location).
  - Purchase recency (bought in last N days).
  - Custom saved segments.

### A/B testing

- Split audience into variants, send different subject lines or body copy.
- Track open/click rates per variant.
- Auto-send winner after a configurable window.

### Recipient preview & test send

- "Send test to myself" button before broadcasting.
- Recipient count preview ("This will be sent to ~342 people").
- Dry-run mode that logs what *would* be sent without actually dispatching.

### Unsubscribe management UI

- Admin-visible list of recipients who unsubscribed from `announcements`.
- Bulk re-subscribe (with consent flow) for GDPR compliance.

### Audit trail

- Full audit log of who sent what, when, to whom.
- Integrates with existing `repos.auditLogs` pattern.

---

## Open questions

1. **Org-scoped vs. platform-scoped:** v1 targets organizer announcements
   (org-scoped). Platform-wide announcements (from Ithas Fire staff to all
   users) could reuse the same system with a `platformAnnouncement` flag, but
   that's deferred. 
   Platform will have its own announcements tab
2. **Rate limiting:** Should there be a max announcements-per-day per org to
   prevent spam? Probably yes — defer to v1 implementation.
   Also yeah like 4. If they need more they can contact support.
3. **Bounce handling:** Email bounces should update contact status. The existing
   comms infrastructure may already handle this; verify during implementation.
   I don't think this being handled.
