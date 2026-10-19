# Event Gating

How an event's public page and tickets are restricted until a viewer is unlocked. Checked against the code on 2026-10-09. The schema and the use cases are the source of truth; this doc is a map to them.

## Gate types

`Event.gateType` is the `EventGateType` enum (`packages/db/prisma/enums.prisma`).

| Gate type | Unlock mechanism | Approval |
|-----------|------------------|----------|
| `NONE` (default) | None. The event is public. | n/a |
| `PASSWORD` | The viewer enters the organiser's password. | Instant |
| `APPLICATION` | The viewer submits an application form and the organiser reviews it. | Manual (or `autoApprove` on the form) |

Invite links (`EventInvite`, SHARED or PERSONAL) can also open a PASSWORD or APPLICATION gate. They are covered under "Grants" below.

## Data model

All in `packages/db/prisma/`. Read the schema for field lists; the points that matter:

- `EventUnlock` (`event.prisma`): one row per (event, human). `source` is `EventUnlockSource` (`PASSWORD`, `APPLICATION`, `ADMIN`, `INVITE_LIST`, `MAGIC_LINK`, in `enums.prisma`). It also carries `applicationSubmissionId`, `inviteId`, `expiresAt` and `revokedAt`. An unlock is gate-agnostic: `isUnlocked` ignores `source`, so a PASSWORD unlock lifts an APPLICATION gate and the reverse. Changing `gateType` does not evict existing unlocks, and neither does changing the password (intended; owner, 2026-10-10: "Changing an event password doesn't need to remove who already got in"). The eviction paths are rescinding a decision (`revokeBySubmission`, `_shared/apply-rescind-decision.ts`), revoking a guest invite (`revokeByInvite`, `invites/revoke-event-guest-invite.ts`), and "Reset and remove everyone" on the shared link (`RESET_AND_REMOVE`, `revokeByInvite`, `invites/set-event-shared-invite.ts`). A plain reset or turning the shared link off stops new entries only; nobody already in loses access.
- `EventApplicationForm`, `EventApplicationQuestion`, `EventApplicationSubmission` (`application.prisma`). The same models serve open calls for performers, so a form has a `purpose` (`ApplicationFormPurpose`), an optional `seriesId`, `opensAt` / `closesAt`, `maxSubmissions` and `autoApprove`. A form is unique per (event, purpose).
- `ApplicationQuestionType`: `SHORT_TEXT`, `LONG_TEXT`, `MULTI_CHOICE`, `SINGLE_CHOICE`.
- `ApplicationSubmissionStatus` has more than `PENDING`, `APPROVED`, `REJECTED`: also `WITHDRAWN`, `EXPIRED` and a waitlisted state. Read the enum in `enums.prisma` for the full list.
- One open application per applicant per form is enforced by partial unique indexes that exist in SQL only (see the note in `application.prisma`).

## Grants (how an anonymous viewer passes a gate)

Checkout needs a signed-in buyer, but a gated page is viewable signed out. Three HMAC-signed, HttpOnly cookies, set on the web host, carry the proof:

| Cookie | Meaning | Opens | Revocation |
|--------|---------|-------|------------|
| `th_eu_<eventId>` | Entered the password | PASSWORD gates only | None. A 24-hour bearer pass: the HMAC covers only `eventId` and expiry, and readers check signature and expiry, nothing server-side. A new password does not invalidate it. |
| `th_ea_<eventId>` | Application approved | APPLICATION gates only | `getEventGateState` re-checks it on every call: the submission must belong to the event and still be APPROVED under the same approval. |
| `th_ei_<eventId>` | Redeemed an invite link | Either gate | `getEventGateState` re-checks it on every call against the invite (`invites/invite-grant.ts`). Ends on a personal invite revoke, "Reset and remove everyone" (`grantsRevokedAt`), event end or cancellation; a plain shared-link reset or disable leaves it valid. |

All three are built in `apps/web/src/lib/event-unlock-cookie.ts` and read on the API side by `packages/transport/trpc/src/event-unlock-cookie.ts`. `getEventGateState` never sees `th_eu_`; the transport checks it itself (see "Public reads"). The cookies stay within their gate types; the `EventUnlock` rows they sync into do not. Before checkout, the web app syncs the cookie into a durable `EventUnlock` through `events.recordSignedPasswordUnlock`, `events.recordSignedApplicationUnlock` or `events.recordSignedInviteUnlock`, because the buyer's own API calls cannot carry the web-host cookie.

