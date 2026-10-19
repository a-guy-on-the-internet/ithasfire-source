# Organization Settings Page

> **Status:** complete
> **Admin route:** `/admin/[slug]/settings`
> **Created:** 2026-02-22

## Purpose

There is currently no way to edit an organization after creation. The org
name, slug, default locale, and other properties are frozen at creation
time. This spec adds an org settings page for basic profile management
and a `updateOrg` use case.

---

## v1 Scope

### Backend

| Layer | Artifact | Notes |
| --- | --- | --- |
| Use case | `update-org` | OWNER/ADMIN can update `name`, `defaultLocale`. Slug re-derived from name on change (with `OrgSlugHistory` record for old slug). Validates uniqueness. Audit log. |
| Port | `OrganizationsRepo.update` | Partial update: `{ name?, defaultLocale? }`. |
| Adapter | Prisma `Organization.update` | Standard partial update + slug history insert in same transaction. |
| Transport | tRPC `orgs.updateOrg` | Org-scoped, RBAC via `ensureOrgRole`. |

### Frontend

| Component | Description |
| --- | --- |
| `/admin/[slug]/settings/page.tsx` | Settings page with editable fields: org name, default locale picker. Save button with optimistic update. |
| `ADMIN_SECTIONS` update | Add "Settings" entry with gear icon at the bottom of the nav. |
| Danger zone section | Archive org button (sets status to ARCHIVED). Transfer ownership link (navigates to team page). |

---

## Deferred features

- **Org logo / avatar upload** (reuse Image model with `ownerType: ORG`).
- **Custom slug editing** (separate from auto-derive).
- **Stripe Connect status display** and onboarding link.
- **Org deletion** (hard delete with confirmation, only if no events exist).
- **Billing / subscription management.**
