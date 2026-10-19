# Event Volunteering Spec

> **Status**: complete
> **Created**: 2026-06-26
> **Last refined**: 2026-04-23
> **Authors**: Engineering Team
> **Depends on**: Generic FormBuilder extraction (`specs/ui/components/generic-form-builder.component.yaml`)
> **Related**: `ApplicationQuestionType` rename to `FormQuestionType` (bundled in FormBuilder spec)

> **Implementation status snapshot**
> - ✅ `packages/db/prisma/volunteer.prisma`, `Event` + `Organization` + `Human` relations, `VolunteerSignupStatus` enum, `VOLUNTEER` in `EventHumanRole` (in consolidated baseline migration)
> - ✅ `packages/types/src/repos/volunteering.ts`, `packages/ports/src/repos/volunteering.ts`
> - ✅ `packages/adapters/src/db/prisma/volunteering.ts`
> - ✅ `packages/core/src/use-cases/volunteering/` — all 8 use cases with Vitest coverage
> - ⏳ Transport (`volunteerRouter`)
> - ⏳ EventBuilder integration
> - ⏳ Org + event admin pages
> - ⏳ Public signup UI
> - ⏳ Notification emails

## Overview

Per-event volunteering system that lets organizers define **volunteer roles** (with optional shift schedules), accept **volunteer applications** via a configurable form, and manage the approval/scheduling lifecycle from the admin dashboard.

### Design principles

- **Reuse over reinvent** — the application form system (`EventApplicationForm`, `EventApplicationQuestion`) already solves customizable question flows. Volunteering forms share the same generic `FormBuilder` infrastructure (extracted separately) so the two features stay in sync.
- **Org-level role templates** — organizers define reusable role templates at the org level (`VolunteerRoleTemplate`) and pull them into individual events. One-off per-event roles are also allowed.
- **Soft capacity** — each role/shift has a noted capacity, but the system does **not** hard-block signups when capacity is reached. Instead, admins see an "over capacity" indicator and can triage from there.
- **Configurable auto-approve** — auto-approve can be toggled per event and overridden per role. When enabled, submissions are immediately approved; when disabled, they land in a review queue.
- **Account required** — volunteers must create an account to view their volunteering status, check-in details, and shift schedule. For initial application, an email-only signup creates a shadow profile (via the existing `ensureGuestHuman` flow) and the applicant is prompted to complete registration.
- **Free-form time ranges** — shifts are admin-defined time windows (start/end datetimes), not rigid slot grids.

---

## What already exists

| Layer | What's built | What this spec adds |
|-------|-------------|---------------------|
| **Schema** | `EventApplicationForm`, `EventApplicationQuestion`, `EventApplicationSubmission`, `ApplicationQuestionType` enum, `EventHumanRole` enum (PERFORMER, HOST, DJ, etc.), `EventHuman` model (nullable humanId + externalName); **`VolunteerRoleTemplate`, `EventVolunteerRole`, `EventVolunteerShift`, `VolunteerSignup` models, `VolunteerSignupStatus` enum, `VOLUNTEER` on `EventHumanRole`, and `Event.volunteeringEnabled`/`volunteerAutoApprove`/`volunteerIntroText` are all merged into the consolidated baseline migration.** | — |
| **Ports** | `HumansRepo.ensureGuestHuman()` for shadow profiles; **`VolunteerRepo` (templates, roles, shifts, signups + `countByRole`/`countByShift`) is live at `packages/ports/src/repos/volunteering.ts`.** | — |
| **Adapters** | Prisma repos for applications, humans; **Prisma `VolunteerRepo` adapter at `packages/adapters/src/db/prisma/volunteering.ts`.** | — |
| **Use cases** | Application form CRUD, submission review; **`manage-role-templates`, `manage-event-volunteer-roles`, `manage-volunteer-shifts`, `submit/review/checkIn/withdraw/listMine/listVolunteerSignups` are all implemented with Vitest coverage.** | — |
| **Notifications** | — | **Three renderers (`volunteer.signup-received`, `…-approved`, `…-rejected`) are registered in `packages/core/src/use-cases/comms/renderers.ts`. Use cases already call `deps.notify(...)` post-commit.** |
| **Transport** | tRPC routers for applications | `volunteerRouter` (not yet built) + extend `events.update` with the three volunteer flags |
| **Web UI** | `ApplicationFormBuilder`, application review page | Volunteer admin pages (templates + event roles/shifts + signups), public signup UI, `EventVolunteeringSection` in `EventBuilder`, `ADMIN_SECTIONS` entry |

