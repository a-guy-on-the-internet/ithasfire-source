# Decision Record Format

Decision records live in `docs/decisions/` and use slug names: `place-layout-rename.md`, `prisma-multi-file-schema.md`. No sequential numbers. Every new record also gets a row in the table in `docs/decisions/README.md`.

## Template

```md
# Decision Record: {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. A record can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most records won't need them.

- **Status** (`proposed | accepted | deprecated | superseded by {slug}`) — useful when decisions are revisited
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out
- **Terminology Mapping table** — for renames (see `place-layout-rename.md` for the house style)

## When to offer a decision record

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "Payouts are computed from PayeeLedgerEntry; the Settlement tables are frozen."
- **Integration patterns.** "Web and jobs communicate via the object-deletion outbox, not direct deletes."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, tax provider. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Fees are code, reconciled on deploy — never a DB-writable setting." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "Memberships must never be framed as donations (AB 488)." "We are merchant of record, so disputes are structurally ours."
- **Rejected alternatives when the rejection is non-obvious.** If you considered Stripe Tax and picked ZipTax for specific reasons, record it — otherwise someone will suggest Stripe Tax again in six months.
