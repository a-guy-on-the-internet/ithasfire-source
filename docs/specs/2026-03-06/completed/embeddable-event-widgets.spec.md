# Embeddable Event Widgets

> **Status:** complete
> **Domain:** Public API, Embeds, Places, Orgs, Humans, Checkout
> **Depends on:** `EmbedToken` (new model), public use cases, checkout flow

---

## 1. Problem

Venues, promoters, and artists want to sell tickets directly from their own
websites without sending visitors to a separate ticketing platform. Today
there's no way to embed a Ithas Fire event list, event detail, or checkout
flow on a third-party domain.

## 2. Goals

1. **Embeddable event list** for a place, org, or human (performer) that
   renders upcoming events with ticket availability and "Get Tickets" CTAs.
2. **Embeddable event detail** for a single event showing description,
   ticket types, pricing, and a checkout button.
3. **Embeddable checkout** that handles the full purchase flow (ticket
   selection, Stripe payment, confirmation) without leaving the host page.
4. **Domain-locked tokens** so embeds only work on authorized domains.
5. **Theming** so the widget can match the host site's look.

## 3. Architecture

### 3.1 Delivery mechanism

Embeds are delivered as an **iframe** pointed at a dedicated Ithas Fire
embed route, configured via URL parameters and secured by an embed token.

```html
<iframe
  src="https://app.hearthfire.community/embed/events?token=<EMBED_TOKEN>&theme=dark"
  width="100%"
  height="600"
  frameborder="0"
  allow="payment"
></iframe>
```

Why iframe over web component:
- **Security**: Full origin isolation. The embed can't access the host
  page's DOM, cookies, or JS context.
- **Stripe compatibility**: Stripe Elements requires same-origin or
  iframe isolation. An iframe naturally satisfies this.
- **CSP simplicity**: Host site only needs to allow
  `frame-src app.hearthfire.community`.
- **Future**: A lightweight JS loader (`<script>`) can be offered later
  that auto-creates the iframe with responsive height via postMessage.

### 3.2 Embed routes

All embed routes live under `apps/web/src/app/embed/`:

| Route | Purpose |
| ----- | ------- |
| `/embed/events` | Event list for a place, org, or human |
| `/embed/events/[eventIdOrSlug]` | Single event detail + ticket picker |
| `/embed/checkout/[eventIdOrSlug]` | Checkout flow (ticket selection through payment) |
| `/embed/calendar` | Calendar view variant of the event list |

These routes render minimal chrome (no header, no footer, no navigation)
and communicate with the host page via `postMessage` for:
- Height resizing
- Navigation events (e.g., "user clicked Get Tickets")
- Checkout completion callbacks

### 3.3 Embed token model

```prisma
model EmbedToken {
  id           String    @id @default(uuid())
  /// The entity this token grants access to embed.
  subjectType  EmbedSubjectType          // PLACE, ORGANIZATION, HUMAN, EVENT
  subjectId    String
  /// Allowed origin domains. Wildcard subdomains supported (e.g. "*.venue.com").
  domains      String[]
  /// Human-readable label for the admin UI.
  label        String?
  /// Optional expiration. Null = never expires.
  expiresAt    DateTime?
  revokedAt    DateTime?
  /// The human who created this token.
  createdById  String
  createdBy    Human     @relation(fields: [createdById], references: [id])
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@index([subjectType, subjectId])
  @@index([revokedAt])
}

enum EmbedSubjectType {
  PLACE
  ORGANIZATION
  HUMAN
  EVENT
}
```

### 3.4 Token lifecycle

| Operation | Who | Notes |
| --------- | --- | ----- |
| **Mint** | Place owner, org admin, human (for self) | Creates token scoped to entity + domains. |
| **List** | Same as mint | View all active tokens for an entity. |
| **Revoke** | Same as mint | Sets `revokedAt`. Embed immediately stops rendering. |
| **Validate** | Public (every embed request) | Check: not revoked, not expired, `Referer` or `Origin` header matches `domains[]`. |

### 3.5 Token validation flow

```
Browser loads iframe src with ?token=<TOKEN>
    │
    ▼
Embed route middleware:
  1. Decode token (UUID lookup, not JWT — server-validated)
  2. Check revokedAt is null
  3. Check expiresAt > now (or null)
  4. Check Origin/Referer header against token.domains[]
  5. If any check fails → render "Embed not authorized" placeholder
  6. If valid → set X-Embed-Subject-Type / X-Embed-Subject-Id headers
     for downstream data fetching
```

## 4. Use cases

### 4.1 `listPublicEventsForEntity` (new)

The core use case powering the embed event list. Also powers the public
profile pages for places, orgs, and humans.

**Input:**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| entityType | enum | Yes | `PLACE`, `ORGANIZATION`, `HUMAN` |
| entityId | uuid | Yes | |
| status | enum | No | Default: `upcoming`. Options: `upcoming`, `past` |
| from | DateTime | No | Default: now |
| to | DateTime | No | Default: now + 90 days |
| limit | number | No | Default 12, max 50 |
| offset | number | No | Default 0 |