---

## Schema changes

### New enums

```prisma
// enums.prisma

enum VolunteerSignupStatus {
  PENDING
  APPROVED
  REJECTED
  WITHDRAWN    // Volunteer withdrew their application
  CHECKED_IN   // Confirmed on-site
  NO_SHOW      // Did not show up
}
```

### Extend `EventHumanRole`

Add `VOLUNTEER` to the existing enum so volunteers appear in the `EventHuman` lineup when approved:

```prisma
enum EventHumanRole {
  PERFORMER
  HOST
  DJ
  INSTRUCTOR
  SPEAKER
  VENDOR
  VOLUNTEER   // ← NEW
  OTHER
}
```

### New models

```prisma
// volunteer.prisma

// ─────────────────────────────────────────────────────────────────────────────
// Volunteering — Org-level role templates, per-event roles, shifts, signups.
// ─────────────────────────────────────────────────────────────────────────────

/// Org-level reusable volunteer role template.
/// Admins define these once and pull them into events.
model VolunteerRoleTemplate {
  id             String   @id @default(uuid())
  orgId          String
  name           String           // e.g., "Bar Staff", "Security", "Stage Hand"
  description    String?
  defaultCapacity Int?             // Suggested capacity when pulled into an event
  sortOrder      Int     @default(0)
  archived       Boolean @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  roles EventVolunteerRole[]

  @@index([orgId, archived])
  @@unique([orgId, name])
}

/// A volunteer role attached to a specific event.
/// May or may not originate from an org template.
model EventVolunteerRole {
  id             String   @id @default(uuid())
  eventId        String
  templateId     String?          // Null = one-off role, not from a template
  name           String           // Copied from template or freeform
  description    String?
  capacity       Int?             // Soft cap — not enforced, used for UI indicators
  autoApprove    Boolean?         // Null = inherit event-level default
  sortOrder      Int     @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  event    Event                  @relation(fields: [eventId], references: [id], onDelete: Cascade)
  template VolunteerRoleTemplate? @relation(fields: [templateId], references: [id], onDelete: SetNull)
  shifts   EventVolunteerShift[]
  signups  VolunteerSignup[]

  @@unique([eventId, name])
  @@index([eventId, sortOrder])
  @@index([templateId])
}

/// A shift (time window) within a volunteer role.
/// Free-form start/end — not quantized into slots.
model EventVolunteerShift {
  id          String   @id @default(uuid())
  roleId      String
  label       String?          // Optional human-readable label, e.g., "Morning shift"
  startsAt    DateTime
  endsAt      DateTime
  capacity    Int?             // Soft cap per shift (independent of role-level cap)
  notes       String?          // Admin-only notes (meeting point, gear, etc.)
  sortOrder   Int     @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  role    EventVolunteerRole @relation(fields: [roleId], references: [id], onDelete: Cascade)
  signups VolunteerSignup[]

  @@index([roleId, sortOrder])
}

/// A volunteer signup / application for a role (and optionally a specific shift).
model VolunteerSignup {
  id              String                @id @default(uuid())
  eventId         String
  roleId          String
  shiftId         String?               // Null = general role signup, not shift-specific
  humanId         String?               // Null when shadow profile not yet linked
  contactEmail    String                // Always captured — primary identifier before account
  contactName     String?               // Captured at signup time
  contactPhone    String?
  status          VolunteerSignupStatus @default(PENDING)
  answers         Json                  @default("{}")  // Form answers (same shape as application answers)
  reviewerHumanId String?
  reviewedAt      DateTime?
  checkedInAt     DateTime?
  notes           String?               // Admin notes on this volunteer
  metadata        Json                  @default("{}")
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt

  event    Event                @relation(fields: [eventId], references: [id], onDelete: Cascade)
  role     EventVolunteerRole   @relation(fields: [roleId], references: [id], onDelete: Cascade)
  shift    EventVolunteerShift? @relation(fields: [shiftId], references: [id], onDelete: SetNull)
  human    Human?               @relation("VolunteerSignupHuman", fields: [humanId], references: [id], onDelete: SetNull)
  reviewer Human?               @relation("VolunteerSignupReviewer", fields: [reviewerHumanId], references: [id], onDelete: SetNull)

  @@unique([eventId, roleId, contactEmail])  // One signup per role per email
  @@index([eventId, status])
  @@index([roleId])
  @@index([shiftId])
  @@index([humanId])
  @@index([reviewerHumanId])
}
```

