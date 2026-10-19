# EntityFollow — Generalized Follow System

**Status:** complete
**Priority:** P1  
**Supersedes:** `docs/specs/2026-03-18/fan-follow-notify.spec.yaml` (ArtistFollow model — replace entirely with EntityFollow)

---

## Goal

Fans can follow any entity — a Human (performer/artist), a Place (venue), or an
Organization — and receive event notifications tied to that entity.  Entity owners
see aggregate follower analytics on their entity page.  **No Fan PII is ever
surfaced to the followed entity or the public.**

This generalizes the Human→Human ArtistFollow model to all three `PageOwnerType`
values and connects follow counts to the opt-in stats layer on entity pages.

---

## Context

| What exists | Where |
|---|---|
| `ArtistFollow` (Human→Human only) | `docs/specs/2026-03-18/fan-follow-notify.spec.yaml` |
| `EntityPage` (Human \| Place \| Org) | `packages/db/prisma/entity-page.prisma` |
| `PageOwnerType` enum | `packages/db/prisma/enums.prisma` → `HUMAN \| ORGANIZATION \| PLACE` |
| Notification infra | `Notification`, `NotificationDigestSubscription`, `PushDevice` models |
| Stats layer | `docs/specs/2026-04-13/place-human-org-stats.spec.md` |

---

## Data Model

### New model: `EntityFollow`

```prisma
model EntityFollow {
  id              String   @id @default(uuid())

  // The follower is always a Human (fans are humans)
  followerHumanId String

  // The followed entity is identified via its EntityPage
  // (covers HUMAN, PLACE, and ORGANIZATION ownerTypes)
  entityPageId    String

  // Notification prefs per follow relationship
  notifyNewEvents Boolean  @default(true)
  notifyNearby    Boolean  @default(false)
  radiusKm        Int?     // null = no proximity filter; used only when notifyNearby = true

  createdAt       DateTime @default(now())

  follower        Human      @relation("HumanFollowing",   fields: [followerHumanId], references: [id])
  entityPage      EntityPage @relation("PageFollowers",     fields: [entityPageId],    references: [id])

  @@unique([followerHumanId, entityPageId])   // idempotent follow; prevents duplicates
  @@index([entityPageId])                     // hot path: count followers of an entity
  @@index([followerHumanId])                  // hot path: what a fan is following
}
```

### Additions to `EntityPage`

```prisma
// New fields on EntityPage
allowFollows      Boolean  @default(true)   // entity owner can turn off follows entirely
showFollowerCount Boolean  @default(false)  // opt-in: expose count to public on entity page
```

`showFollowerCount = false` is the default — entity owners must explicitly opt in to
display the count.  This prevents new pages from showing "3 followers" before they
have any social proof.

### Human relation additions

```prisma
// On Human model
following     EntityFollow[]  @relation("HumanFollowing")
```

EntityPage already has the `id` which backs the follow; the `EntityPage` relation
`"PageFollowers"` points to the follow rows for that page.

---

## Migration from `ArtistFollow`

The existing `ArtistFollow` rows map cleanly to `EntityFollow`:

```
ArtistFollow.followerHumanId → EntityFollow.followerHumanId
ArtistFollow.artistHumanId   → EntityFollow.entityPageId
  (resolve via EntityPage WHERE ownerType='HUMAN' AND ownerId=artistHumanId)
ArtistFollow.notifyNewEvents → EntityFollow.notifyNewEvents
ArtistFollow.notifyNearby    → EntityFollow.notifyNearby
ArtistFollow.radiusKm        → EntityFollow.radiusKm
ArtistFollow.createdAt       → EntityFollow.createdAt
```

