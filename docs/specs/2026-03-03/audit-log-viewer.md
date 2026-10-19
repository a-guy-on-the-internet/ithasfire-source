# Audit Log Viewer

> Not built yet (2026-10-08 docs consolidation): Org-scoped /admin/[slug]/activity page, audit.list router, AuditRepo.listByOrg not built

> **Status:** Planned
> **Admin route:** `/admin/[slug]/activity`
> **Created:** 2026-02-22

## Purpose

The `AuditLog` model is already populated by every use case (entity,
entityId, action, data, timestamp), but there is no admin UI to view it.
An activity page gives organizers transparency into what happened, when,
and by whom.

---

## v1 Scope

### Backend

| Layer | Artifact | Notes |
| --- | --- | --- |
| Use case | `list-audit-logs` | Paginated, cursor-based. Filters: entity type, action, date range, actor humanId. Scoped to org (only show logs for entities owned by the org). RBAC: OWNER/ADMIN/FINANCE. |
| Port | `AuditRepo.listByOrg` | New method on existing port. |
| Adapter | Prisma query on `AuditLog` | Filter by entity + entityId cross-referenced with org-owned entities. |
| Transport | tRPC `audit.list` | Org-scoped. |

### Frontend

| Component | Description |
| --- | --- |
| `/admin/[slug]/activity/page.tsx` | Filterable, paginated timeline of actions. Each row: timestamp, actor name, action description, affected entity link. |
| `ADMIN_SECTIONS` update | Add "Activity" entry with `ActivityIcon` between Payments and Team. |
| Action formatter | Human-readable descriptions: "Alice added Bob as Editor", "Payout of $150.00 initiated for Event X". |

---

## Deferred features

- **Export to CSV.**
- **Real-time updates** via WebSocket or polling.
- **Entity detail drill-down:** Click an entity to see its full audit trail.
- **Retention policy:** Auto-purge logs older than N months.
