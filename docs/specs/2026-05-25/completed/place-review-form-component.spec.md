# Spec: Extract Place Review Form into a Reusable Component + Retire Pre-Launch Homepage

**Status:** complete
**Date:** 2026-05-25
**Owners:** Web

## Goal

Lift the place-review form out of the Coming Soon homepage so it can live as a standalone, linkable page used by email outreach campaigns. Make event discovery the default homepage. Treat the "pre-launch" Coming Soon experience as no longer load-bearing.

## Background

Today the place-review form is welded into `ComingSoonLayout` ([apps/web/src/app/_components/ComingSoonLayout.tsx](../../../apps/web/src/app/_components/ComingSoonLayout.tsx), lines 375–378), which is gated by the `fullHomepage` feature flag (default `false`) via [HomeGatedLayout.tsx](../../../apps/web/src/app/_components/HomeGatedLayout.tsx). The form orchestrator lives at [`PlaceReviewFormOrchestrator.tsx`](../../../apps/web/src/app/_components/home/place-review/PlaceReviewFormOrchestrator.tsx), submitting via `trpc.placeReviews.submit`.

Email outreach for the launch wants to ask artists/promoters to fill out the place-review form. That requires a stable URL that does *not* depend on the homepage being in pre-launch mode.

## Decisions

1. **Extract the form into a standalone feature component** with no homepage chrome around it.
2. **Add a dedicated page** at `/review-a-place` that mounts the form with optional URL-prefill. This is the canonical outreach URL because "place" matches the code vocabulary while still reading clearly in email copy.
3. **Flip `fullHomepage` default to `true`** so discovery is the homepage. Keep the gate temporarily as a kill-switch.
4. **Plan to delete `ComingSoonLayout` and the `fullHomepage` gate** after one stable release. The user-facing reason to keep Coming Soon is gone — the form has its own home.

## Non-goals

