# Waiver System Spec — Ithas Fire

## Overview

Add an event-level waiver system that requires ticket buyers to accept an assumption-of-risk waiver before completing checkout. This protects organizers (especially house show hosts) and Ithas Fire from liability claims related to attendee injuries.

## Architecture Notes

- Follows existing hexagonal architecture: port → use case → adapter → transport
- All input/output validated with Zod per engineering standards
- Waiver acceptance is stored as an auditable record tied to the order
- No new external dependencies required

---

## 1. Data Model (Prisma)

### New model: `WaiverTemplate`

```prisma
model WaiverTemplate {
  id        String   @id @default(cuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  name      String   // e.g. "House Show Waiver", "General Admission"
  body      String   @db.Text // The full waiver text (markdown or plain text)
  version   Int      @default(1) // Increment on edit so acceptance records reference the exact version
  isDefault Boolean  @default(false) // Org-level default waiver
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  events             Event[]
  waiverAcceptances  WaiverAcceptance[]

  @@index([orgId])
}
```

### New model: `WaiverAcceptance`

```prisma
model WaiverAcceptance {
  id                String          @id @default(cuid())
  orderId           String
  order             Order           @relation(fields: [orderId], references: [id], onDelete: Cascade)
  humanId           String
  human             Human           @relation(fields: [humanId], references: [id], onDelete: Cascade)
  waiverTemplateId  String
  waiverTemplate    WaiverTemplate  @relation(fields: [waiverTemplateId], references: [id], onDelete: Restrict)
  waiverVersion     Int             // Snapshot of template.version at time of acceptance
  waiverBodyHash    String          // SHA-256 of the waiver body at acceptance time — proves what they agreed to
  acceptedAt        DateTime        @default(now())
  ipAddress         String?         // Optional: IP at time of acceptance for legal record

  @@unique([orderId, waiverTemplateId]) // One acceptance per waiver per order
  @@index([humanId])
  @@index([waiverTemplateId])
}
```

### Modify existing `Event` model

Add optional relation to `WaiverTemplate`:

```prisma
// Add to Event model
waiverTemplateId  String?
waiverTemplate    WaiverTemplate? @relation(fields: [waiverTemplateId], references: [id], onDelete: SetNull)
```

---

## 2. Platform-Provided Waiver Templates

Seed the database with a few default templates that any organizer can use. Organizers can also write their own.

### Template: General Event

> By purchasing this ticket, I acknowledge that attending live events carries inherent risks including but not limited to loud noise exposure, crowding, and physical contact with other attendees. I voluntarily assume all such risks and agree to hold the event organizer and Ithas Fire harmless for any injuries sustained during the event.

### Template: Live Music / Physical Activity

> By purchasing this ticket, I acknowledge that this event may involve loud music, moshing, crowd surfing, standing-room conditions, and other physical activity that carries a risk of bodily injury. I voluntarily assume all risks associated with attending, including risks arising from the actions of other attendees. I agree to hold the event organizer and Ithas Fire harmless for any injuries sustained.

### Template: Private Residence Event

> By purchasing this ticket, I acknowledge that this event is held at a private residence and is not a commercially licensed venue. The premises may not meet commercial safety standards. I voluntarily assume all risks associated with attending, including but not limited to property conditions, limited egress, and the absence of professional security. I agree to hold the property owner, event organizer, and Ithas Fire harmless for any injuries or property damage sustained during the event. I agree not to disclose the event address publicly.

---

## 3. Use Cases

### 3.1 `createWaiverTemplate`

- **Location:** `packages/core/src/use-cases/waivers/create-waiver-template.ts`
- **Auth:** `ensureOrgRole(orgId, ["OWNER", "ADMIN"])`
- **Input:** `{ orgId, name, body, isDefault? }`
- **Behavior:**
  - Validates input
  - If `isDefault: true`, unset any existing default for this org
  - Creates `WaiverTemplate` with `version: 1`
  - Audit log: `{ entity: "WaiverTemplate", action: "created" }`
- **Output:** `{ waiverTemplate: { id, name, version, createdAt } }`

### 3.2 `updateWaiverTemplate`

- **Input:** `{ orgId, waiverTemplateId, name?, body? }`
- **Auth:** `ensureOrgRole(orgId, ["OWNER", "ADMIN"])`
- **Behavior:**
  - If `body` changes, increment `version`
  - Name-only changes do not increment version
  - Audit log: `{ entity: "WaiverTemplate", action: "updated", data: { previousVersion, newVersion } }`
- **Output:** `{ waiverTemplate: { id, name, version, updatedAt } }`

### 3.3 `listWaiverTemplates`

- **Input:** `{ orgId, limit?, offset? }`
- **Auth:** `ensureOrgRole(orgId, ["OWNER", "ADMIN", "EDITOR"])`
- **Output:** Offset-paginated list of templates for this org + platform defaults

### 3.4 `assignWaiverToEvent`

- **Input:** `{ orgId, eventId, waiverTemplateId | null }`
- **Auth:** `ensureOrgRole(orgId, ["OWNER", "ADMIN", "EDITOR"])`
- **Behavior:**
  - Sets `event.waiverTemplateId` to the given template or `null` (to remove waiver requirement)
  - Validate template belongs to org or is a platform-provided template
  - Audit log
