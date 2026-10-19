---
name: codex-delegate
description: "Run a task on Codex (the newest GPT, which the owner calls Astra) through the watchdog wrapper: ideas and fact-clearing in a grill or discussion, a second-opinion review of a high-stakes diff, mechanical offload, or a vision check of a screenshot. Use when asked to ask Astra, for a second opinion or a cross-model check, or to hand work to GPT/Codex."
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
`timeout`/`gtimeout`. It runs on the **newest GPT model** by default: the lowest-`priority`
listed model in `~/.codex/models_cache.json` (owner ruling 10-07:
always the latest, never a pinned slug). If the account rejects the auto-picked model
(stale cache: "not supported when using Codex with a ChatGPT account"), the wrapper falls through to the
next listed model, but only when the rejection is a codex `error`/`turn.failed` event and the run did
no work yet; an explicit `--model` is never retried, and `--cap-seconds` is a total across attempts. Pass `--model` only when a task needs a
cheaper tier from the same file.

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
| **Second-opinion review** (high-stakes diff: money, auth/RBAC, migrations, concurrency) | plain prompt that runs `git diff -- <paths>` (recipe below) | Run *alongside* the `reviewer` agent; reconcile both sets of findings. Different model → catches different classes. |
| **Mechanical offload** (bulk boilerplate, rote edits with a fully-specified diff) | `--sandbox workspace-write` in an isolated `git worktree` | Frees the Claude subagent budget. Prefer a worktree so it can't clobber the shared tree's concurrent WIP. |
| **Mechanical UI check ONLY** (is the element present? did it regress? — NOT "does it look good") | `--image shot.png -- "confirm the X button and Y table are present …"` | Claude owns all UI taste/design (see the hard rule above). Use this only for element-presence/regression facts, never the aesthetic verdict. |
| **Ideas and fact-clearing** in a grill or discussion ("ask Astra") | the Astra pass in `.claude/skills/grilling/ASTRA.md` | Astra clears fact questions and proposes options; owner questions and taste stay where they are. |
| **Computer-use** (read/drive live Mac apps: click, type, read a window) | `--computer-use -- "…"` | Sets the authorized bypass to clear the MCP elicitation gate. Scope the prompt tightly (bypass drops the sandbox). |

For anything needing **structured, harness-tracked, context-sharing** results,
prefer a Claude subagent or a `Workflow` — Codex here returns prose (or a JSON
blob if you pass `--schema`) over a shell boundary, not a native schema object.

## Recipes

Set `SCRATCH` to your session's scratchpad directory before running these (`SCRATCH=<scratchpad path>`); unset, the paths resolve to `/` and fail. Screenshots come from `.playwright-mcp/`.

Second opinion on a diff (read-only sandbox; it never edits). Name the paths:
the working tree always carries other sessions' WIP, and `--review-uncommitted`
/ `--review-base` reject a prompt anyway (the current `codex exec review` errors
on `--uncommitted` + a positional prompt).

```bash
scripts/codex-headless.sh -- \
  "Run \`git diff -- packages/core/src/use-cases/orders/refund.ts packages/core/src/use-cases/orders/__tests__/refund.test.ts\` and review ONLY that diff; ignore the rest of the tree. Focus on money math, RBAC gaps, and idempotency. Flag anything a reviewer should block on."
```

For committed work, swap in `git show <sha> -- <paths>` or `git diff <base>..<sha> -- <paths>`.

UI verification from a screenshot, with a structured verdict:

```bash
cat > $SCRATCH/ui-verdict.schema.json <<'JSON'
{ "type":"object","required":["matches","issues"],
  "properties":{ "matches":{"type":"boolean"},
    "issues":{"type":"array","items":{"type":"string"}} } }
JSON
scripts/codex-headless.sh --image .playwright-mcp/roles-page.png --schema $SCRATCH/ui-verdict.schema.json -- \
  "This is the /platform/roles page. Verify against: table with role badges, per-row grant dropdown, ADMIN-only revoke. List any mismatches."
```

Mechanical offload in an isolated worktree (so it can edit safely):

```bash
git worktree add $SCRATCH/codex-wt HEAD
scripts/codex-headless.sh --cd $SCRATCH/codex-wt --sandbox workspace-write --cap-seconds 600 -- \
  "Add a JSDoc block to every exported function in packages/foo/src that lacks one. No behavior changes."
# then review $SCRATCH/codex-wt's diff, cherry-pick what's good, and: git worktree remove $SCRATCH/codex-wt
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

- `--cap-seconds N` (default 600) — hard ceiling, a total across model fallback
  attempts; this is the "10-minute check."
- `--stall-seconds N` (default 180) — trips the watchdog if no output for N seconds
  (diagnose, leave alive unless `--kill-on-cap`).
- `--sandbox read-only|workspace-write|danger-full-access` (default read-only).
- `--cd DIR`, `--model NAME`, `--image FILE` (repeatable), `--schema FILE`.

## Honest caveats — do not oversell

- **Model:** newest listed in `~/.codex/models_cache.json` unless `--model`
  overrides; the wrapper prints which one it chose. Reasoning effort via
  `-c model_reasoning_effort=…` (each model's supported levels are in the same
  file).
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
