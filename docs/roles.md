# Roles

## Organization roles (`OrgRole`)

Assigned per org via `OrgMember`. A human can hold different roles in different orgs. A role applies to every
event and place the org owns: there is no per-event assignment.

### Where the rules live

A use case names the roles it accepts, usually with one of the role sets in `packages/core/src/lib/rbac.ts`:

| Set | Roles | Used for |
| --- | --- | --- |
| `ORG_ANY_ROLE` | all six | org-wide reads: the org, its members, booking requests, promos list, stats |
| `ORG_EDIT_ROLES` | OWNER, ADMIN, EDITOR | content: events, ticket types, embeds, event templates, series; door-sale refunds at the till within 15 minutes (`pos/refund-pos-sale.ts`, `pos/refund-cash-sale.ts`) |
| `ORG_ADMIN_ROLES` | OWNER, ADMIN | members and invitations, org settings, place switches; unpublish, cancel, delete, archive and complete an event; comp tickets; pairing POS card readers |
| `ORG_FINANCE_ROLES` | OWNER, ADMIN, FINANCE | money: org order lists; refunds of card-paid orders, online and door (after the 15-minute window), through `orders/org-refund-full-order.ts` and `orders/org-refund-order-items.ts`; payouts, settlements, exports, promos, membership tiers, Stripe onboarding, the Stripe Express dashboard login link (`stripe-connect/create-connect-login-link.ts`) |
| `ORG_EDIT_OR_FINANCE_ROLES` | OWNER, ADMIN, EDITOR, FINANCE | agreement lines, booking-agreement finalization, reading default payout terms, settlement-sheet edits, Connect status, comp-order lists, event attendee search, ticket transfer |
| `ORG_SCAN_ROLES` | OWNER, ADMIN, EDITOR, SCANNER | scanning and the scanner event manifest; door sales by card reader and cash (`pos/start-pos-sale.ts`, `pos/record-cash-sale.ts`, plus cancelling an unpaid sale); the cash till report and cash-sale list; the reader list; org ticket search by name, email or code (`tickets/search-org-tickets.ts`) |
| `ORG_CASH_REFUND_ROLES` | OWNER, ADMIN, EDITOR, FINANCE | cash-sale refunds after the till window, until 7 days after the event ends (declared and used in `pos/org-refund-cash-sale.ts`) |
| `ORG_OWNER_ONLY` | OWNER | archiving the org; anything that makes, unmakes or invites an OWNER, revoking a live OWNER invitation, and ownership transfer (`orgs/{delete-org,update-member-role,remove-org-member,invite-member,revoke-invitation,transfer-ownership}.ts`) |

Two ways a role is checked, and they differ:

- **Literal match.** `requireOrgMembership` (`rbac.ts`) and `actorHoldsEventEditRole`
  (`packages/core/src/lib/event-edit-rights.ts`) accept exactly the roles listed.
- **With implication.** `authz.hasOrgRole` / `requireOrgRole` (`packages/adapters/src/authz/db-authz-adapter.ts`)
  expand the actor's role first: OWNER satisfies every role, ADMIN satisfies every role except OWNER, EDITOR also
  satisfies VIEWER, and FINANCE, SCANNER and VIEWER satisfy only themselves.

### The AuthZ port

`packages/ports/src/authz.ts`, implemented by `db-authz-adapter.ts`:

- `hasOrgRole` / `requireOrgRole`: the actor's membership in one org, with implication (above). `requireOrgRole`
  throws `forbidden`.
- `canEditEvent`: an org-owned event needs OWNER, ADMIN or EDITOR in the owning org. A human-owned event needs the
  owner, or a delegate of the owner holding one of those roles. An event with no owner (a community listing)
  returns false.
- `canManagePlace`: a verified human owner of the place, or OWNER, ADMIN or EDITOR in an org that owns it.
- `canFinanceOrg`: OWNER, ADMIN or FINANCE in the org.
- `hasStaffRole`: whether the actor holds any of the listed platform roles (next section).

