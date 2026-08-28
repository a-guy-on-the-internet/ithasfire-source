# Ithas Fire — Agent Instructions

This file is the application-level entry point for AI coding agents (Cursor, Copilot, Aider, Claude Code, etc.) working in this monorepo.

For project architecture, the dev orchestrator, and the full skill index, see [CLAUDE.md](./CLAUDE.md).

## Design System Rules

The full Swiss International design spec lives in the `[skill:ui]` skill. Two rules are important enough to surface here so they aren't missed:

### 1. Strict Swiss applies to content, not chrome

- **Content** (hero, headlines, CTAs, cards, forms, data tables, anything inside the page body) → **strict Swiss**: `borderRadius: 0`, thick visible borders, no shadows, color-inversion hovers, UPPERCASE bold labels.
- **Chrome** (top navbar, popover triggers, floating action bars, language picker, profile avatar, notification bell, anything whose job is _tool affordance_, not _primary content_) → **soft chrome**: pill shapes (`borderRadius: 999`), hairline 1px borders with low-alpha white, frosted glass (`backdrop-filter: blur()`) where appropriate, snappy 150–200ms transitions.

When in doubt, ask: _is this the content the user came for, or is it the frame around it?_ Frame → soft chrome. Content → strict Swiss.

This exemption exists because Swiss style demands that "design recedes to let content speak." Rectangular hover-flips on tiny chrome targets (bell, avatar) fight the content instead of receding behind it. Soft chrome serves the same tenet.

### 2. No new design tokens when existing ones cover the need

If you find yourself reaching for a hex value, check `packages/ui` theme tokens first. Only introduce new tokens with a clear name and a clear reason.

## Workflow

For any non-trivial implementation task, invoke the dev loop: `[skill:dev]`. It runs plan → route → build → review → fix → approve.

For UI work specifically, invoke `[skill:ui]` — it carries the full design system spec including the chrome exemption above.