### Extend `Event` model

Add relations and a top-level volunteering toggle:

```prisma
// In event.prisma — additions to the Event model

  /// Whether volunteering is enabled for this event.
  volunteeringEnabled    Boolean @default(false)
  /// Event-level default for auto-approve. Per-role overrides take precedence.
  volunteerAutoApprove   Boolean @default(false)
  /// Optional intro text shown on the volunteer signup page.
  volunteerIntroText     String?

  // Relations (add to existing block)
  volunteerRoles    EventVolunteerRole[]
  volunteerSignups  VolunteerSignup[]
```

### Extend `Organization` model

```prisma
// In org.prisma — additions to the Organization model

  volunteerRoleTemplates VolunteerRoleTemplate[]
```

---

## Ports

### `VolunteerRepo`

```typescript
// packages/ports/src/repos/volunteer.ts

export interface VolunteerRepo {
  // ── Role templates (org-level) ──────────────────────────────────────
  createRoleTemplate(input: CreateRoleTemplateInput): Promise<RoleTemplateRecord>;
  updateRoleTemplate(id: string, input: UpdateRoleTemplateInput): Promise<RoleTemplateRecord>;
  archiveRoleTemplate(id: string): Promise<void>;
  listRoleTemplates(orgId: string, opts?: { includeArchived?: boolean }): Promise<RoleTemplateRecord[]>;

  // ── Event volunteer roles ───────────────────────────────────────────
  createEventRole(input: CreateEventRoleInput): Promise<EventRoleRecord>;
  updateEventRole(id: string, input: UpdateEventRoleInput): Promise<EventRoleRecord>;
  deleteEventRole(id: string): Promise<void>;
  listEventRoles(eventId: string): Promise<EventRoleWithShiftsRecord[]>;
  getEventRole(id: string): Promise<EventRoleWithShiftsRecord | null>;

  // ── Shifts ──────────────────────────────────────────────────────────
  createShift(input: CreateShiftInput): Promise<ShiftRecord>;
  updateShift(id: string, input: UpdateShiftInput): Promise<ShiftRecord>;
  deleteShift(id: string): Promise<void>;
  listShifts(roleId: string): Promise<ShiftRecord[]>;

  // ── Signups ─────────────────────────────────────────────────────────
  createSignup(input: CreateSignupInput): Promise<SignupRecord>;
  updateSignupStatus(id: string, input: UpdateSignupStatusInput): Promise<SignupRecord>;
  getSignup(id: string): Promise<SignupRecord | null>;
  getSignupByEmail(eventId: string, roleId: string, email: string): Promise<SignupRecord | null>;
  listSignups(eventId: string, opts?: ListSignupsOpts): Promise<OffsetPaginatedResult<SignupRecord>>;
  listSignupsByHuman(humanId: string): Promise<SignupRecord[]>;
  countByRole(eventId: string): Promise<Record<string, number>>;  // roleId → count
  countByShift(roleId: string): Promise<Record<string, number>>;  // shiftId → count
}
```

