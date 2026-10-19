# Announcement Preference Compliance Spec

> Not built yet (2026-10-08 docs consolidation): Phase 3 "My Subscriptions" account UI; EVENT-level opt-in override of ORG opt-out

**Status:** in-progress — Phase 1 (CAN-SPAM headers + org unsubscribe) and Phase 2
(preference enforcement in dispatch) implemented 2026-06-09. Phase 3 ("My
Subscriptions" account UI) deferred. EVENT-level opt-in override of an ORG opt-out
(spec §2 "Preference cascade") is also deferred — `batchReadAnnouncementEmailEnabled`
currently consults GLOBAL + ORG only (OR-to-suppress).

CAN-SPAM compliance for ticket-holder audiences, preference-aware announcement
email dispatch, global mute, org-level unsubscribe, and a user-facing
subscription management surface.

## Current-state audit

### What works

| Mechanism | Status |
| --- | --- |
| `CONTACT_LIST` audience: `List-Unsubscribe` header with HMAC token | Works. Sets `unsubscribedAt` on `InviteListEntry`. |
| `WAITLIST_SUBSCRIBERS` audience: `List-Unsubscribe` header with HMAC token | Works. Sets status `DROPPED` on `EventWaitlistEntry`. |
| In-app/push notifications: routed through `notify` use case | Works. Respects `notificationPrefs.readEffective()`. |

### What is broken or missing

| Gap | Severity | Detail |
| --- | --- | --- |
| **No unsubscribe headers for ticket-holder audiences** | Critical (CAN-SPAM) | `ALL_TICKET_HOLDERS`, `EVENT_TICKET_HOLDERS`, `MULTIPLE_EVENTS`, `EVENT_TICKET_TIER` all have `inviteListId = null` and `waitlistEventId = null` so no `List-Unsubscribe` header is emitted. The CAN-SPAM footer's visible unsubscribe link is also `null` for these. |
| **Announcement emails bypass notification preferences** | High | `send-announcement.ts` calls `deps.mailer.sendBatch()` directly without checking `notificationPrefs.readEffective()`. A user who disables the `announcements` category for email still receives announcement emails. |
| **No org-level unsubscribe concept** | High | Ticket-holder audience membership is implicit (derived from `Order` join). There is no mechanism for a user to say "stop emailing me from this org" apart from marking the entire email channel off globally. |
| **No "My subscriptions" UI** | Medium | Users cannot see which orgs they receive announcements from or manage per-org preferences. |
| **Global mute has no enforcement path for announcement emails** | Medium | `NotificationPreference` with `scopeKind: GLOBAL` exists in the schema but announcement dispatch never reads it. |

---

## 1. Org-level unsubscribe (CAN-SPAM fix)

### Concept

Introduce an **org-scoped unsubscribe** that covers all ticket-holder-based
audiences. When a user unsubscribes from an org's announcements, all future
announcement emails from that org are suppressed, regardless of audience type.

This maps cleanly to the existing `NotificationPreference` model: a row with
`scopeKind = 'ORG'`, `orgId = <org>`, and a delta that disables the
`announcements` category for the `email` channel.

### Token generation

Reuse the existing HMAC pattern from `unsubscribe-from-audience.ts`:

```
payload  = "org:<orgId>:<email>"
token    = HMAC-SHA256(UNSUBSCRIBE_SECRET, payload)  →  hex
```

New export in `unsubscribe-from-audience.ts`:

```typescript
export function generateOrgUnsubscribeToken(
  secret: string,
  orgId: string,
  email: string,
): string;

export function verifyOrgUnsubscribeToken(
  secret: string,
  orgId: string,
  email: string,
  token: string,
): boolean;
```

### Unsubscribe endpoint

New use case: `unsubscribe-from-org-announcements.ts` in
`packages/core/src/use-cases/announcements/`.

```
Input:  { orgId, email, token }
Steps:
  1. Verify HMAC token (constant-time).
  2. Look up Human by email.
  3. If found: upsert NotificationPreference { humanId, scopeKind: 'ORG', orgId }
     with delta: { channels: { email: { announcements: false } } }.
  4. If no Human found: insert a row into a new `AnonymousUnsubscribe` table
     (email + orgId + timestamp) as a fallback suppression list.
  5. Return { ok: true }.
Output: { ok: boolean }
```

Public (unauthenticated) tRPC mutation or Fastify route, same pattern as the
existing `/unsubscribe` page.

### `send-announcement.ts` changes — attach headers

For **all** audience types, generate the org-level unsubscribe URL and set:

```
List-Unsubscribe: <https://app.hearthfire.community/unsubscribe?kind=org&orgId=X&email=Y&token=Z>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

This replaces the current conditional logic that only sets headers for
contact-list and waitlist audiences. Contact-list and waitlist audiences
**additionally** keep their specific unsubscribe headers (so a contact-list
recipient can unsubscribe from that list specifically, while the org-level
link covers the broader opt-out).

Update the CAN-SPAM footer builder to always receive a non-null `unsubUrl`.

---

## 2. Preference-aware announcement email dispatch

### Filtering recipients

Before dispatching emails, the send-announcement use case must filter out
recipients who have opted out.

**Option A — filter in the use case (simpler, preferred for v1):**

After resolving recipients via `listAudienceRecipientEmails`, batch-check
preferences for all `humanId`-bearing recipients:

```typescript
// New port method
interface NotificationPreferencesRepo {
  // ... existing methods
  batchReadEffectiveChannel(inputs: {
    humanId: string;
    scope: NotificationPreferenceScope;
    channel: NotificationPreferenceChannel;
    category: NotificationPreferenceCategory;
  }[]): Promise<Map<string, boolean>>; // humanId → isEnabled
}
```

Filter pseudocode in `send-announcement.ts`:

```
humanIds = recipients.filter(r => r.humanId).map(r => r.humanId)
prefMap = await repos.notificationPrefs.batchReadEffectiveChannel(
  humanIds.map(id => ({
    humanId: id,
    scope: { kind: 'ORG', orgId: input.ownerId },
    channel: 'email',
    category: 'announcements',
  }))
)
// Also check AnonymousUnsubscribe for non-humanId recipients
anonSuppressed = await repos.announcements.getAnonymousUnsubscribes(orgId, emails)

recipients = recipients.filter(r => {
  if (r.humanId && prefMap.get(r.humanId) === false) return false
  if (anonSuppressed.has(r.email)) return false
  return true
})
```

**Option B — filter in SQL (more performant for large audiences):**

Add a `LEFT JOIN` on `NotificationPreference` in the audience queries
themselves, excluding rows where `announcements = false` for the email channel.
More complex, deferred to v2 if performance requires it.

### Preference cascade

The existing `readEffective` already implements cascade: EVENT overrides ORG
overrides GLOBAL. So an org-level opt-out will be respected unless the user
has an explicit EVENT-level opt-in for that org. This is correct behavior.

### Global mute

A `GLOBAL` scope preference with `channels.email.announcements = false`
should suppress all announcement emails. The `batchReadEffectiveChannel`
call uses the org scope, but `readEffective` cascades from GLOBAL, so this
works automatically.

A `GLOBAL` scope with **all** categories set to `false` for **all** channels
constitutes a "mute all" and is respected by both `notify` and now
announcements.

---

## 3. Anonymous unsubscribe suppression table

For recipients who don't have a `humanId` (e.g., imported contact-list entries
that haven't been matched to an auth user), we need a fallback suppression
mechanism.

### New Prisma model

```prisma
model AnonymousEmailSuppression {
  id        String   @id @default(cuid())
  email     String
  orgId     String
  reason    String   @default("unsubscribe") // "unsubscribe" | "bounce" | "complaint"
  createdAt DateTime @default(now())

  @@unique([email, orgId])
  @@index([orgId])
}
```

This table is checked during recipient filtering (step 2) for any recipient
where `humanId` is null.

When an anonymous recipient later creates an account and is matched to a Human,
a background task or login-time hook should migrate their suppression rows into
proper `NotificationPreference` records and delete the anonymous rows.

---

## 4. "My subscriptions" UI

### User-facing page

Route: `apps/web/src/app/account/subscriptions/page.tsx`

This page shows the user a list of organizations they have an implicit
relationship with (derived from orders) and lets them manage per-org
announcement preferences.

### Data source

New tRPC query: `notificationPreferences.listOrgSubscriptions`

```typescript
Input:  { humanId } (from ctx.actorHumanId)
Output: {
  orgs: Array<{
    orgId: string;
    orgName: string;
    orgAvatarUrl: string | null;
    announcementsEnabled: boolean;  // email channel, announcements category
    lastOrderDate: Date;
    orderCount: number;
  }>;
  globalMuteAll: boolean;
}
```

Implementation: query distinct orgs from `Order` table where `humanId` matches,
join org metadata, then batch-read notification preferences for each org scope.

### UI layout

```
┌─────────────────────────────────────────────────────┐
│  Email Subscriptions                                │
│                                                     │
│  ┌─ Global ───────────────────────────────────────┐ │
│  │  Mute all announcement emails     [ toggle ]   │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Organizations ────────────────────────────────┐ │
│  │  🎵 Jazz House Collective                      │ │
│  │     3 orders · Last: Mar 15, 2026              │ │
│  │     Announcement emails              [ toggle ]│ │
│  │                                                │ │
│  │  🎸 Underground Sounds                         │ │
│  │     1 order · Last: Feb 28, 2026               │ │
│  │     Announcement emails              [ toggle ]│ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  You receive announcements from organizations       │
│  you've purchased tickets from. Toggle off to       │
│  stop emails from a specific org.                   │
└─────────────────────────────────────────────────────┘
```

The global toggle maps to `NotificationPreference` with
`scopeKind: GLOBAL`, delta `{ channels: { email: { announcements: false } } }`.

Each org toggle maps to `NotificationPreference` with
`scopeKind: ORG`, `orgId`, delta `{ channels: { email: { announcements: false } } }`.

### Integration with existing account settings

The existing notification preferences page at
`/account/settings#notifications` should link to this page for
"Manage announcement subscriptions" and vice versa.

---

## 5. Unsubscribe landing page update

The existing `/unsubscribe` page needs to handle the new `kind=org` parameter:

```
/unsubscribe?kind=org&orgId=X&email=Y&token=Z
```

On success, show: "You've been unsubscribed from announcements by {Org Name}.
You'll no longer receive announcement emails from this organization."

Optionally offer a "Manage all subscriptions" link that deep-links to
`/account/subscriptions` (requires login).

---

## 6. Implementation plan

### Phase 1 — CAN-SPAM compliance (urgent)

1. Add `generateOrgUnsubscribeToken` / `verifyOrgUnsubscribeToken` to
   `unsubscribe-from-audience.ts`.
2. Update `send-announcement.ts` to always generate org-level unsubscribe
   headers for all audience types.
3. Update CAN-SPAM footer builder to always produce a visible unsubscribe link.
4. Create `unsubscribe-from-org-announcements.ts` use case.
5. Update `/unsubscribe` page to handle `kind=org`.
6. Add `AnonymousEmailSuppression` Prisma model + migration.

**Tests:**
- Verify HMAC token generation/verification round-trips.
- Verify all audience types now produce `List-Unsubscribe` headers.
- Verify unsubscribe use case creates correct preference record.
- Verify anonymous unsubscribe creates suppression row.

### Phase 2 — Preference enforcement in announcement dispatch

7. Add `batchReadEffectiveChannel` to `NotificationPreferencesRepo` port +
   Prisma adapter.
8. Add `getAnonymousUnsubscribes` to announcements repo.
9. Update `send-announcement.ts` recipient filtering to check preferences
   before dispatch.
10. Verify global mute suppresses announcement emails.

**Tests:**
- Org-level opt-out suppresses email for that org's audiences.
- Global mute suppresses all announcement emails.
- EVENT-level opt-in overrides ORG-level opt-out (cascade).
- Anonymous suppression blocks non-humanId recipients.
- Opted-out recipients are excluded from `recipientCount`.

### Phase 3 — Subscription management UI

11. Add `listOrgSubscriptions` tRPC query.
12. Build `/account/subscriptions` page.
13. Wire global mute toggle and per-org toggles.
14. Cross-link from notification settings and unsubscribe confirmation.

**Tests:**
- E2E: toggle org off → announcement email not received.
- E2E: global mute → no announcement emails.
- Org list derived from orders is accurate.

---

## 7. Files touched (estimated)

| Layer | Files |
| --- | --- |
| Core | `use-cases/announcements/send-announcement.ts`, `use-cases/announcements/unsubscribe-from-audience.ts` (new exports), new `unsubscribe-from-org-announcements.ts` |
| Ports | `repos/notification-preferences.ts` (new `batchReadEffectiveChannel`), `repos/announcements.ts` (new `getAnonymousUnsubscribes`) |
| Types | `repos/notification-preferences.ts`, `repos/announcements.ts` |
| Adapters | `db/prisma/notification-preferences-adapter.ts`, `db/prisma/announcements.ts` |
| Transport | `trpc/routers/notification-preferences.ts` (new `listOrgSubscriptions`) |
| DB | New migration: `AnonymousEmailSuppression` model |
| Web | `/unsubscribe` page update, new `/account/subscriptions` page |

---

## 8. Open questions

1. **Should contact-list recipients get BOTH list-specific and org-level
   unsubscribe headers?** Proposed: yes, two `List-Unsubscribe` values in
   the same header. RFC 2369 allows multiple URLs. The list-specific one
   removes them from that list; the org one suppresses all org announcements.

2. **Rate of anonymous-to-human migration.** Should we run this as a
   background job on a schedule, or trigger it at login/signup time? Login-time
   is simpler but adds latency to the auth flow.

3. **Should transactional emails (order confirmations, ticket delivery) be
   affected by org-level unsubscribe?** Proposed: no. The `announcements`
   category is separate from `transactional`. The unsubscribe only targets
   the announcements category.

4. **Digest mode interaction.** If a user has set email frequency to
   `DAILY_DIGEST` for announcements, should individual announcement sends
   be deferred? Currently announcements are always instant. Deferring to
   a future spec.