**Output:**

```typescript
{
  entity: {
    name: string;
    slug: string | null;
    imageUrl: string | null;       // logo/avatar
    entityType: "PLACE" | "ORGANIZATION" | "HUMAN";
  };
  events: Array<{
    eventId: string;
    slug: string | null;
    title: string;
    startsAt: Date;
    endsAt: Date;
    primaryImageUrl: string | null;
    venueName: string | null;       // place name (if entity is not a place)
    city: string | null;
    region: string | null;
    priceRange: {
      minCents: number;
      maxCents: number;
      currency: string;
    } | null;
    soldOut: boolean;
    ticketTypesAvailable: number;   // count of types with remaining capacity
  }>;
  pageInfo: { total, limit, offset, count, hasMore };
}
```

**RBAC:** None (public). Entity must be active/verified where applicable.
For PLACE: must be VERIFIED and ACTIVE. For ORG: must be ACTIVE. For HUMAN:
must be ACTIVE.

**Implementation notes:**
- For `entityType = PLACE`: query `Event WHERE placeId = entityId AND
  status = PUBLISHED`. If proposals are live, also filter
  `placeEventStatus = CONFIRMED`.
- For `entityType = ORGANIZATION`: query `Event WHERE orgId = entityId
  AND status = PUBLISHED`.
- For `entityType = HUMAN`: query `Event WHERE humanId = entityId AND
  status = PUBLISHED` OR events where the human is an attached
  `EventHuman`.
- Price range: `SELECT MIN(priceCents), MAX(priceCents) FROM TicketType
  WHERE eventId = ? AND status = ACTIVE`.
- Sold out: `capacity - sold <= 0` across all active ticket types.

### 4.2 `getPublicEventDetail` (new)

Powers the single-event embed view and the public event page.

**Input:**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| eventIdOrSlug | string | Yes | UUID or slug |

**Output:**

```typescript
{
  event: {
    eventId: string;
    slug: string | null;
    title: string;
    description: string | null;     // sanitized HTML from body
    startsAt: Date;
    endsAt: Date;
    primaryImageUrl: string | null;
    venueName: string | null;
    venueAddress: string | null;
    city: string | null;
    region: string | null;
    lat: number | null;
    lng: number | null;
    orgName: string | null;
    orgSlug: string | null;
    status: "PUBLISHED";
    ticketTypes: Array<{
      ticketTypeId: string;
      name: string;
      description: string | null;
      priceCents: number;
      currency: string;
      available: number;            // remaining capacity
      soldOut: boolean;
      seatSectionName: string | null;
    }>;
    refundPolicy: {
      refundCutoffAt: Date | null;  // null = event start
      refundFeeCents: number;       // Stripe processing cost
    };
  };
}
```

**RBAC:** None (public). Event must be PUBLISHED.

### 4.3 `createCheckout` (existing)

The existing `createCheckout` use case already handles the purchase flow.
The embed checkout page calls it directly. The only addition needed is
accepting an optional `embedTokenId` for analytics attribution (which
embed drove this sale).

### 4.4 Embed token management use cases

| Use case | Notes |
| -------- | ----- |
| `mintEmbedToken` | Validates ownership of the subject entity. Creates token. |
| `listEmbedTokens` | Lists all tokens for an entity. Includes revoked for audit. |
| `revokeEmbedToken` | Sets `revokedAt`. Idempotent. |
| `validateEmbedToken` | Internal helper, not a transport endpoint. Called by middleware. |

## 5. Theming

Embeds accept a `theme` query parameter:

| Parameter | Values | Notes |
| --------- | ------ | ----- |
| `theme` | `light`, `dark`, `auto` | `auto` respects `prefers-color-scheme` |
| `accent` | hex color (e.g., `FF5733`) | Primary button/link color |
| `radius` | `none`, `sm`, `md`, `lg` | Border radius scale |
| `font` | Google Fonts family name | Optional custom font |

Theme values are parsed server-side and injected as CSS custom properties.
No user-supplied CSS is executed (XSS prevention).

## 6. Host page communication (postMessage)

```typescript
// Embed → Host
interface EmbedMessage {
  type: "th:embed";
  action:
    | { kind: "resize"; height: number }
    | { kind: "navigate"; url: string }           // "Get Tickets" clicked
    | { kind: "checkout:complete"; orderId: string }
    | { kind: "checkout:cancel" }
    | { kind: "error"; message: string };
}

// Host → Embed
interface HostMessage {
  type: "th:host";
  action:
    | { kind: "theme:update"; theme: ThemeOverrides };
}
```

The embed route includes a small postMessage bridge script that:
1. Sends `resize` on initial render and on content changes (ResizeObserver).
2. Intercepts navigation to Ithas Fire URLs and sends `navigate` instead
   (host can decide: open in new tab, or load checkout embed inline).
