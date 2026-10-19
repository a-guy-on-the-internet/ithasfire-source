# Follow-up: page-level role action sweep

> Not built yet (2026-10-08 docs consolidation): table rows still unticked (payments, most list pages); reality unverified per page

**Status:** tracking / not started · 2026-06-30
**Parent:** [role-visibility-rbac-plan.md](./role-visibility-rbac-plan.md) (§5 step 4)
**Predecessor shipped:** role-aware **navigation** (`27087ad`, live on dev). This note
tracks the second half: making **page-level affordances** (buttons, forms, quick-actions)
match each role's ability to act.

## Why this exists

Nav `rbac` now hides whole sections, but a role that can still *reach* a page sees the
full set of action affordances. Examples observed live as a VIEWER on dev:
- Org dashboard still shows **CREATE EVENT**, **SCAN TICKET**, **MANAGE PLACES** quick-action cards.
- Events list still shows a **CREATE EVENT** button and an Actions menu with **EDIT / COMP / CANCEL**.
- Orders / Audiences / Payments / Promos / Announcements / Embeds render with no read-only treatment.

These don't *grant* access — the server-side use-case checks (`requireOrgMembership`,
`requireOrgRole`, `requirePlatformStaff` in `packages/core/src/lib/rbac.ts`) still reject the
mutation with a 403. This sweep is **UX correctness**: don't present an affordance that will
fail, and make read-only roles visibly read-only.

**Principle (unchanged):** nav + page affordances are cosmetic; the real boundary is the
server. Every gap below must already be enforced server-side — verify, don't assume.

## Already gated (reference — do not redo)

| Surface | Existing gate |
|---|---|
| Settings | `canEdit` (OWNER/ADMIN) → read-only fields; Danger sub-tab OWNER-only |
| Event builder | `canEditEvent` (OWNER/ADMIN/EDITOR) → Preview-only, no Edit tab for others |
| Scanner-setup | `canManage` (OWNER/ADMIN) → send-onboarding disabled + warning |
| Team | pending-invitations query gated to OWNER/ADMIN |
| Platform Categories | `REVIEW_ROLES` / `DELETE_ROLES` gate approve/reject/delete buttons |

## Gaps to close

Write capability follows the canonical sets in `@th/types` (reuse them; don't inline):
`ORG_EDIT_ROLES` (content), `ORG_FINANCE_ROLES` (money), `ORG_ADMIN_ROLES` (management),
`ORG_SCAN_ROLES` (scan).

| Page / component | Who may ACT (write set) | Affordances to disable / hide for everyone else | Status |
|---|---|---|---|
| Dashboard quick-actions (`admin/[slug]/dashboard`) | per-action: Create Event=EDIT, Scan=SCAN, Manage Places=EDIT, View Orders=FINANCE/EDIT | hide/disable each card by its own set (wire `QuickActionConfig.rbac` — the field already exists, unused) | ☐ |
| Events list (`admin/[slug]/events`) | `ORG_EDIT_ROLES` | CREATE EVENT button; Actions-menu EDIT/COMP/CANCEL (keep VIEW/SHARE) | ☐ |
| Orders (`admin/[slug]/orders`) | view: NON_SCANNER; refund/act: `ORG_FINANCE_ROLES` | refund / status-change actions read-only for non-finance | ☐ |
| Promos (`admin/[slug]/promos`) | `ORG_FINANCE_ROLES` | create/edit/delete promo for non-finance | ☐ |
| Payments (`admin/[slug]/payments`) | `ORG_FINANCE_ROLES` | payout/connect actions; read-only for VIEWER | ☐ |
| Audiences (`admin/[slug]/audiences`) | `ORG_EDIT_ROLES` | import/create/edit/delete list; send actions | ☐ |
| Announcements (`admin/[slug]/announcements`) | `ORG_EDIT_ROLES` | compose/send (broadcast) — read-only history for VIEWER | ☐ |
| Embeds (`admin/[slug]/embeds`) | `ORG_EDIT_ROLES` | create/edit/delete widget | ☐ |
| Volunteer templates (`admin/[slug]/volunteer-templates`) | `ORG_EDIT_ROLES` | create/edit/delete | ☐ |
| Volunteers (`admin/[slug]/volunteers`) | `ORG_EDIT_ROLES` (manage); SCANNER may check-in | manage actions vs check-in split | ☐ |
| Places (`admin/[slug]/places`) | `ORG_EDIT_ROLES` | create/edit venue, layout designer, bookings actions | ☐ |
| Team (`admin/[slug]/team`) | `ORG_ADMIN_ROLES` | invite / role-change / remove for VIEWER (currently visible read role sees controls) | ☐ |
| Platform Humans | view: SUPPORT+; mutate: ADMIN-only | confirm ban/delete/force-verify already ADMIN-gated in UI (server is) | ☐ |
| Platform Orders/Tickets | SUPPORT+ view | confirm any mutating actions are ADMIN-gated | ☐ |

## Approach

1. Prefer the existing `canX` prop pattern (as Settings/Event-builder already do) over ad-hoc
   checks. Read the actor's org role from `useEventOwnerEntities()` / `currentOwner.role`
   (already available; the nav work proved it's plumbed).
2. Wire `QuickActionConfig.rbac` (field exists in `@th/ui`, currently unused) for the
   dashboard quick-actions — lowest-effort, highest-visibility win.
3. For each page: gate the mutating affordance, show a read-only state or a short "view-only
   for your role" hint, and keep read paths intact.
4. **Verify the server already rejects** each gated mutation before relying on the UI gate.

## Acceptance criteria

- A VIEWER sees no actionable buttons on any admin page (read-only throughout), incl. the
  dashboard quick-actions and events list.
- EDITOR can act on content pages but not money (Payments/Promos read-only) or Team/Settings.
- FINANCE can act on Orders/Promos/Payments; content pages read-only.
- SCANNER reaches only Scan + Volunteers check-in.
- Each disabled affordance corresponds to a server-side check that returns 403 (spot-check).

## Verification fixtures (dev)

Reuse the seeded accounts (password `Role-Test-2026!`): `role-orgtest@ithasfire.com` (cycle
its org role via the team UI), `role-reviewer@`, `role-support@`. See memory
`reference_dev_role_test_users`.

## Known minors (accepted)

- **Human-owned place verification affordance** (Phase 2): a personal/human place owner
  gets `canManage=true` via the human-owner bypass, so the "Request verification" action
  can render enabled even though the server enforces `VERIFICATION_REQUIRES_ORG_OWNER` and
  403s. The eligibility precheck disables the common case; only pressable in a rare
  human+org edge. Server is the boundary. Optional tighten: require `row.access.orgIds.length > 0`
  before showing verify for human actors. Low priority.

## Out of scope

- Any change to the visibility matrix or nav `rbac` (shipped).
- Server-side authorization (already enforced; this is UX alignment only).
