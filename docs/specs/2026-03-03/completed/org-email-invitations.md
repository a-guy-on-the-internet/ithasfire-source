# Org Email Invitations

> **Status:** complete
> **Admin route:** `/admin/[slug]/team` (extends existing page)
> **Created:** 2026-02-22

## Purpose

Allow org admins to invite people by email even if they don't have a
Ithas Fire account yet. Today the "Add Member" flow dead-ends with
"No account found with that email address." This feature replaces that
dead-end with a proper invitation flow: send an email, let the invitee
sign up and land directly in the org.

---

## v1 Scope

### Backend

| Layer | Artifact | Notes |
| --- | --- | --- |
| Schema | `OrgInvitation` model (Prisma) | `id`, `orgId`, `email`, `role`, `invitedByHumanId`, `token` (unique, URL-safe), `status` (PENDING / ACCEPTED / EXPIRED / REVOKED), `expiresAt`, `acceptedAt?`, `acceptedByHumanId?`, `createdAt` |
| Type | `OrgInvitationRecord` | DTO in `@th/types/repos/organizations` |
| Port | `OrganizationsRepo` additions | `createInvitation`, `getInvitationByToken`, `getInvitationByOrgAndEmail`, `listInvitations`, `updateInvitationStatus` |
| Use case | `invite-member` | Validates input (Zod), checks actor is OWNER/ADMIN, checks email not already a member, upserts invitation (resend if PENDING exists), enqueues invite email, audit log. Idempotent on `(orgId, email)`. |
| Use case | `accept-invitation` | Validates token + expiry, resolves authenticated human, calls `addMember`, marks invitation ACCEPTED. |
| Use case | `revoke-invitation` | OWNER/ADMIN can cancel a pending invitation. |
| Use case | `list-invitations` | Paginated list of pending/expired/accepted invitations for the team page. |
| Adapter | Prisma `OrgInvitation` queries | Added to `makeOrganizationsRepo`. |
| Transport | tRPC `orgs.inviteMember`, `orgs.acceptInvitation`, `orgs.revokeInvitation`, `orgs.listInvitations` | Org-scoped RBAC for invite/revoke/list; accept is authed-only (any user with the token). |

### Frontend

| Component | Description |
| --- | --- |
| TeamView.tsx update | When `lookupHumanByEmail` returns not_found, show "Send invitation" button instead of error. |
| Pending invitations section | Below the members table: list of pending invitations with email, role, sent date, resend and revoke actions. |
| `/invite/accept` page | Public-ish page that validates the token, prompts sign-up/sign-in if needed, then calls `acceptInvitation`. |
| Email template | `OrgInvitationEmail` in `packages/ui-email` — org name, role, CTA button linking to `/invite/accept?token=...`. |

### Token design

- 32-byte random, base64url-encoded (43 chars).
- Expires after 7 days. Resending reuses the same invitation record but
  regenerates the token and resets `expiresAt`.
- Single-use: once accepted, the token is consumed.

### Integration points

- **Auth flow:** The accept page must handle both existing users (already
  signed in) and new users (redirect to sign-up, then back to accept).
- **Notification preferences:** Invitation emails are transactional (not
  marketing), so they bypass the `announcements` opt-out.

---

## Deferred features

- **Bulk invite:** Paste comma-separated emails or pick from an audience list.
- **Invitation link (no email):** Generate a shareable URL that grants a
  specific role to anyone who signs up through it.
- **Invitation expiry notifications:** Email the inviter when an invitation
  is about to expire.
- **Auto-assign role from event context:** When an organizer invites someone
  from the event page (e.g., "Add scanner"), pre-fill the role.
