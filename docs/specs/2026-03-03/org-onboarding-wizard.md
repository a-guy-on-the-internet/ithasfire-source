# Organization Onboarding Wizard

> **Status:** Planned
> **Admin route:** `/admin/[slug]/dashboard` (embedded checklist)
> **Created:** 2026-02-22

## Purpose

After creating an org, the user lands on an empty dashboard with no
guidance. A lightweight onboarding checklist helps new organizers
complete the essential setup steps and reach their first published event
faster.

---

## v1 Scope

### Backend

| Layer | Artifact | Notes |
| --- | --- | --- |
| Schema | `Organization.onboardingCompletedAt` (DateTime?) | Null = still onboarding. Set when all steps are done or user dismisses. |
| Use case | `get-onboarding-status` | Returns completion state for each step. Derives status from existing data (has members? has Stripe? has event?) rather than storing step-by-step progress. |
| Use case | `dismiss-onboarding` | Sets `onboardingCompletedAt` to now. |

### Steps

1. **Invite team members** — Complete when org has > 1 member.
2. **Connect Stripe** — Complete when org has a connected Stripe account.
3. **Create a venue** — Complete when org owns at least one Place.
4. **Create first event** — Complete when org has at least one Event (any status).
5. **Publish an event** — Complete when org has at least one PUBLISHED event.

### Frontend

| Component | Description |
| --- | --- |
| `OnboardingChecklist.tsx` | Card on the dashboard with step list, progress bar, check marks. Each step has a CTA that deep-links to the relevant page. |
| Dismiss action | "I'll do this later" link that hides the checklist permanently. |
| Celebration state | When all steps are done, show a brief "You're all set" message before collapsing. |

---

## Deferred features

- **Per-step tooltips / guided tours.**
- **Onboarding analytics:** Track how many orgs complete each step and where
  they drop off.
- **Re-show option** in org settings if dismissed early.
