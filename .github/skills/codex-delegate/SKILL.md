---
name: codex-delegate
description: "Delegate a task to Codex (OpenAI GPT) non-interactively for cross-model diversity — a second-opinion code review, cheap/mechanical offload, or UI verification against a screenshot. Use when you want an INDEPENDENT model's perspective on a high-stakes diff, want to offload bulk mechanical work off the Claude subagent budget, or need a vision check on a rendered UI. Always runs through the hang/crash watchdog. Use when asked to 'get a second opinion', 'have GPT/codex review this', 'cross-check with another model', or 'verify this UI with codex'."
---

# Codex Delegate (cross-model GPT)

Run **Codex (OpenAI GPT)** headlessly from the orchestrator to get a *different
model's* eyes on the work. This is **additive**, not a replacement for the
Claude specialist agents — the biggest wins this codebase has seen came from
strong review catching subtle bugs (a TOCTOU race, a Turbopack prod bug, an
incomplete auth allowlist), so keep the **primary** review at full Claude
strength and use Codex as an **independent second checker**, cheap offload, or
a computer-use runner.

> **TASTE STAYS WITH CLAUDE — hard rule.** Never delegate aesthetic/design/
> product-taste judgment to Codex: UI layout, visual design, spacing, copy
> voice, "does this look and feel right." **Claude leads UI work and owns the
> verdict.** Codex may at most do a *mechanical* pass (is the element present?
> did it regress?) and only when Claude chooses to — the design call is never
> its to make. When unsure whether something counts as taste, treat it as taste.

Everything goes through **`scripts/codex-headless.sh`** — never call `codex`
directly. The wrapper exists because `codex exec` can hang and this Mac has no
`timeout`/`gtimeout`. It runs on **`gpt-5.6-terra`** by default (`gpt-5.6-luna`
for fast/cheap bulk work).

**The watchdog investigates; it does not reflexively kill.** A big reasoning
model legitimately goes quiet for minutes mid-reasoning, so a stall is not a
reliable crash signal. On hitting the hard cap (default 600s = the "10-minute
check") or the stall window (default 180s), the wrapper prints a **diagnosis**
(process alive? last JSONL event? mid tool-call? child procs? log path) and, by
default, **leaves the process alive** and returns **exit 125** ("inconclusive —
you decide"), with `inspect / codex resume / kill` instructions. Pass
`--kill-on-cap` to hard-terminate instead (exit 124). Any kill is by **PGID** —
never `pkill`/`killall` by name (shared machine, other sessions run `codex`).

## When to reach for this

| Use case | Recipe | Notes |
|----------|--------|-------|
| **Second-opinion review** (high-stakes diff: money, auth/RBAC, migrations, concurrency) | `--review-uncommitted` or `--review-base main` | Run *alongside* the `reviewer` agent; reconcile both sets of findings. Different model → catches different classes. |
| **Mechanical offload** (bulk boilerplate, rote edits with a fully-specified diff) | `--sandbox workspace-write` in an isolated `git worktree` | Frees the Claude subagent budget. Prefer a worktree so it can't clobber the shared tree's concurrent WIP. |
| **Mechanical UI check ONLY** (is the element present? did it regress? — NOT "does it look good") | `--image shot.png -- "confirm the X button and Y table are present …"` | Claude owns all UI taste/design (see the hard rule above). Use this only for element-presence/regression facts, never the aesthetic verdict. |
| **Computer-use** (read/drive live Mac apps: click, type, read a window) | `--computer-use -- "…"` | Sets the authorized bypass to clear the MCP elicitation gate. Scope the prompt tightly (bypass drops the sandbox). |

For anything needing **structured, harness-tracked, context-sharing** results,
prefer a Claude subagent or a `Workflow` — Codex here returns prose (or a JSON
blob if you pass `--schema`) over a shell boundary, not a native schema object.

## Recipes

Second opinion on the current uncommitted diff (read-only; it never edits):

```bash
scripts/codex-headless.sh --review-uncommitted -- \
  "Focus on money math, RBAC gaps, and idempotency. Flag anything a reviewer should block on."
```

Review a branch's changes against main:

```bash
scripts/codex-headless.sh --review-base main -- "Security-focused pass."
```

UI verification from a screenshot, with a structured verdict:

```bash
cat > /tmp/ui-verdict.schema.json <<'JSON'
{ "type":"object","required":["matches","issues"],
  "properties":{ "matches":{"type":"boolean"},
    "issues":{"type":"array","items":{"type":"string"}} } }
JSON
scripts/codex-headless.sh --image /tmp/roles-page.png --schema /tmp/ui-verdict.schema.json -- \
  "This is the /platform/roles page. Verify against: table with role badges, per-row grant dropdown, ADMIN-only revoke. List any mismatches."
```

Mechanical offload in an isolated worktree (so it can edit safely):

```bash
git worktree add /tmp/codex-wt HEAD
scripts/codex-headless.sh --cd /tmp/codex-wt --sandbox workspace-write --cap-seconds 600 -- \
  "Add a JSDoc block to every exported function in packages/foo/src that lacks one. No behavior changes."
# then review /tmp/codex-wt's diff, cherry-pick what's good, and: git worktree remove /tmp/codex-wt
```

## Reading the result

- Final message is printed between `---CODEX-BEGIN---` / `---CODEX-END---`.
- **Exit 0** — completed; use the message.
- **Exit 125** — watchdog tripped (cap/stall) and **left it running**. Read the
  diagnosis on stderr: if `last event` shows active tool-calls/reasoning it's
  healthy — raise `--cap-seconds` or `codex resume`. If it looks genuinely
  wedged, kill the printed PID. **Inconclusive, never a verdict.**
- **Exit 124** — watchdog killed it (only with `--kill-on-cap`). Also inconclusive.
- **Exit 1** — codex errored; the JSONL event log path is printed on stderr.

## Options worth knowing

- `--cap-seconds N` (default 600) — hard ceiling; this is the "10-minute check."
- `--stall-seconds N` (default 180) — kill if no output for N seconds (hang).
- `--sandbox read-only|workspace-write|danger-full-access` (default read-only).
- `--cd DIR`, `--model NAME`, `--image FILE` (repeatable), `--schema FILE`.

## Honest caveats — do not oversell

- **Model:** `gpt-5.6-terra` (balanced everyday, default) or `gpt-5.6-luna`
  (fast/cheap) — pass `--model`. Reasoning effort up to `ultra`
  (`-c model_reasoning_effort=…`). Older tiers `gpt-5.5`/`gpt-5.4` still valid;
  check `~/.codex/models_cache.json` for the live list.
- **Computer-use works headlessly via `--computer-use`** (verified — read a live
  Safari window). It requires `--dangerously-bypass-approvals-and-sandbox` (the
  `--computer-use` flag sets it) to get past Codex's interactive MCP elicitation
  gate — **the user has standing-authorized this**, don't re-ask. Caveat: the
  bypass also drops the shell sandbox, so keep computer-use prompts tightly
  scoped, and macOS Screen-Recording permission must be granted (it is). For UI
  *verification* that only needs to look (not drive), prefer capturing the
  screenshot yourself and passing `--image` — lighter, keeps the sandbox.
- **Costs the user:** runs on their ChatGPT/Codex subscription and is an
  external call. Keep prompts scoped; don't fan out dozens of codex runs the
  way you might with local tools.
- **Shared tree:** default `read-only`. Only use `workspace-write` in a
  dedicated worktree; `danger-full-access` essentially never.