**Public reads.** Every public event read procedure must call `ensureFullEventReadAccessByEventId` or `ensureFullEventReadAccessBySlug` (`packages/transport/trpc/src/event-read-access.ts`). One read uses the non-throwing form of the same decision, `hasFullEventReadAccessByEventId`: `events.ticketTiersForCard`, the hover teaser on an event card, answers a gate-failing viewer with `{ tiers: [] }` because the card cannot know its event is gated and a refusal is a console error on every hover. A read that returns event data keeps `ensure*`. The gate is the only API read path that accepts the password cookie on its own (the web host mirrors the check in `api/events/[eventId]/unlocked-view/route.ts` and the checkout page; keep those PASSWORD-only too); the other transport uses of `th_eu_` (`events.recordSignedPasswordUnlock`, the pre-checkout sync in `routers/orders.ts`) turn it into an `EventUnlock`. The slug variant returns without a gate check on an unresolvable or redirecting slug, so a caller that follows redirects must resolve the slug and use the `ByEventId` variant (doc comment on `ensureFullEventReadAccessBySlug`).

**Bypass.** `canViewerBypassEventGate` (`_shared/ensure-actor-can-edit-event.ts`) is the event-edit bar: an org member with an edit role, the human owner, or an OWNER, ADMIN or EDITOR delegate of the owner. `getEventGateState`, `validateEventPassword` and `submitEventApplication` use it.

## Use cases

All in `packages/core/src/use-cases/events/` unless noted.

| Use case | What it does |
|----------|--------------|
| `get-event-gate-state.ts` | Returns the gate and the viewer's standing: `passwordRequired`, `applicationRequired`, `viewerCanBypass`, `viewerIsUnlocked`, the application and invite grant flags, and the waitlist fields. A hidden event (draft, never live) answers `EVENT_NOT_FOUND`. |
| `validate-event-password.ts` | Verifies the password, behind a Turnstile challenge after repeated failures. For a signed-in viewer it upserts an `EventUnlock` with `source: PASSWORD`. Returns `{ eventId, unlocked, bypassed, persisted }`. |
| `record-verified-event-password-unlock.ts`, `record-application-grant-unlock.ts`, `invites/record-invite-grant-unlock.ts` | Turn a verified cookie into a durable unlock for a signed-in subject. |
| `submit-event-application.ts` | Validates answers against the form, creates a submission (guests allowed). Returns `{ eventId, submissionId, status, bypassed }`. A viewer who passes the bypass gets `bypassed: true` and no submission. |
| `review-event-application-submission.ts` | Decides `APPROVED`, `REJECTED` or `WAITLISTED`. Only a `PENDING` or `EXPIRED` submission can be decided; anything else answers `INVALID_STATUS`. Changing a decision means rescinding first, because deciding straight over one (APPROVED to REJECTED) would leave the unlock in place. Approval mints an approval token (TTL 5 minutes to 7 days) and upserts an `EventUnlock` with `source: APPLICATION`. |
| `redeem-application-approval-token.ts` | Redeems the approval token. The signed-in subject of the submission gets an `EventUnlock` with `source: APPLICATION`; anyone else gets nothing persisted, and the web claim route sets the `th_ea_` cookie instead. |
| `rescind-event-application-decision.ts`, `withdraw-event-application.ts`, `expire-event-applications.ts` | Undo a decision, applicant withdrawal, nightly expiry of pending submissions on closed forms. |
| `upsert-event-application-form.ts`, `upsert-event-application-question.ts`, `delete-event-application-question.ts`, `get-event-application-form.ts`, `get-public-event-application-form.ts` | Form builder reads and writes. |
| `orders/checkout-helpers.ts` `ensureEventAccessible` | Called from `orders/create-checkout.ts`, `orders/claim-free-tickets.ts` and `orders/update-order-items.ts`. Other modules define their own `ensureEventAccessible` that checks something else (for example `ticket-types/upsert-ticket-type.ts` and `events/publish-event.ts`); grep for the import path, not the name. For a gated event it requires an active `EventUnlock` for the buyer and throws `FORBIDDEN` otherwise. It does not look at org roles; a bypassing organiser sees the page but has no unlock row unless one was recorded, so `ensureEventAccessible` would refuse them at checkout. Nothing in `packages/core` writes an `ADMIN`-source unlock today. |

## Ports and adapters

- `EventUnlocksRepo`: `packages/ports/src/repos/event-unlocks.ts`, types in `packages/types/src/repos/event-unlocks.ts`, Prisma adapter `packages/adapters/src/db/prisma/event-unlocks.ts`.
- `EventApplicationsRepo`: `packages/ports/src/repos/events.ts` (around line 1206), Prisma adapter `packages/adapters/src/db/prisma/event-applications.ts`. Open-call methods live beside it in `event-applications-open-calls.ts` and the `event-applications-open-call-*.ts` files.

