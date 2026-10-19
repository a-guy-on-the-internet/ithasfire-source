# Auto-Collect Buyer Contacts

> **Status:** Planned
> **Created:** 2026-02-22

## Purpose

When someone buys a ticket, their contact information should automatically
flow into an audience list so organizers can communicate with attendees
without manual data entry. This bridges the existing orders pipeline and
the audiences/contact-list system.

---

## v1 Scope

### Backend

| Layer | Artifact | Notes |
| --- | --- | --- |
| Schema | `Event.autoCollectContacts` (Boolean, default false) | Opt-in per event. |
| Schema | `Event.autoCollectListId` (String?, FK to InviteList) | Target audience list. Null = auto-create one named after the event. |
| Use case | Post-checkout hook in `create-checkout` or webhook handler | After order is confirmed, upsert an `InviteListEntry` with buyer's email/humanId into the event's audience list. Uses existing `batchUpsert` with `skipDuplicates`. |
| Port | No new port needed | Reuses `InviteListsRepo.batchUpsert`. |

### Frontend

| Component | Description |
| --- | --- |
| Event builder toggle | "Auto-collect buyer contacts" checkbox in event settings. Optional audience list picker (defaults to auto-created list). |
| Audience detail | Buyers show up with a "Purchased" tag automatically applied. |

### Integration points

- **Audiences system:** Fully reuses existing `InviteList` / `InviteListEntry`
  infrastructure. No new models needed.
- **Announcements:** Once buyer contacts are auto-collected, organizers can
  immediately target them with announcements using the `CONTACT_LIST` audience
  type.

---

## Deferred features

- **Attendee vs. buyer distinction:** If tickets are transferred, track the
  current ticket holder, not just the original buyer.
- **Per-ticket-type collection:** Only collect contacts for certain ticket
  types (e.g., VIP buyers get a separate list).
- **Consent management:** Explicit opt-in checkbox at checkout for GDPR
  compliance.