---

## Use cases

All use cases follow the standard pattern: accept raw input, parse via Zod, depend only on ports, throw typed errors.

### 1. `manage-role-templates`

**Purpose**: Org admins CRUD volunteer role templates.

| Operation | Input | Auth | Notes |
|-----------|-------|------|-------|
| `create` | `{ orgId, name, description?, defaultCapacity? }` | `ensureOrgRole(ADMIN \| OWNER)` | Unique constraint on `(orgId, name)` |
| `update` | `{ id, name?, description?, defaultCapacity?, sortOrder? }` | same | |
| `archive` | `{ id }` | same | Soft archive; does not affect existing event roles |
| `list` | `{ orgId, includeArchived? }` | `ensureOrgRole(ADMIN \| OWNER \| MANAGER)` | |

### 2. `manage-event-volunteer-roles`

**Purpose**: Configure volunteer roles for a specific event.

| Operation | Input | Auth | Notes |
|-----------|-------|------|-------|
| `create` | `{ eventId, templateId?, name, description?, capacity?, autoApprove? }` | org role on event's org | If `templateId` is given, copy name/description/capacity as defaults |
| `createFromTemplates` | `{ eventId, templateIds: string[] }` | same | Bulk-pull from org templates |
| `update` | `{ id, name?, description?, capacity?, autoApprove?, sortOrder? }` | same | |
| `delete` | `{ id }` | same | Cascade-deletes shifts and rejects/withdraws pending signups |
| `list` | `{ eventId }` | same | Returns roles with shift counts and signup counts |

### 3. `manage-volunteer-shifts`

**Purpose**: CRUD shifts within a role.

| Operation | Input | Auth | Notes |
|-----------|-------|------|-------|
| `create` | `{ roleId, label?, startsAt, endsAt, capacity?, notes? }` | org role | `endsAt > startsAt` validation |
| `update` | `{ id, label?, startsAt?, endsAt?, capacity?, notes?, sortOrder? }` | same | |
| `delete` | `{ id }` | same | Nulls out `shiftId` on existing signups |

### 4. `submit-volunteer-signup`

**Purpose**: A user (or guest) applies to volunteer for a role.

**Flow**:
1. Validate the event has `volunteeringEnabled = true`.
2. Validate the requested `roleId` belongs to the event.
3. If `shiftId` is provided, validate it belongs to the role.
4. Check for duplicate signup: unique constraint `(eventId, roleId, contactEmail)`.
5. If user is authenticated, use their `humanId`. Otherwise, call `ensureGuestHuman({ email, name })` to create/resolve a shadow profile.
6. Save form answers (structured the same as application form answers).
7. Determine auto-approve: check role-level `autoApprove` first, fall back to event-level `volunteerAutoApprove`.
8. If auto-approved: set status = `APPROVED`, optionally create an `EventHuman` link with role = `VOLUNTEER`.
9. Send confirmation email (and "complete your account" CTA for shadow profiles).
10. Return the signup record.

**Errors**: `event_not_found`, `volunteering_disabled`, `role_not_found`, `shift_not_found`, `already_signed_up`, `invalid_input`.

### 5. `review-volunteer-signup`

**Purpose**: Admin approves or rejects a pending signup.

**Flow**:
1. Validate the signup exists and is in a reviewable state (`PENDING`).
2. If approving:
   - Set status = `APPROVED`, record `reviewerHumanId` and `reviewedAt`.
   - Create an `EventHuman` entry with role = `VOLUNTEER` and `customRoleLabel = role.name`.
   - Send approval notification email.
3. If rejecting:
   - Set status = `REJECTED`, record reviewer info.
   - Send rejection notification email.
4. Run in a single transaction.