### What each role can do

OWNER
Everything an org role can do. The only role that can archive the org (`orgs/delete-org.ts`, which also refuses
while the org has active events). An org always keeps at least one OWNER: demoting or removing the last one
fails (`CANNOT_DEMOTE_LAST_OWNER`, `CANNOT_REMOVE_LAST_OWNER`). Only an OWNER can make a member an OWNER, change
or remove an OWNER, invite at OWNER, or transfer ownership (`orgs/transfer-ownership.ts`, one transaction). An
OWNER invitation is honoured at accept only while its inviter still holds OWNER.

ADMIN
Everything OWNER can do except archive the org and the OWNER actions above. Manages members: invites, changes
roles, removes members and revokes invitations at every role but OWNER (`orgs/invite-member.ts`, `orgs/update-member-role.ts`,
`orgs/remove-org-member.ts`); trying any of them on an OWNER fails with `INSUFFICIENT_ROLE`. Holds finance (`ORG_FINANCE_ROLES`, `canFinanceOrg`): orders, refunds,
payouts, settlements, exports.
**Ruled (owner, 2026-10-10):** "Admin shouldn't be able to change who the owner is."
**Owner flag:** design said ADMIN has no finance (no agreements, payees, refunds, settlements, exports); code puts
ADMIN in every finance set; owner decides.

EDITOR
Content: creates and edits events, ticket types, embeds and other `ORG_EDIT_ROLES` work. Publishes an event but
cannot unpublish, cancel, delete, archive or complete it. Manages the org's places (`canManagePlace`), but not the
place switches. Through `ORG_EDIT_OR_FINANCE_ROLES`: edits agreement lines, finalizes booking agreements, edits
settlement sheets, and lists comp orders. Refunds
a door card sale only inside the 15-minute window (`pos/refund-pos-sale.ts`). Refunds cash sales: within 15
minutes at the till, then from the Sell screen's sale list (`orgRefundCashSale`) until 7 days after the event
ends. Searches event attendees
and org tickets, scans, and sells at the door. Cannot list the org's orders, refund an online order or a door card
sale after the window, or manage members.
EDITOR passes the scan and door-sale gates on the API but cannot use the scanner app: the app's session and event
list need `SCANNER_OPERATOR_ROLES` (OWNER, ADMIN, SCANNER), so an EDITOR-only member lands on the access-denied
screen.
**Ruled (owner, 2026-10-10):** EDITOR keeps the Sell screen's cash refund; the Stripe dashboard login link is
FINANCE's (OWNER, ADMIN, FINANCE).
**Owner flag:** design said EDITOR has no finance and no agreement edits; code allows the agreement and
settlement-sheet edits above; owner decides.

FINANCE
Money: the org's orders, payouts, settlements, exports, promos, membership tiers and Stripe onboarding
(`ORG_FINANCE_ROLES`), the Stripe dashboard login link, plus everything in `ORG_EDIT_OR_FINANCE_ROLES`. Refunds
any sale from the web Orders page: card-paid orders, full or partial (`canFinanceOrg`), online or at the door, and
cash sales until 7 days after the event ends (`orgRefundCashSale`). Cannot edit events, open a place's edit page,
scan, use the Sell screen, or manage members.
**Ruled (owner, 2026-10-10):** FINANCE refunds any sale.

SCANNER
Uses the scanner app: the session and event list (`SCANNER_OPERATOR_ROLES` in
`packages/core/src/use-cases/scanner/schemas.ts`) and the scan manifest (`ORG_SCAN_ROLES`). The manifest carries
each attendee's and volunteer's display name and full email address for every event the operator can scan, and the
device caches it (`docs/scanner-pii.md`). Through `ORG_SCAN_ROLES` a SCANNER also sells at the door by card reader
and cash, cancels an unpaid sale, reads the cash till report and cash-sale list, and searches the org's tickets by
name, email or code. Cannot refund (door refunds need `ORG_EDIT_ROLES`, online refunds `canFinanceOrg`), and has no
payout, settlement, edit or member-management access.
**Ruled (owner, 2026-10-10):** SCANNER and EDITOR taking card and cash payments at the door and reading the till is
intended ("Scanner and Editor is fine"). The original design gave SCANNER no finance.
**Owner flag:** design said SCANNER sees only name plus the last four characters of an email or phone on scan views;
code returns full emails; owner decides.