- Embedding the form *inside* email bodies. tRPC submissions can't originate from email clients; emails must link out to the form page.
- Redesigning the form itself. Field set stays as-is (venue autocomplete, payout, payment methods, promotion, sound, audience fit, stage equipment, parking/load-in, booker rating, genre tags, estimated draw, gig date/time, merch policy, staff support, independent status, comments, user jobs, name/email).
- Building the email-send job (separate spec — see [Out of scope](#out-of-scope)).

## Component design

### `PlaceReviewForm` (new public surface)

Move the form into a feature module under `apps/web/src/app/_components/place-review/` (rename from `home/place-review/`). Public exports:

```ts
// apps/web/src/app/_components/place-review/index.ts
export { PlaceReviewForm } from "./PlaceReviewForm";
export type { PlaceReviewFormProps, PlaceReviewPrefill } from "./types";
```

Props:

```ts
type PlaceReviewPrefill = {
  name?: string;
  email?: string;
  placeId?: string;        // pre-select a venue (skip autocomplete step)
  placeName?: string;      // fallback display name if placeId not resolvable
  campaign?: string;       // e.g. "launch-outreach-2026-06" — stored on the submission
};

type PlaceReviewFormProps = {
  prefill?: PlaceReviewPrefill;
  // Layout hooks so the form can sit inside different shells.
  variant?: "page" | "embedded";  // controls outer spacing/heading
  onSubmitted?: () => void;       // optional callback (analytics, redirect override)
};
```

The orchestrator's current localStorage recovery, optimistic UI, and submit mutation stay as-is — they just move with the file.

### `apps/web/src/app/review-a-place/page.tsx` (new route)

Server component that:

1. Reads search params: `name`, `email`, `place`, `campaign`.
2. Renders `<PlaceReviewForm variant="page" prefill={...} />` inside a slim page shell (header/footer reused from `HomeLayout`'s top-level chrome, **not** the homepage hero).
3. Sets `metadata` for OG/Twitter so the email link previews correctly.
4. Adds a `noindex` meta until launch (this URL is for invited folks; not for organic discovery).

Page is statically rendered where possible; the form itself is a Client Component already.

### Submission attribution

Extend the `placeReviews.submit` tRPC input to accept an optional `sourceAttribution: { campaign?: string; channel?: "email" | "homepage" | "direct" }` block. Persist it on the row so we can break down responses by outreach batch.

**Note:** The existing `source: PlaceReviewSource` field (SURVEY/PLATFORM/IMPORTED) remains for tracking legacy review origin; `sourceAttribution` is a separate, newer layer for campaign/channel tracking.

- Migration: `Add PlaceReview.sourceCampaign + sourceChannel columns (both nullable text).`
- Backfill: leave existing rows null. They came from the homepage.

## Homepage flip

### Phase 1 (this PR)

- Change `fullHomepage` **default** to `true` in [`apps/web/src/server/feature-gates.ts`](../../../apps/web/src/server/feature-gates.ts) (line 28) — both the API-failure fallback *and* the local seed.
- Update any feature-gate seed in `packages/db` so dev/prod default to `true` on next deploy.
- `HomeGatedLayout` keeps the gate read so we can flip back via the platform gates admin UI if discovery has a bad bug at launch.

### Phase 2 (follow-up PR, after one stable release)

- Delete `ComingSoonLayout.tsx` and its co-located assets.
- Remove `HomeGatedLayout` — root `page.tsx` renders `HomeLayout` directly.
- Remove `fullHomepage` from `FeatureGatesSnapshot` and from the platform gates seed.
- Search & delete any other references (analytics events, tests, storybook).

A `<NoticeBanner />` on the discovery homepage during Phase 1 → "We're still finalizing details — [tell us about your venue](/review-a-place)" is optional; only add if marketing wants the cross-link.

## URL contract for outreach emails

Canonical link the email job generates:

```
https://{host}/review-a-place
  ?name={url-encoded full name}
  &email={url-encoded email}
  &place={placeId-or-omitted}
  &campaign=launch-outreach-2026-06
```

All params are optional. The form must render and submit cleanly with none of them.

## Accessibility & UX rules carried over

- Submit button stays disabled until required fields are valid.
- LocalStorage draft recovery still works on the new page (key remains the same so a user who started on the old homepage can finish on the new URL — verify behavior in QA).
- After submission, the page shows a confirmation state with a CTA "Browse upcoming events" → `/`. No more "back to Coming Soon."

## Analytics

- Page view event `place_review.page_view` with `{ campaign, channel, hasPrefill }`.
- Submit event `place_review.submitted` with `{ campaign, channel }`.
- Drop-off event `place_review.abandoned` on unmount-without-submit if any field was touched.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Discovery homepage has an unknown bug at launch | Gate stays in place; flip back via admin UI |
| Email recipients see different form than internal QA | Keep the same component; only the shell differs |
| LocalStorage draft key collision between old/new mount points | Audit `PlaceReviewFormOrchestrator` for the storage key; reuse verbatim |
| `placeId` prefill resolves to a deleted venue | Form falls back to the regular autocomplete step; `placeName` shown as a hint |
| SEO indexing of `/review-a-place` | `noindex` until launch + post-launch decision |

## Open questions

- [x] URL: `/review-a-place` is the canonical outreach route. "Place" matches code vocabulary; the surrounding email copy can use "venue" where that reads better to artists.
- [ ] Do we want a magic-link variant (signed token in the URL → no `email` query param needed, prefills server-side)? Nice-to-have, not blocking.
- [ ] Should `campaign` be a known enum (admin-managed) or free-form string? Free-form is simpler; enum gives clean analytics.
- [ ] Confirm there's no analytics dashboard depending on `place_review.submitted` originating from the homepage.

## Implementation plan

1. **PR 1 — Extract**: move the form module out of `home/`, add `variant` prop, no behavior change. Coming Soon still uses it via the new import.
2. **PR 2 — Route**: add `/review-a-place` page with prefill parsing + `noindex`. Manual smoke test with prefilled params.
3. **PR 3 — Attribution**: add `sourceCampaign` / `sourceChannel` columns + migration + tRPC input changes.
4. **PR 4 — Flip default**: `fullHomepage` defaults to `true`. Verify on dev; deploy.
5. **PR 5 (follow-up)**: delete `ComingSoonLayout`, `HomeGatedLayout`, and the gate after one stable release.

## Out of scope (track separately)

- Email send job that targets venue owners with the form link (separate `transport/` spec — covers list source, throttling, opt-out wiring).
- Server-side magic-link prefill (extension of this spec, not blocking).
- Designing a dedicated post-submit thank-you page beyond the existing inline confirmation.
