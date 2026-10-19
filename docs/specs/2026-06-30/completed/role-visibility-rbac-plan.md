# Role-aware UI: `rbac` annotation plan

**Status:** draft for decisions · 2026-06-30
**Problem:** Today every role that passes the access gate sees the *same* screen. The
nav-filter machinery exists (`filterSections` → `isRolePermitted`) but **no nav item
declares an `rbac` constraint**, and the platform shell hardcodes `role: "ADMIN"`. So a
VIEWER sees all 16 org nav items; a SUPPORT staffer sees all 19 platform panels. Role
enforcement is server-side only — the UI gives no signal.

This plan makes nav + actions reflect role. The wiring is small; the **visibility matrix
is the real work** (many per-item product choices). Recommendations below are defaults to
redline, not final.

---

## 1. Mechanism changes (small, do once)

### 1a. Generalize the filter to a roles **array** (unlocks platform staff)
`rbac?: OrgRole[]` + `AccountContext.role?: OrgRole` ([navigation.ts:29,47]) only models a
single org role. Platform staff hold a `HumanRole[]`. Change:

- `NavigationItem.rbac` / `NavigationSection.rbac` / `QuickActionConfig.rbac`: `OrgRole[]` → `string[]` (accepts org **or** staff roles).
- `AccountContext`: add `roles?: string[]` (the actor's effective role set). Keep `role` for display.
- `isRolePermitted(required, roles)`: change from `required.includes(role)` to **set-intersection** (`required.some(r => roles.includes(r))`). Empty `required` = visible to all (unchanged).

Org context derives `roles: [membership.role]`; platform context derives `roles: staffRoles`
(from `checkStaffAccess`, which already returns the array). **This also fixes** the
hardcoded `role: "ADMIN"` in `PlatformShell` and `AdminShell`'s SSR placeholder.

### 1b. Share the canonical role-sets with the web nav layer
`core/lib/rbac.ts` defines `ORG_EDIT_ROLES`, `ORG_ADMIN_ROLES`, `ORG_FINANCE_ROLES`,
`ORG_SCAN_ROLES`, `ORG_OWNER_ONLY` ([rbac.ts:11-55]) — but that's server-side. Add the same
constants (org **and** new platform-staff sets) to a client-importable module (e.g.
`@th/types/roles`) so nav definitions reference one source of truth instead of inline arrays.
Proposed new staff sets, derived from existing page logic:
- `STAFF_ALL = [ADMIN, REVIEWER, SUPPORT, DEVELOPER]` (the gate)
- `STAFF_MODERATION = [ADMIN, REVIEWER, DEVELOPER]` (from categories `REVIEW_ROLES`)
- `STAFF_TECH = [ADMIN, DEVELOPER]` (from categories `DELETE_ROLES`)
- `STAFF_SUPPORT = [ADMIN, SUPPORT]`
- `STAFF_ADMIN_ONLY = [ADMIN]`

### 1c. Decide the two layers explicitly (the core philosophy)
Every item has two independent levers:
- **Nav visibility** (`rbac`) — hide the item entirely.
- **Action gating** (page-level `canEdit`) — show read-only, disable writes.

Rule of thumb proposed: **hide** management/write-only surfaces a role can do nothing on;
**show read-only** informational surfaces. See per-item column "Hidden vs read-only" below.

---

## 2. Org nav visibility matrix (16 items)

Roles: **O**=OWNER **A**=ADMIN **E**=EDITOR **F**=FINANCE **V**=VIEWER **S**=SCANNER.
✓ = item visible. Reflects decisions: hybrid default · VIEWER = read-only **everything** ·
SCANNER = Scan **+ Volunteers** · FINANCE = money + read-only content.
New shared set used below: `ORG_NON_SCANNER = [O,A,E,F,V]`.

| Nav item | O | A | E | F | V | S | Recommended `rbac` set | Notes |
|---|---|---|---|---|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ANY | read-only metrics |
| Events | ✓ | ✓ | ✓ | ✓ | ✓ | – | NON_SCANNER | builder already read-only for non-edit |
| Places | ✓ | ✓ | ✓ | ✓ | ✓ | – | NON_SCANNER | read-only for F/V |
| Orders | ✓ | ✓ | ✓ | ✓ | ✓ | – | NON_SCANNER | V read-only |
| Promos | ✓ | ✓ | – | ✓ | ✓ | – | [O,A,F,V] | V read-only · `featureFlag: promos` |
| Audiences | ✓ | ✓ | ✓ | – | ✓ | – | [O,A,E,V] | V read-only (PII included — decided) |
| Volunteer roles | ✓ | ✓ | ✓ | – | ✓ | – | [O,A,E,V] | V read-only |
| Volunteers | ✓ | ✓ | ✓ | – | ✓ | ✓ | [O,A,E,V,S] | SCANNER included (door check-in) |
| Announcements | ✓ | ✓ | ✓ | – | ✓ | – | [O,A,E,V] | V read-only (sent history) |
| Embeds | ✓ | ✓ | ✓ | – | ✓ | – | [O,A,E,V] | V read-only |
| Payments | ✓ | ✓ | – | ✓ | ✓ | – | [O,A,F,V] | V read-only |
| Team | ✓ | ✓ | – | – | ✓ | – | [O,A,V] | V read-only roster |
| Scanner setup | ✓ | ✓ | – | – | – | – | ADMIN | pure device config — nothing to observe |
| Scan ticket | ✓ | ✓ | ✓ | – | – | ✓ | SCAN | — |
| Search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ANY | utility |
| Settings | ✓ | ✓ | – | – | ✓ | – | [O,A,V] | V read-only (already works); Danger sub-tab OWNER-only |

**SCANNER outcome:** Dashboard, Volunteers, Scan, Search — a focused door-staff view (4 of 16).

**VIEWER outcome:** read-only auditor of **every** data surface incl. Audiences/PII; only
Scanner-setup (config) and Scan (an action) are hidden. 14 of 16 visible, all read-only.

---

## 3. Platform nav visibility matrix (19 panels)

Staff roles: **AD**=ADMIN **RV**=REVIEWER **SP**=SUPPORT **DV**=DEVELOPER.
Decided: ADMIN = all · DEVELOPER = all · SUPPORT = customer (orders/users) **+ moderation** ·
REVIEWER = **moderation only**. DEVELOPER is co-equal to ADMIN for *visibility* (destructive
mutations — ban/delete/force-verify — stay ADMIN-only at the page level).

| Panel | AD | RV | SP | DV | `rbac` set |
|---|---|---|---|---|---|
| Overview | ✓ | ✓ | ✓ | ✓ | STAFF_ALL |
| Support | ✓ | ✓ | ✓ | ✓ | STAFF_ALL |
| Places | ✓ | ✓ | ✓ | ✓ | STAFF_ALL |
| Reviews | ✓ | ✓ | ✓ | ✓ | STAFF_ALL |
| Categories | ✓ | ✓ | ✓ | ✓ | STAFF_ALL (delete still ADMIN/DEV at page level) |
| Featured | ✓ | ✓ | ✓ | ✓ | STAFF_ALL |
| Orders | ✓ | – | ✓ | ✓ | [ADMIN, SUPPORT, DEVELOPER] |
| Tickets | ✓ | – | ✓ | ✓ | [ADMIN, SUPPORT, DEVELOPER] |
| Humans | ✓ | – | ✓ | ✓ | [ADMIN, SUPPORT, DEVELOPER] (ban/delete ADMIN-only) |
| Settlements | ✓ | – | – | ✓ | STAFF_TECH `[ADMIN, DEVELOPER]` |
| Theme editor | ✓ | – | – | ✓ | STAFF_TECH |
| Fees | ✓ | – | – | ✓ | STAFF_TECH |
| Promos | ✓ | – | – | ✓ | STAFF_TECH |
| Jobs | ✓ | – | – | ✓ | STAFF_TECH |
| Quotas | ✓ | – | – | ✓ | STAFF_TECH |
| Feature gates | ✓ | – | – | ✓ | STAFF_TECH |
| Webhook DLQ | ✓ | – | – | ✓ | STAFF_TECH |
| Settings | ✓ | – | – | ✓ | STAFF_TECH |

**REVIEWER:** 6 moderation panels. **SUPPORT:** those 6 + Orders/Tickets/Humans (9).
**DEVELOPER / ADMIN:** all 19.

---

## 4. Open decisions (the "small choices")

**Resolved 2026-06-30:**
1. ✅ **Default philosophy** — hybrid (hide write-only/config, show read-only informational).
2. ✅ **VIEWER reach** — read-only **everything** (auditor).
3. ✅ **SCANNER** — Scan **+ Volunteers** (+ Dashboard/Search).
4. ✅ **FINANCE** — money surfaces + read-only content context.

5. ✅ **Audiences/PII for VIEWER** — included (true read-only-everything).
6. ✅ **SUPPORT** — customer (orders/users) **+ moderation** panels.
7. ✅ **REVIEWER** — moderation only (no Orders/Humans).
8. ✅ **DEVELOPER** — everything (co-equal to ADMIN for visibility; writes still ADMIN-gated).

**Matrix is decision-complete.** Remaining work is implementation (§5) + the page-level
action sweep to align read-only/disabled states with these sets.

---

## 5. Rollout

1. Land mechanism (§1) behind no behavior change (no `rbac` set yet → nothing hidden).
2. Annotate org nav (§2) — ship, verify with the seeded role-test users
   (`role-orgtest@ithasfire.com`, cycle role in team UI).
3. Annotate platform nav (§3) — verify with `role-reviewer@` / `role-support@`.
4. Sweep page-level actions to match (settings/event/scanner-setup already partly done;
   align orders, audiences, payments, announcements to the same role-sets).
5. Tests: extend `NavigationShell.test.tsx` (already exercises `rbac` + `VIEWER`) with the new sets.

**Note:** nav `rbac` is cosmetic — it hides affordances. Server-side use-case checks remain
the real boundary. Hiding a nav item is never a substitute for the procedure's role check.