VIEWER
The `ORG_ANY_ROLE` reads and nothing else. Those reads include fellow members' email addresses
(`orgs/list-org-members.ts`) and booking-request contact emails (`booking-requests/list-booking-requests.ts`).
**Owner flag:** design said VIEWER sees no PII beyond aggregates; code returns those emails; owner decides.

Paths above are under `packages/core/src/use-cases/` unless given in full.

### Places: three tiers

A place's org access has three tiers:

1. **Navigate:** any member of an owning org, any role (`places/get-place-title.ts`, which returns no location).
2. **Read and edit the place page:** `canManagePlace` (`places/get-place-for-edit.ts`, `places/get-place-detail.ts`).
   The payload carries the street address and exact coordinates.
3. **Flip the place switches** (booking requests, community listings, public attendee reviews, community reviews):
   a direct human owner, or OWNER or ADMIN of an owning org (`places/_shared/place-switch-authority.ts`).

### Delegates

A `HumanDelegate` acts on another person's personal account with an `OrgRole` (OWNER is excluded,
`delegates/create-delegate-invite.ts`). On the principal's own events a delegate gets what an org member with the
same role would get (`actorHoldsEventEditRole`). Payout routing (splits, fee mode, agreements, payout schedule)
stays with the owner: `ensurePayoutRoutingActor` in `event-edit-rights.ts`.

### Step-up MFA

No org role is asked for a second factor or a fresh sign-in on any action. The only second-factor rule in code is
the staff one below.
**Owner flag:** design said step-up MFA is required for OWNER role changes, agreement edits, payouts and refunds,
and for FINANCE agreement edits, refunds, payouts and exports; code runs all of them with no step-up; owner decides.

---

## Platform staff roles (`HumanRole`)

Stored on `Human.roles[]`. A human can hold multiple platform roles simultaneously.
ADMIN, REVIEWER, SUPPORT and DEVELOPER open the `/platform` staff area (`PLATFORM_STAFF_ROLES` in
`packages/transport/trpc/src/routers/platform.ts`); COMMUNITY_MODERATOR does not.
Gated at runtime via `authz.hasStaffRole()`, usually through `requirePlatformStaff` (`packages/core/src/lib/rbac.ts`).
Roles are granted and revoked by a platform ADMIN (`platform/admin-grant-human-role.ts`,
`platform/admin-revoke-human-role.ts`; the last ADMIN cannot be revoked).

**Second factor.** A holder of ADMIN, REVIEWER, SUPPORT, DEVELOPER or COMMUNITY_MODERATOR gets no staff
authority until a passkey or TOTP is enrolled (owner ruling 2026-10-10). The rule lives at the authz port:
`AuthZPort.hasStaffRole` (`packages/adapters/src/authz/db-authz-adapter.ts`) answers
`{ allowed: false, secondFactorRequired: true }` for such a holder, so every staff check refuses, wherever it is
called. `requirePlatformStaff` and `requireScannerAccessOnOrg` (`packages/core/src/lib/rbac.ts`) turn that answer
into `SECOND_FACTOR_REQUIRED`, and the path list in `packages/transport/trpc/src/guard.ts` only makes that code
arrive before the procedure runs; it grants nothing. This is an enrolment requirement, not a per-action step-up:
nothing asks for the factor again before a destructive action.

Three status probes opt out with `allowWithoutSecondFactor: true`, and none grants anything:
`platform.checkStaffAccess` and `community.checkModeratorAccess` (so the shell can send the holder to
`/enroll-2fa` instead of erroring), and `community/apply-to-be-moderator.ts`, which uses the answer only to refuse
someone who already holds the role.