- **Output:** `{ event: { id, waiverTemplateId } }`

### 3.5 `getEventWaiver` (public)

- **Input:** `{ eventId }`
- **Auth:** None (public)
- **Behavior:**
  - Looks up event → waiverTemplate
  - Returns waiver body and metadata if one exists, `null` if no waiver required
- **Output:** `{ waiver: { id, name, body, version } | null }`

### 3.6 Modify `createCheckout`

- **Add to input schema:** `waiverAccepted?: boolean`
- **Behavior change:**
  - After loading the event, check if `event.waiverTemplateId` is set
  - If waiver exists and `waiverAccepted !== true`, throw `{ code: "waiver_required", message: "You must accept the event waiver before purchasing tickets." }`
  - If waiver exists and `waiverAccepted === true`, proceed with checkout
  - Waiver acceptance record is NOT created here — it's created at finalization (after payment succeeds)

### 3.7 Modify `finalizeFromPaymentIntent`

- **Behavior change:**
  - After ticket issuance, if the event has a waiver template:
    - Compute SHA-256 hash of `waiverTemplate.body`
    - Create `WaiverAcceptance` record within the existing finalization transaction
    - Fields: `orderId`, `humanId`, `waiverTemplateId`, `waiverVersion: template.version`, `waiverBodyHash`, `acceptedAt: now()`, `ipAddress` (from request context if available)

---

## 4. Transport (tRPC)

### New router: `waivers`

```
waivers.createTemplate     → createWaiverTemplate
waivers.updateTemplate     → updateWaiverTemplate
waivers.listTemplates      → listWaiverTemplates
waivers.assignToEvent      → assignWaiverToEvent
waivers.getEventWaiver     → getEventWaiver (public)
```

### Modify existing

- `orders.createCheckout` → add `waiverAccepted` to input schema
- `orders.finalizeFromPaymentIntent` → add waiver acceptance creation inside existing tx

---

## 5. Web UI Changes

### 5.1 Event Creation / Edit (Organizer Dashboard)

- Add a "Waiver" section in the event creation/edit form
- Dropdown: "No waiver required" | list of org templates + platform templates
- Button: "Create new waiver template" → opens inline form or modal
- Preview of selected waiver text

### 5.2 Checkout Flow (Buyer)

- **Before the payment step**, if the event has a waiver:
  - Display waiver text in a scrollable container
  - Checkbox: "I have read and agree to the above waiver" (unchecked by default)
  - Checkbox must be checked before "Pay" button is enabled
  - Pass `waiverAccepted: true` in the `createCheckout` call

### 5.3 Order Confirmation / My Tickets

- If a waiver was accepted, show a small note: "You accepted the event waiver on [date]"
- Link to view the waiver text they agreed to

### 5.4 Organizer Order View

- In the attendee list / order detail, show waiver acceptance status per order
- Export: include waiver acceptance timestamp in CSV exports

---

## 6. Legal Page Updates

### Terms of Service — Add new section

**Section 4.5: Event Waivers**

> Certain events may require you to accept an assumption-of-risk waiver before purchasing tickets. By accepting a waiver, you acknowledge the risks described therein and agree to hold the event organizer and Ithas Fire harmless as specified. Waivers are presented by event organizers; Ithas Fire facilitates waiver acceptance but does not provide legal advice on their enforceability. Event organizers are responsible for ensuring their waiver language is appropriate for their jurisdiction and event type.

---

## 7. Migration Checklist

- [ ] Add `WaiverTemplate` and `WaiverAcceptance` models to Prisma schema
- [ ] Add `waiverTemplateId` to `Event` model
- [ ] Run `prisma migrate dev --name add-waiver-system`
- [ ] Seed platform default templates
- [ ] Implement use cases with unit tests
- [ ] Wire tRPC router
- [ ] Add waiver UI to event creation flow
- [ ] Add waiver checkbox to checkout flow
- [ ] Update Terms of Service page
- [ ] Add waiver acceptance to order detail / export views
- [ ] **Post-launch:** Get a lawyer to review waiver template language

---

## 8. Testing Requirements

Per engineering standards:

- **Unit tests** for each new use case (createWaiverTemplate, updateWaiverTemplate, assignWaiverToEvent, getEventWaiver)
- **Unit test for createCheckout** — assert `waiver_required` error when waiver exists and `waiverAccepted` is not `true`
- **Unit test for finalizeFromPaymentIntent** — assert `WaiverAcceptance` record is created in the transaction when event has a waiver
- **Integration test** — full checkout flow with waiver: create event with waiver → checkout with acceptance → finalize → verify acceptance record exists with correct hash and version
- **Edge cases:**
  - Waiver template updated between checkout start and payment finalization (version should reflect template at finalization time)
  - Event waiver removed after checkout started but before finalization (skip acceptance gracefully)
  - Duplicate finalization (idempotency — don't create duplicate acceptance records; `@@unique([orderId, waiverTemplateId])` handles this)