3. Sends checkout lifecycle events for host-side tracking.

## 7. JS loader (convenience)

Optional `<script>` tag for simpler integration:

```html
<script src="https://app.hearthfire.community/embed.js"></script>
<div
  data-th-embed="events"
  data-th-token="<TOKEN>"
  data-th-theme="dark"
  data-th-accent="FF5733"
></div>
```

The loader script:
1. Finds all `[data-th-embed]` elements on the page.
2. Creates iframes with the correct src URL.
3. Listens for `th:embed` postMessages and auto-resizes iframes.
4. Exposes `window.Ithas Fire.on('checkout:complete', callback)` for
   host-side event handling.

## 8. Admin UI for embed management

### 8.1 Embed tokens page

- **Location:** `apps/web/src/app/admin/[slug]/embeds/` (new admin section)
- **Add to `ADMIN_SECTIONS`** in the layout with a `Code` icon from lucide.
- **Features:**
  - List all embed tokens for the current entity (place/org).
  - Create new token: select subject, enter allowed domains, optional
    label and expiration.
  - Copy embed code (iframe snippet or JS loader snippet).
  - Revoke token with confirmation dialog.
  - Preview button that opens the embed in a modal.

## 9. Security considerations

| Concern | Mitigation |
| ------- | ---------- |
| Token leakage | Tokens are UUID-based, not JWTs. Validation is server-side. Revoking a token immediately kills the embed. Domain locking prevents use on unauthorized sites. |
| XSS via theming | Theme parameters are allowlisted values (hex regex, enum options). No raw CSS injection. |
| Clickjacking | Embed routes set `X-Frame-Options: ALLOW-FROM` based on the token's domains. Non-embed routes keep `DENY`. |
| Stripe in iframe | Stripe Elements work inside iframes. The `allow="payment"` attribute on the iframe enables the Payment Request API. |
| Rate limiting | Public embed endpoints share the same rate limits as public API routes. Token-based attribution helps identify abuse sources. |
| CORS | Embed routes don't need CORS (they're loaded as iframes, not fetched via JS). The postMessage bridge handles cross-origin communication. |

## 10. Relationship to existing code

| Existing | Reuse | Notes |
| -------- | ----- | ----- |
| `listPlaceEvents` | Partial | `listPublicEventsForEntity` generalizes this to any entity type. May delegate to it for the PLACE case. |
| `createCheckout` | Full | Embed checkout calls the same use case. Add optional `embedTokenId` for attribution. |
| `getRandomEvent` / public event pages | Partial | `getPublicEventDetail` is a cleaner, dedicated version. |
| `@th/ui` components | Full | Event cards, ticket pickers, checkout form are reusable. Wrap in embed-specific layout. |
| `EmbedToken` from app.md | Implemented | The model spec in app.md matches this design. |

## 11. Implementation phases

| Phase | Scope | Effort |
| ----- | ----- | ------ |
| **P0** | `EmbedToken` model + migration + mint/list/revoke use cases + admin UI | 2 days |
| **P1** | `listPublicEventsForEntity` use case + embed event list route | 2 days |
| **P2** | `getPublicEventDetail` use case + embed event detail route | 1 day |
| **P3** | Embed checkout route (reuses existing createCheckout) | 1 day |
| **P4** | JS loader script + postMessage bridge + auto-resize | 1 day |
| **P5** | Theming system + embed preview in admin | 1 day |
| **P6** | Calendar embed variant (after venue-calendar ships) | 0.5 day |

Total: ~8 days for full feature. P0-P2 are the MVP.

## 12. Analytics and attribution

When an order originates from an embed:
- `Order.metadata` (or a new `Order.embedTokenId` FK) records which
  embed token drove the sale.
- Venue/org dashboards show "Sales from embeds" as a channel breakdown.
- Token-level analytics: impressions (embed loads), clicks (Get Tickets),
  conversions (completed checkouts).

Impression and click tracking use a lightweight pixel/beacon endpoint
(`/api/embed/track`) that accepts the token ID and event type. No
cookies or user-level tracking.

## 13. Open questions

1. Should embeds support authenticated checkout (returning buyers with
   saved payment methods)? Recommend: yes, via a "Sign in" link that
   opens a popup, then postMessages the auth state back to the iframe.
2. Max number of embed tokens per entity? Recommend: 10 active tokens
   per entity for v1.
3. Should the JS loader be self-hosted or CDN-delivered? Recommend: CDN
   with cache-busting version parameter.
4. Should we support oEmbed/OpenGraph for auto-previews in Slack, Discord,
   etc.? Recommend: yes, but as a separate spec (lightweight).

---

*This spec pairs with `venue-event-proposals.spec.md` (for CONFIRMED
filtering) and `venue-calendar.spec.md` (for the calendar embed variant).*
