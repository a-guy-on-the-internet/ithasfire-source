# Platform roles doc — access matrix correction

**Date:** 2026-04-28
**Status:** in-progress
**Priority:** P3 (docs accuracy)
**Depends on:** N/A
**Supersedes:** N/A

---

## Problem

`docs/roles.md` lines 76–91 has an access matrix that conflates **read-only platform views** with all platform actions, and is inaccurate for at least two rows:

- **Place verification: All four roles "Yes"** — code only allows `ADMIN, REVIEWER` (`packages/core/src/use-cases/places/review-place-verification.ts:11`). SUPPORT and DEVELOPER cannot review.
- **Refunds: ADMIN/SUPPORT "Yes", REVIEWER/DEVELOPER "No\*"** — accurate, but the asterisked footnote framing implies the No*'s are temporary, when in fact each write-target has a deliberate role pair (REVIEWER never had refund authority and never will under current design).

The doc also omits two write-target categories that exist in code:

- **Platform settings (theme presets, platform setting writes):** gated on `ADMIN, DEVELOPER` (`update-platform-setting.ts:55`, `theme-presets/*.ts`).
- **Payouts (schedule/list-due):** gated on `ADMIN, SUPPORT` (alongside refunds).

## Goal

Replace the access matrix with one that accurately reflects the role pairs encoded in code today, structured by **action target** not by role-blanket access.

## Design

### Replace lines 76–91 with:

A table organized by action target, showing the explicit role pair. Plus a clarifying note that "platform shell access" / "read-only platform views" is the only blanket-all-staff capability; every write is paired.

Add columns for the two missing write categories:
- "Platform settings"
- "Payouts (schedule/list-due)"

Correct the "Place verification" row.

Drop the "*" footnote about refunds being temporary — replace with a single sentence explaining the convention: each write target lists its specific role pair; the matrix is intentionally tight, not a simplification.

### Out of scope

- Code changes (none — current gates are correct).
- Renaming `OrgRole` or `HumanRole`.
- The `@th → @hf` rename.

## Acceptance

- `docs/roles.md` access matrix lists each write target separately.
- Place-verification row reflects ADMIN+REVIEWER only.
- Platform-settings + Payouts rows added.
- Footnote no longer implies refunds gating is temporary.

## Effort

~10 min. Single file edit.