**Errors**: `signup_not_found`, `signup_not_reviewable`, `invalid_input`.

### 6. `check-in-volunteer`

**Purpose**: Mark a volunteer as checked in (for scanner/admin use).

**Flow**:
1. Validate signup is `APPROVED`.
2. Set status = `CHECKED_IN`, record `checkedInAt`.
3. Idempotent: if already `CHECKED_IN`, return success without modification.

### 7. `withdraw-volunteer-signup`

**Purpose**: Volunteer cancels their own signup.

**Flow**:
1. Validate signup belongs to the authenticated human.
2. Set status = `WITHDRAWN`.
3. Remove the corresponding `EventHuman` entry if one was created.

### 8. `list-my-volunteer-signups`

**Purpose**: Authenticated user views their volunteering commitments across events.

Returns signups with event summary, role name, shift details, and status.

---

## Transport (tRPC)

```
volunteerRouter
  ├── templateRouter
  │   ├── create          (mutation, org-authed)
  │   ├── update          (mutation, org-authed)
  │   ├── archive         (mutation, org-authed)
  │   └── list            (query, org-authed)
  ├── roleRouter
  │   ├── create          (mutation, org-authed)
  │   ├── createFromTemplates (mutation, org-authed)
  │   ├── update          (mutation, org-authed)
  │   ├── delete          (mutation, org-authed)
  │   └── list            (query, org-authed)
  ├── shiftRouter
  │   ├── create          (mutation, org-authed)
  │   ├── update          (mutation, org-authed)
  │   ├── delete          (mutation, org-authed)
  │   └── list            (query, org-authed)
  ├── signupRouter
  │   ├── submit          (mutation, public — auth optional)
  │   ├── review          (mutation, org-authed)
  │   ├── checkIn         (mutation, org-authed)
  │   ├── withdraw        (mutation, user-authed)
  │   ├── list            (query, org-authed — paginated, filterable)
  │   ├── listMine        (query, user-authed)
  │   └── counts          (query, org-authed — role/shift counts)
```

---

## Admin UI

### Event-level volunteer management

New admin page at `apps/web/src/app/admin/[slug]/events/[id]/volunteers/`.

Add to event detail nav (not top-level `ADMIN_SECTIONS` — this lives within the event detail sub-navigation, similar to how "Applications" is a sub-page of an event).

**Sub-pages / tabs**:

1. **Roles & Shifts** — CRUD roles (pull from templates or create one-off), add shifts per role. Shows capacity indicators (filled / capacity) with visual warning when over capacity.
2. **Signups** — DataTable of all volunteer signups, filterable by role, shift, and status. Approve/reject actions. Bulk approve. Export to CSV.
3. **Schedule** — Timeline/calendar view of shifts with assigned volunteers. (P2 — can defer to a simple list initially.)

### Org-level role template management

New admin page at `apps/web/src/app/admin/[slug]/volunteer-templates/`.

Add a new entry to `ADMIN_SECTIONS` in `apps/web/src/app/admin/[slug]/layout.tsx`:

```typescript
{
  title: "Volunteer Roles",
  icon: Users,  // from lucide-react
  href: "volunteer-templates",
}
```

**Content**: CRUD list of role templates with name, description, default capacity. Archive/unarchive. Drag-to-reorder.

### Public event page

When `volunteeringEnabled = true`, the event page shows a "Volunteer" section/tab:
- Lists available roles with descriptions and shift times.
- "Apply to Volunteer" button opens the signup form.
- If user is signed in, pre-fills name/email.
- If not signed in, collects email + name (shadow profile created on submit, "create your account to track your status" CTA in confirmation).

---

## Shadow profile handling

The volunteering signup reuses the existing `ensureGuestHuman` infrastructure:

1. **Guest submits signup with email + name** → `ensureGuestHuman({ email, name })` creates a `Human` + shadow `AuthUser` (no password, `emailVerified = false`).
2. **Signup is linked to the humanId** returned by `ensureGuestHuman`.
3. **Confirmation email** includes a "Complete your account" link that leads to the standard sign-up flow. Better Auth's `ensureByProvider` or standard registration will find the existing `AuthUser` by email and link it, upgrading the shadow into a full account.
4. **When the user later signs in**, `ensureAuthedHuman` finds the existing `Human` row (already linked) — no duplicate is created.

This is consistent with how `PendingTicketTransfer` works for email-based ticket transfers. No new "shadow profile" infrastructure is needed.

---

## Capacity indicator behavior

Since capacity is soft (not enforced):

- UI shows `{signupCount} / {capacity}` badge next to each role/shift.
- When `signupCount >= capacity`, the badge turns amber/warning. The "Apply" button remains enabled.
- Admin dashboard highlights over-capacity roles in the signups table.
- No server-side enforcement — the signup use case does not reject based on capacity.

---

## Migration plan

1. **Schema**: Create `volunteer.prisma` with all new models. Add fields to `Event` and `Organization` models. Add `VOLUNTEER` to `EventHumanRole` enum. New enum `VolunteerSignupStatus`. Run `prisma migrate dev --name add_volunteering`.
2. **Types + Ports**: Add repo DTOs and `VolunteerRepo` interface.
3. **Adapters**: Implement Prisma `VolunteerRepo`.
4. **Use cases**: Implement in order: templates → roles → shifts → signup → review → check-in → withdraw → list-mine.
5. **Transport**: Wire up `volunteerRouter`.
6. **UI**: Org templates page → event roles/shifts admin → public signup → signups review page.

---

## Open questions

- **Volunteer perks / comp tickets**: Should approved volunteers automatically receive a comp ticket? This ties into the separate comp ticket issuance spec. For now, this spec treats volunteering as its own flow; comp tickets can be issued manually by admins.
- **Volunteer check-in via scanner app**: The scanner app currently handles ticket QR codes. Extend to volunteer check-in? Deferred to a follow-up spec.
- **Notification preferences**: Should volunteers receive shift reminders? Defer to notifications spec.
- **Form customization per role**: Currently the signup form is event-wide. Per-role custom questions could be a future enhancement (the form builder supports it structurally, just needs a `roleId` FK on the form).

---

## Vertical slices (implementation order)

| Slice | Layers | Estimated effort |
|-------|--------|-----------------|
| 1. Schema + types + ports | DB, `@th/types`, `@th/ports` | S |
| 2. Adapter + templates use cases | `@th/adapters`, `@th/core` | M |
| 3. Event roles + shifts use cases | `@th/core` | M |
| 4. Signup + review use cases | `@th/core` | M |
| 5. tRPC router | `@th/transport` | S |
| 6. Org templates admin page | `apps/web` | S |
| 7. Event roles/shifts admin page | `apps/web` | M |
| 8. Signups review admin page | `apps/web` | M |
| 9. Public volunteer signup UI | `apps/web`, `@th/ui` | M |

---

## Refinements (2026-04-23)

This section resolves integration gaps that were not covered in the original draft. These
are binding for the remaining slices (5–9).

> **Status check (2026-04-23)**: The backend is further along than the original draft
> implied. All four use-case modules, the Prisma `VolunteerRepo` adapter, the ports, repo
> DTOs, Prisma schema, migrations, and the three notification **renderers** already exist
> and have passing tests. The remaining work is transport + UI + the EventBuilder toggle +
> `ADMIN_SECTIONS` wiring.

### R1. Notification emails

Already wired through the shared `notify` use case (not a direct `MailerPort.send`).

- Use cases inject `notify: (input: NotifyInput) => Promise<NotifyOutput>` (see
  `VolunteerSignupDeps` in `packages/core/src/use-cases/volunteering/volunteer-signups.ts`).
- Renderers live in `packages/core/src/use-cases/comms/renderers.ts` and are keyed by
  **kebab-case** variant ids — do **not** change these:

| Variant id | Fires from | Notes |
|------------|-----------|-------|
| `volunteer.signup-received` | `submitVolunteerSignup` (after commit, both APPROVED and PENDING). | Payload includes `status`, optional `shiftLabel/shiftStartsAtIso/shiftEndsAtIso`, optional `accountCompletionUrl` (shadow profiles only), optional `organizerContactEmail`. |
| `volunteer.signup-approved` | `reviewVolunteerSignup` when `decision=APPROVED`. | Payload adds `reviewerName?`. |
| `volunteer.signup-rejected` | `reviewVolunteerSignup` when `decision=REJECTED`. | Payload adds `reviewerName?`, `rejectionNote?`. |

- No hand-rolled HTML. Renderer schemas are authoritative; the transport/UI layers must never
  dispatch volunteer mail outside these three variants.
- Failure policy (already implemented): mail failures must **not** roll back the signup/
  review transaction. Current code swallows and `logger.warn`s with
  `volunteering.submitVolunteerSignup.notify_failed` /
  `volunteering.reviewVolunteerSignup.notify_failed`. During Option A we'll upgrade those
  warns to `logAndAlert` with code `volunteer_mail_failed` to match the hot-path playbook.
- Subject copy and CTA labels are owned by the renderer modules — no additional `@th/locale`
  strings are required at this stage.

### R2. EventBuilder integration

- New collapsible section component:
  `apps/web/src/app/admin/[slug]/events/new/_components/EventVolunteeringSection.tsx`.
- Rendered **inside** the existing `AdvancedSection` block in `EventBuilder.tsx`, immediately
  after `EventWaiverSection`. It must follow the same `FormSection` + `SectionDivider` pattern
  and live behind the "Advanced Settings" reveal — volunteering is opt-in, so it stays out of
  the primary create flow.
- Fields:
  - `volunteeringEnabled` — switch. When off, the other two fields hide.
  - `volunteerAutoApprove` — switch, disabled when `volunteeringEnabled=false`.
  - `volunteerIntroText` — textarea, `maxLength=2000`. Rendered as plain text on the public
    page (no rich text to keep scope small; can upgrade to ProseMirror later).
  - Info link: "Manage roles & shifts" → `/admin/[slug]/events/[id]/volunteers` (shown only
    once the event has been saved, i.e. `eventId != null`).
- Persistence uses the existing `trpc.events.update` mutation. Extend its input schema with the
  three new optional fields; no new endpoint.

### R3. Public event page placement

- On the event detail page, volunteering surfaces as a dedicated **section**, not a tab. It
  renders below the existing "About" / description block and above the footer, only when:
  `event.volunteeringEnabled === true` **and** the event has at least one `EventVolunteerRole`.
- The section shows:
  - Intro heading + `volunteerIntroText` (falls back to a default copy key).
  - One card per role with name, description, capacity indicator (`{count}/{capacity}`), and
    a list of shift windows.
  - A single **"Volunteer"** CTA opening a sheet/modal with the signup form.
- Behavior vs. event lifecycle:
  - Past events (`endsAt < now`): hide the section entirely.
  - Sold-out events: **still show**. Volunteering is independent of ticket inventory.
  - Cancelled events: hide the section.
- No placement inside checkout or ticketing flow; volunteer signup is strictly a separate
  action.

### R4. Capacity counts wiring

- The public event page uses a single `trpc.volunteer.publicRoles.list` query that returns the
  roles with embedded shift lists and pre-computed `signupCount` per role and per shift
  (backed by `countByRole` + `countByShift`).
- This query is cached via React Query's default `staleTime` (no extra SSR caching layer in
  v1). Counts are "eventually consistent" — we accept up to a minute of lag.
- The admin "Roles & Shifts" page uses `trpc.volunteer.roles.list` which returns the same
  shape plus admin-only fields (autoApprove, internal notes).