## tRPC procedures (`packages/transport/trpc/src/routers/events.ts`)

| Procedure | Calls |
|-----------|-------|
| `events.getGateState` | `getEventGateState` |
| `events.validatePassword` | `validateEventPassword` (rate limited per event, actor and IP) |
| `events.recordSignedPasswordUnlock`, `recordSignedApplicationUnlock`, `recordSignedInviteUnlock` | The grant-sync use cases above |
| `events.getGatedPreview` | Minimal preview (title, hero) for a gated event |
| `events.getPublicApplicationForm` | Applicant-facing form read |
| `events.submitApplication` | `submitEventApplication` |
| `events.getViewerApplicationStatus`, `events.withdrawApplication`, `events.redeemApplicationToken` | Applicant status, withdrawal, approval-token redemption |
| `events.listEventApplicationSubmissions`, `events.reviewEventApplicationSubmission`, `events.rescindEventApplicationDecision` | Organiser review |
| `events.getApplicationForm`, `events.upsertApplicationForm`, `events.upsertApplicationQuestion`, `events.deleteApplicationQuestion` | Organiser form builder |
| `events.joinEventWaitlist` | Waitlist |
| Invite procedures (`setSharedInvite`, `createGuestInvites`, `redeemInvite`, ...) | Invite links |

## Web

- Event page: `apps/web/src/app/events/[...slug]/page.tsx`. It calls `loadPublicEventGate` and, when `isEventGateActive`, renders `GatedEventShell` over a preview from `fetchEventGatedPreview`. The viewer's own standing is settled client-side after first paint so the page stays cacheable.
- Gate UI in `apps/web/src/app/events/[...slug]/_components/`: `GatedEventShell.tsx`, `PasswordDoor.tsx`, `EventPasswordGateWrapper.tsx`, `EventApplicationGateWrapper.tsx`, `InviteDoor.tsx`.
- Password success sets the signed unlock cookie (so the unlock survives `router.refresh()` for signed-out viewers) and writes a `th-event-just-unlocked:<eventId>` sessionStorage flag.
- Embed widget: a gated event never unlocks in an embed, which has no grant cookies and no session (owner ruling 2026-10-12). `assertEventUngatedForEmbed` (`packages/core/src/use-cases/embeds/_shared/assert-event-ungated-for-embed.ts`) refuses guest checkout and seats with `EVENT_GATED`. This holds even when the typed email's human holds an unlock, because an embed buyer is named by a typed email. `createCheckout` and `claimFreeTickets` enforce the same rule inside their transactions through `ensureBuyerMayEnterEvent` (`orders/checkout-helpers.ts`), which never consults an unlock when the server-only `serverContext.embedId` is set. Calendar items for gated events are `checkoutEligible: false`, so a click links out. `waivers.getEventWaiver` sits behind `ensureFullEventReadAccessByEventId`, the same as fee rates. `getEmbedEventDetail` returns a cut-down preview: title, hero, date and time zone, slug and `gateType`, with no place, body or tiers. The widget renders it as `EmbedGatedEventCard.tsx`, with a button that opens the event page in a new tab. List cards keep their price and show the gate row.
- Resale (owner rulings 2026-10-13): an event's resale list (`resale.listEventListings`) is behind the gate. The guard lets in the owner, the owning org's members and the owner's delegates, in any role, for the admin resale page. The direct listing link (`resale.getListing`, `/events/resale/[listingId]`) and resale checkout take no gate check, so a holder can pass a ticket to anyone. The link answers only for an ACTIVE or HELD listing (SOLD to its buyer, anything to the seller), refuses, except to the seller, a missing, draft, cancelled or RSVP-only event, and never returns the seller's or ticket's id. A banned owner's event is not refused: resale stays open under ban-that-sticks, and checkout sells it.
- Organiser form builder: `apps/web/src/app/admin/[slug]/events/new/_components/ApplicationFormBuilder.tsx`. Submission review lives under `apps/web/src/app/admin/[slug]/events/[id]/applications/`.

## UX patterns

1. Modal-first: gate states render as overlay cards over the blurred preview, so the viewer keeps context.
2. Scroll-safe on mobile: modals cap `max-height` and scroll internally so long application forms do not break the layout.
3. Progressive disclosure: show the preview (title and hero) at once, then the gate UI for the `gateType`. If the viewer already has a submission, show its status instead of the form.