`DEV_BYPASS_STAFF_2FA=true` turns the requirement off only off Cloud Run (`K_SERVICE` and `CLOUD_RUN_JOB` unset)
with `NODE_ENV` unset, empty, `development` or `test`
(`packages/transport/trpc/src/dev-staff-2fa-bypass.ts`). Deployed images set `NODE_ENV=production`.

Known gap: staff notification emails and pushes (entity reports, place claims, community suggestions) go to every
holder of the role, enrolled or not, and carry the reporter's or claimant's text.

USER
In the enum. No production check names it; the authz adapter answers a check that names USER without asking for a
second factor. New humans start with an empty `roles` array (`@default([])` on
`Human.roles`); having no staff role is what makes a human consumer-only.

ADMIN (platform)
Full platform access. All cross-org data: orders, tickets, carts, events, orgs, users.
Manage other humans' staff roles. Override org-level actions (staff refunds, disputes).
Full PII access.
Also acts as OWNER of every org in the scanner, once a second factor is enrolled: with no scan membership of
their own, the scanner lists events from every active org, up to 200 orgs (`requireScannerAccessOnOrg` in
`rbac.ts`, `packages/core/src/use-cases/scanner/list-scanner-accessible-events.ts`).

SUPPORT
Cross-org order, ticket, and cart lookup. Buyer PII for support case resolution.
Trigger staff refunds and schedule payouts. Grant account credit. Work the support inbox (reply, set status) and
review entity reports. View disputes and escalation queues.
Read-only for org configuration and event settings.
Cannot manage staff roles or platform-level configuration.

REVIEWER
Place verification queue: review and approve/reject place ownership claims. Also reviews category requests and
manages featured items.
Reads the same cross-org lists as every staff role (`PLATFORM_STAFF_ROLES`), which carry buyer and ticket-owner
emails (`orders/list-platform-orders.ts`, `tickets/list-platform-tickets.ts`, `humans/list-platform-humans.ts`).
**Owner flag:** design said REVIEWER has no order, ticket or PII access beyond verification submissions; code gives
it the all-staff order, ticket and human lists; owner decides.
Note: the scope of this role is still narrow. Consider whether third-party
verification services (utility bill validation, business registry lookup)
could automate parts of the review workflow.

DEVELOPER
Platform diagnostics, tooling, and observability dashboards. Reads the all-staff cross-org lists.
Writes platform settings and theme presets, featured items and categories (reviews category requests, deletes
categories, sets their SEO type); works the support inbox and reviews entity reports.
Grants account credit (`credits/grant-credit.ts`, `["ADMIN", "SUPPORT", "DEVELOPER"]`): platform-funded credit
redeemable at checkout. No PII exports. No staff role management.
**Ruled (owner, 2026-10-10):** "Developer can grant account credit for now." The original design gave DEVELOPER no
finance actions; revisit when that "for now" ends.

COMMUNITY_MODERATOR
Runs community listings: creates and publishes them, reviews edit suggestions, cancels and restores event dates
(`packages/core/src/use-cases/community/`; most gates accept COMMUNITY_MODERATOR or platform ADMIN through
`COMMUNITY_MODERATION_ROLES` in `community/_shared/suggestion-validation.ts`). People apply through
`community/apply-to-be-moderator.ts` and a platform ADMIN approves (`community/review-moderator-application.ts`).
No `/platform` access.

### Access matrix

Platform shell access and read-only cross-org views are blanket-all-staff.
Some writes pair ADMIN with one specialist role; several (account credit, featured items, categories, the
support inbox, entity reports) take two or three. For a gate not listed, grep `requirePlatformStaff` and
`hasStaffRole`.