Migration steps:
1. Create `EntityFollow` table.
2. Run data-migration script: for each `ArtistFollow`, look up the Human's
   `EntityPage` (ownerType=HUMAN, ownerId=artistHumanId) and insert an
   `EntityFollow` row.  Skip rows where no EntityPage exists (artist has no
   public page — they'll get one when they claim their profile).
3. Verify counts match within tolerance (allow for missing EntityPage gaps).
4. Drop `ArtistFollow` table.
5. Update all use-case and adapter code to target `EntityFollow`.

---

## Use Cases

All use cases live under `packages/core/src/use-cases/follows/`.

### `followEntity`

```
location: packages/core/src/use-cases/follows/follow-entity.ts
input:    { actorHumanId: string; entityPageId: string; notifyNearby?: boolean; radiusKm?: number }
output:   { followId: string; alreadyFollowing: boolean }
flow:
  1. Zod-parse input.
  2. Load EntityPage by id; throw { code: "not_found" } if missing or visibility ≠ PUBLIC.
  3. Throw { code: "forbidden" } if EntityPage.allowFollows = false.
  4. Prevent self-follow: if ownerType=HUMAN AND ownerId=actorHumanId → throw { code: "self_follow_not_allowed" }.
  5. Upsert EntityFollow (idempotent — re-following returns existing followId).
  6. Invalidate Redis follower-count cache for entityPageId.
  7. Return { followId, alreadyFollowing: was already present }.
authz: Any authenticated Human.
```

### `unfollowEntity`

```
location: packages/core/src/use-cases/follows/unfollow-entity.ts
input:    { actorHumanId: string; entityPageId: string }
output:   { success: boolean }
flow:
  1. Delete EntityFollow where (followerHumanId, entityPageId) = (actor, target).
  2. Idempotent — unfollowing a non-followed entity returns success: true.
  3. Invalidate Redis follower-count cache for entityPageId.
authz: Any authenticated Human.
```

### `listFollowedEntities`

```
location: packages/core/src/use-cases/follows/list-followed-entities.ts
input:    { actorHumanId: string; ownerTypeFilter?: PageOwnerType; cursor?: string; limit?: number }
output:
  {
    items: {
      followId:     string;
      entityPageId: string;
      slug:         string;
      displayName:  string;
      avatarUrl:    string | null;
      ownerType:    PageOwnerType;
      followedAt:   Date;
    }[];
    nextCursor: string | null;
  }
flow:
  - JOIN EntityFollow + EntityPage WHERE followerHumanId = actor.
  - Optional filter by ownerType.
  - Cursor pagination by EntityFollow.createdAt DESC.
authz: Actor sees own follows only.
```

### `getEntityFollowerCount`

```
location: packages/core/src/use-cases/follows/get-entity-follower-count.ts
input:    { entityPageId: string }
output:   { count: number; isPublic: boolean }
flow:
  1. Load EntityPage; check showFollowerCount.
  2. COUNT(*) EntityFollow WHERE entityPageId; cache in Redis (key:
     entity-followers:{entityPageId}, TTL 5 min).
  3. Return count and whether the entity has opted in to public display.
authz: Public — no auth required.
notes: >
  Callers must check isPublic before rendering.  The count is always
  computed and returned so entity owners can see it in their dashboard
  regardless of the public setting.
```

### `getEntityFollowerStats`

```
location: packages/core/src/use-cases/follows/get-entity-follower-stats.ts
input:    { actorId: string; entityPageId: string }
output:
  {
    totalFollowers:  number;
    newLast7Days:    number;
    newLast30Days:   number;
    // No Fan PII — no names, emails, or identifiers ever returned
  }
flow:
  1. Verify actor owns the entity (EntityPage.ownerId = actorId for the
     actor's ownerType) or has PLATFORM_ADMIN role.
  2. Query EntityFollow counts with date bucketing.
  3. Never include follower humanIds, names, emails, or any identifying
     fields in the response.
authz: Entity owner + platform admin only.
```

### `updateFollowPreferences`

```
location: packages/core/src/use-cases/follows/update-follow-preferences.ts
input:    { actorHumanId: string; entityPageId: string; notifyNewEvents: boolean; notifyNearby: boolean; radiusKm?: number }
output:   { followId: string }
flow:
  1. Load EntityFollow; throw { code: "not_found" } if actor is not following.
  2. Update notifyNewEvents, notifyNearby, radiusKm.
authz: Actor must be the follower.
```

### `updateEntityFollowSettings`

```
location: packages/core/src/use-cases/follows/update-entity-follow-settings.ts
input:    { actorId: string; entityPageId: string; allowFollows: boolean; showFollowerCount: boolean }
output:   { entityPageId: string }
flow:
  1. Verify actor owns the EntityPage.
  2. Update EntityPage.allowFollows and EntityPage.showFollowerCount.
  3. If allowFollows transitions false → true: no action needed (existing follows stay).
  4. If allowFollows transitions true → false: do NOT delete existing follows —
     just block new ones.  This matches Instagram/Facebook behavior and avoids
     data loss.
authz: Entity owner only.
```

### `notifyEntityFollowers`

```
location: packages/core/src/use-cases/follows/notify-entity-followers.ts
input:    { entityPageId: string; eventId: string }
output:   { notifiedCount: number }
flow:
  1. Load event (lat/lng, title, date, venue name, slug).
  2. Load EntityPage to get entity display name.
  3. Query EntityFollow WHERE entityPageId AND notifyNewEvents = true.
  4. For followers with notifyNearby = true:
       a. Resolve follower location (most recent order's event coordinates;
          fallback to HumanLocation if present; skip if none).
       b. Compute haversine distance; skip if > radiusKm.
  5. Batch-insert Notification rows (in-app).
  6. Queue email digest entries for followers with email prefs enabled.
  7. For high fan-out (>1,000 followers), hand off to a Cloud Run jobs worker
     and return early — caller gets notifiedCount = 0 with a queued=true flag.
authz: Internal — called from event publish trigger and jobs worker only.
```

---

## Triggers

| Event | Condition | Action |
|---|---|---|
| EventHuman created (role = PERFORMER \| DJ \| HOST) | Event.status = PUBLISHED | Queue `notifyEntityFollowers` for performer's EntityPage |
| Event status → PUBLISHED | Event has EventHuman rows with performer roles | For each performer without a sent-notification record, queue `notifyEntityFollowers` |
| Event created at a Place | Event.status = PUBLISHED | Queue `notifyEntityFollowers` for the Place's EntityPage |
| Event created by an Org | Event.status = PUBLISHED | Queue `notifyEntityFollowers` for the Org's EntityPage |
| Notification dedup | Any of the above | Store sent flag in `EntityEventNotificationLog(entityPageId, eventId)` — prevents double-send on re-publish |

---

## Notification Content

| Entity type | In-app message | Push |
|---|---|---|
| HUMAN (performer) | "{Name} is performing at {Venue} on {Date}" | "[Name] just announced a show near you" |
| PLACE (venue) | "{Venue} has a new event: {Event Title} on {Date}" | "New event at {Venue} near you" |
| ORGANIZATION | "{Org} is hosting {Event Title} on {Date}" | "{Org} just announced a show near you" |

All notifications link to `/events/{slug}`.

---

## Port Interface

```typescript
// packages/ports/src/repos/follows.ts
export interface FollowsRepo {
  upsertFollow(data: {
    followerHumanId: string;
    entityPageId: string;
    notifyNewEvents?: boolean;
    notifyNearby?: boolean;
    radiusKm?: number;
  }): Promise<EntityFollowRecord>;

  deleteFollow(followerHumanId: string, entityPageId: string): Promise<void>;

  getFollow(followerHumanId: string, entityPageId: string): Promise<EntityFollowRecord | null>;

  listByFollower(
    followerHumanId: string,
    opts: PaginationOpts & { ownerTypeFilter?: PageOwnerType }
  ): Promise<Paginated<EntityFollowRecord & { entityPage: EntityPageSummary }>>;

  listByEntity(
    entityPageId: string,
    opts: PaginationOpts
  ): Promise<Paginated<EntityFollowRecord>>;
  // ⚠ Returns follow records only — no Human PII (no name/email joins)

  countByEntity(entityPageId: string): Promise<number>;

  countByEntitySince(entityPageId: string, since: Date): Promise<number>;

  listFollowersNearLocation(
    entityPageId: string,
    location: { lat: number; lng: number },
    opts?: { batchSize?: number }
  ): Promise<EntityFollowRecord[]>;
  // Returns only follow records with radiusKm filter — no Human data

  updateFollowPreferences(
    followerHumanId: string,
    entityPageId: string,
    prefs: { notifyNewEvents: boolean; notifyNearby: boolean; radiusKm?: number }
  ): Promise<EntityFollowRecord>;
}
```

---

## tRPC Transport

```
router: follows
procedures:
  - name: followEntity          type: mutation   auth: required
  - name: unfollowEntity        type: mutation   auth: required
  - name: listFollowedEntities  type: query      auth: required
  - name: getFollowerCount      type: query      auth: none      # public; check isPublic flag
  - name: getFollowerStats      type: query      auth: required  # owner only
  - name: isFollowing           type: query      auth: required  # { entityPageId } → boolean
  - name: updateFollowPrefs     type: mutation   auth: required
  - name: updateFollowSettings  type: mutation   auth: required  # entity owner
```

---

## Entity Page UI Integration

### Public entity page (`/places/[slug]`, `/p/[slug]`)

- **FollowButton** — "Follow" / "Following" toggle using `isFollowing` query with
  optimistic update.  Shows follower count next to button only when
  `EntityPage.showFollowerCount = true` and count ≥ 10 (threshold prevents
  embarrassingly small numbers on new pages).
- **EntityPageShell** receives `followerCount` and `showFollowerCount` props from
  `loadEntityPageBySlug` SSR; passes them to the shell header area.

### Entity owner dashboard

| Surface | Content |
|---|---|
| `/dashboard/followers` (Human) | Total count, +7d, +30d growth, follow notification settings |
| `/admin/[slug]/followers` (Place/Org) | Total count, +7d, +30d growth, allowFollows toggle, showFollowerCount toggle |

**No follower names, emails, or identifiers appear anywhere in the dashboard.**
The owner sees numbers only.

### Follow settings (entity owner)

```
Allow follows:            [toggle]  default ON
Show follower count publicly:  [toggle]  default OFF
```

Toggling "Show follower count publicly" surfaces or hides the count on the public
entity page.  Turning off "Allow follows" stops new follows but does not delete
existing ones.

---

## Privacy Rules

| Rule | Detail |
|---|---|
| No Fan PII ever | Follower names, emails, humanIds are NEVER returned to the followed entity or the public |
| Private follower list | Only the entity owner can query follow stats (counts + growth) — never individual follower identities |
| Opt-in public count | `showFollowerCount = false` by default; entity must enable this |
| Allow-follows toggle | Entity can disable new follows; existing follows preserved |
| Follower list is private | Public entity pages show count only (when enabled), never a list |
| Rate limiting | 20 follow/unfollow operations per minute per user |

---

## Performance

| Concern | Strategy |
|---|---|
| Follower count (hot read) | Redis cache `entity-followers:{entityPageId}` TTL 5 min; invalidate on follow/unfollow |
| Notification fan-out | Inline for < 1,000 followers; Cloud Run job for ≥ 1,000 (batch 100 inserts at a time) |
| `isFollowing` query | Indexed `@@unique([followerHumanId, entityPageId])` — single PK lookup |
| Location resolution for proximity | Resolve from most recent order's event coordinates; cache 24h in Redis |
| `listByFollower` (stats feed) | `@@index([followerHumanId])` covers cursor pagination |

---

## Stats Layer Integration

The `followerCount` field in `PlaceStats`, `HumanStats`, and `OrgStats` (see
`docs/specs/2026-04-13/place-human-org-stats.spec.md`) is materialized from the
`EntityFollow` count.  The stats background jobs call `repos.follows.countByEntity`
during each refresh cycle.

When `showFollowerCount = false`, the stats API still computes and returns
`followerCount` to authenticated owners (so dashboard analytics work), but the
public-facing stats response omits or zeros it out.

---

## Acceptance Matrix

| # | Scenario | Expected |
|---|---|---|
| 1 | Fan follows a Place (venue) | EntityFollow row created; follower count cache invalidated |
| 2 | Fan re-follows (double follow) | Returns existing followId; alreadyFollowing = true; no duplicate row |
| 3 | Fan unfollows; then follows again | New EntityFollow row with original prefs reset to defaults |
| 4 | Self-follow attempt (Human follows own EntityPage) | Error: `self_follow_not_allowed` |
| 5 | Follow when `allowFollows = false` | Error: `forbidden` |
| 6 | Follow private EntityPage | Error: `not_found` (page not publicly visible) |
| 7 | `getFollowerCount` — `showFollowerCount = false` | Returns `{ count: N, isPublic: false }` |
| 8 | `getFollowerStats` — owner request | Returns totalFollowers, newLast7Days, newLast30Days; no humanIds |
| 9 | `getFollowerStats` — non-owner request | Error: `forbidden` |
| 10 | New event published at a Place | Followers of that Place receive in-app notification |
| 11 | New event published by an Org | Followers of that Org receive in-app notification |
| 12 | Performer added to published event | Followers of that Human entity receive in-app notification |
| 13 | Event unpublished then re-published | No duplicate notifications (`EntityEventNotificationLog` dedup) |
| 14 | Entity with 0 followers; event published | No errors; notifiedCount = 0 |
| 15 | ArtistFollow migration | All existing rows converted to EntityFollow; counts match within tolerance |

---

## Open Questions

| Question | Context |
|---|---|
| Should follower count be visible to the platform (for curation / recommendations)? | Useful for surfacing trending entities; opt-in at entity level; no individual PII involved. |
| Weekly digest vs. real-time notification for Place/Org follows? | Place followers may not want per-event email for weekly venue; consider digest mode as a preference on the follow row. |
| Should `showFollowerCount` default to `true` once a threshold is met (e.g., 100)? | Auto-surfacing at threshold reduces opt-in friction for growing pages. |
| Two-way connections? | Out of scope for v2; keep follow one-directional (fan → entity). |