- No new port method required; `VolunteerRepo.countByRole` / `countByShift` already exist.

### R5. Admin-side check-in (scanner deferred)

Scanner-app check-in remains deferred. For v1 we surface a manual check-in path:

- On the Signups admin page, each row with `status=APPROVED` shows a **"Check in"** row
  action that calls `trpc.volunteer.signups.checkIn`.
- Once `status=CHECKED_IN`, the action changes to a read-only badge with timestamp.
- No separate screen; this lives inside the existing signups DataTable.
- Scanner extension tracked as a follow-up (`docs/specs/.../volunteer-scanner.spec.md`,
  not yet created).

### R6. Shadow-profile account completion link

- `submit-volunteer-signup` composes the account completion URL as:
  `${APP_BASE_URL}/auth/complete?email=${encodeURIComponent(email)}&src=volunteer&event=${eventId}`.
- `APP_BASE_URL` is resolved from `packages/config` the same way order-receipt CTAs already do.
- The existing `/auth/complete` page (Better Auth) looks up the `AuthUser` by email and, if
  the account is still a shadow (no password / no verified providers), walks the user through
  password setup / OAuth linking. No new page is required — we just pass `src=volunteer` so
  analytics can attribute the conversion.
- The link is included in `VolunteerSignupReceived` **only** when the signup was created via
  `ensureGuestHuman` (i.e. no authenticated session at submit time). For authed submitters,
  the prop is omitted and the button is suppressed.

### R7. Auto-approve side effects (clarification)

This was ambiguous in the original flow for `submit-volunteer-signup`:

- When auto-approve fires, the use case must **also** create the `EventHuman` row (same as
  manual approval) inside the same `repos.tx()` call. The "optionally" wording in the
  original step 8 is replaced with **must**.
- On withdraw, the `EventHuman` row is removed in the same transaction as the status flip.
- On reject (when previously approved via override/rescind path — not currently supported),
  the `EventHuman` row is removed as well. For v1, reject is only available from `PENDING`
  so this path is a no-op.

### R8. Error code additions

Thrown use-case errors carry a `code` discriminator; the tRPC router maps them to `TRPCError`
codes via the shared `toTrpcError` helper:

- `not_found` → `NOT_FOUND` (messages: `event_not_found`, `role_not_found`, `shift_not_found`, `signup_not_found`)
- `conflict` → `CONFLICT` (messages: `volunteering_disabled`, `already_signed_up`, `signup_not_reviewable`, `signup_not_approved`)
- `invalid_input` → `BAD_REQUEST`
- `forbidden` → `FORBIDDEN` (raised by `requireOrgMembership`)

Note: `volunteering_disabled` is intentionally modeled as a **conflict**, not a
`PRECONDITION_FAILED` — volunteering can be toggled off while signups are open, and the
client UX treats the state the same as "already signed up" (show a friendly banner, do not
retry automatically).

`appBaseUrl` for the shadow-profile CTA (R6) is sourced from `ctx.publicAppUrl` on `TrpcDeps`
and passed into the use-case deps. No new config key is required.

---

## Revised vertical slices (remaining work)

| Slice | Layers | Notes |
|-------|--------|-------|
| 5. tRPC `volunteerRouter` | `@th/transport/trpc` | Implements R8 error mapping. Extends `events.update` input with the three new event fields. |
| 6. Email templates | `@th/ui-email`, `@th/locale` | R1. No use-case changes — use cases already call a `notifier` dep; wire it to `MailerPort.send` with new template ids. |
| 7. Org volunteer-templates admin page | `apps/web` | Add `ADMIN_SECTIONS` entry. |
| 8. EventBuilder volunteer section | `apps/web` | R2. |
| 9. Event roles/shifts admin page | `apps/web` | Under event detail nav. |
| 10. Event signups review page | `apps/web` | Includes R5 check-in action. |
| 11. Public volunteer signup UI | `apps/web`, `@th/ui` | R3 + R4 + R6. |