| Action target                                           | ADMIN | REVIEWER | SUPPORT | DEVELOPER |
| ------------------------------------------------------- | ----- | -------- | ------- | --------- |
| Platform shell access                                   | Yes   | Yes      | Yes     | Yes       |
| Read-only cross-org views (orders, tickets, places, …)  | Yes   | Yes      | Yes     | Yes       |
| Place verification (review/approve/reject/queue)        | Yes   | **Yes**  | No      | No        |
| Staff refunds                                           | Yes   | No       | **Yes** | No        |
| Payouts (schedule, list-due)                            | Yes   | No       | **Yes** | No        |
| Account credit grant (`credits.grant`)                  | Yes   | No       | **Yes** | **Yes**   |
| Featured items (list, upsert, remove)                   | Yes   | **Yes**  | **Yes** | **Yes**   |
| Category requests (review)                              | Yes   | **Yes**  | No      | **Yes**   |
| Categories (delete, set SEO type)                       | Yes   | No       | No      | **Yes**   |
| Support inbox (reply, set status)                       | Yes   | No       | **Yes** | **Yes**   |
| Entity reports (review)                                 | Yes   | No       | **Yes** | **Yes**   |
| Platform settings (theme presets, platform-config writes) | Yes | No       | No      | **Yes**   |
| Fee waivers, org fee policy                             | Yes   | No       | No      | No        |
| Staff role management                                   | Yes   | No       | No      | No        |
| Human admin (delete, force-verify, suspend, unlink auth account) | Yes | No | No    | No        |
| PII exports                                             | Yes   | No       | No      | No        |

Where the gates live in code:

- Place verification — `packages/core/src/use-cases/places/review-place-verification.ts` (`STAFF_REVIEWER_ROLES = ["ADMIN", "REVIEWER"]`)
- Refunds — `packages/core/src/use-cases/orders/staff-refund-order.ts` (`["ADMIN", "SUPPORT"]`)
- Payouts — `packages/core/src/use-cases/payouts/{schedule-payout,list-due-payouts}.ts`
- Account credit — `packages/core/src/use-cases/credits/grant-credit.ts` (`["ADMIN", "SUPPORT", "DEVELOPER"]`)
- Featured items — `packages/core/src/use-cases/platform/featured-items/*.ts` (all four staff roles)
- Categories — `packages/core/src/use-cases/categories/review-category-request.ts` (`["ADMIN", "REVIEWER", "DEVELOPER"]`), `categories/{delete-category,set-category-seo-type}.ts` (`["ADMIN", "DEVELOPER"]`)
- Support inbox — `packages/core/src/use-cases/support/roles.ts` (`SUPPORT_STAFF_ROLES = ["ADMIN", "SUPPORT", "DEVELOPER"]`)
- Entity reports — `packages/core/src/use-cases/entity-reports/_shared/entity-report-validation.ts` (`["ADMIN", "SUPPORT", "DEVELOPER"]`)
- Platform settings — `packages/core/src/use-cases/platform/update-platform-setting.ts` and `platform/theme-presets/*.ts` (`PLATFORM_STAFF_ROLES = ["ADMIN", "DEVELOPER"]`)
- Fee waivers and fee policy — `packages/core/src/use-cases/platform/{fee-waivers,get-org-fee-policy}.ts` (`["ADMIN"]`)
- Human admin — `packages/core/src/use-cases/platform/admin-*.ts` (`["ADMIN"]`)

### Future considerations

- **Dynamic role/permission creation:** The current code-level role definitions
  work at our scale but won't support customer-defined roles. A generic
  permission-assignment system (role → capabilities mapping stored in DB) is
  deferred until the need is concrete.
- **Reviewer automation:** Place/business verification is currently manual.
  Third-party KYB services (Middesk, Persona, Stripe Identity) could automate
  document validation and ownership checks, reducing the REVIEWER role to an
  oversight/exception-handling function.
- **PII column masking:** Platform views currently expose buyer PII to all staff
  roles. Consider per-role field visibility (e.g., DEVELOPER sees masked emails)
  as the team grows.

See also: `docs/specs/2026-02-19/completed/platform-commerce-admin.spec.md` for the
cross-org orders/tickets/carts platform views.
