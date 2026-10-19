# Specs — 2026-03-23

Community event discovery and the original "Hearth scraper" bot concept.

## Status (2026-05-16 audit)

The **scraper bot path was not pursued.** Ithas Fire's discovery is driven by
organiser-published events, not by scraping third-party calendars. The
`scraped-events.schema.yaml` and `hearth-scraper.spec.yaml` specs below remain
as historical context; no `ScrapedEvent` model exists in `packages/db/prisma/`,
and the scraper bot has no implementation. Treat them as obsolete unless the
strategy reverses.

Adjacent specs in this folder did ship:

- `event-claim-verification.spec.md` — the **ticket-transfer claim** flow shipped
  (see `apps/web/src/app/claim-transfer/` + `claims.ts` router). The
  ScrapedEvent-driven claim flow described in the spec did NOT ship and never
  will unless the scraper revives.
- `event-list-card.component.yaml` — public event list card + `/events` page are
  live.
- `volunteering.spec.md` (added later) — fully shipped (`volunteer.prisma`,
  `volunteering/` use cases, `/admin/[slug]/volunteer-templates`).
- `generic-form-builder.component.yaml` — present in folder, not catalogued
  below; not currently a separate shipped feature.

## Workflow

- Active drafts live at the root of this folder.
- When a spec is implemented, move it into `completed/` and update the table below.
- Delete the old file after moving.

## Catalog

| Spec | Status | Notes |
| --- | --- | --- |
| `scraped-events.schema.yaml` | **Obsolete** (not pursued) | ScrapedEvent data model, dedup, claim lifecycle, promotion to Event. Strategy abandoned in favour of organiser-published events only. |
| `hearth-scraper.spec.yaml` | **Obsolete** (not pursued) | Hearth bot architecture, source adapters, pipeline, scheduling. No implementation; not on the roadmap. |
| `event-claim-verification.spec.md` | **Partial** | Ticket-transfer claim flow shipped; ScrapedEvent-driven claim flow not built (and won't be unless the scraper revives). |
| `event-list-card.component.yaml` | **Shipped** | Public EventListCard component + `/events` page live. |
| `volunteering.spec.md` | **Shipped** | Slices 1–4 done; `volunteer.prisma`, `volunteering/` use cases, admin routes all present. |
| `generic-form-builder.component.yaml` | Unverified | Not catalogued previously; out-of-scope for the scraper concept. |
