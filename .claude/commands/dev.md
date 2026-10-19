---
description: "Build features end-to-end with automatic code review. Default development loop: code → review → fix → approve. Use for any implementation task where you want built-in quality gates."
argument-hint: "Describe the feature or fix — e.g. 'add the refund use case with payout reversal' or 'fix the double-scan bug'"
---

Run the **Dev Loop** in `CLAUDE.md` ("Dev Orchestrator" through "Final Report") on this task: **$ARGUMENTS**

That section is the single source for routing, model selection, review rounds, the live run and the final report format. Plan steps go in a `memory/session_<task>.plan.md` file (the `implementation-plan` skill) when the task has more than one step.
