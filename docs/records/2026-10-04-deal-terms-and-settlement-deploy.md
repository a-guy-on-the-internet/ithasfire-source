# Deploying deal terms and the settlement sheet (P4b)

Migration: `packages/db/prisma/migrations/20261003150000_deal_terms_and_settlement_sheet/migration.sql`.
Spec: `docs/specs/2026-09-29/deal-terms-and-settlement.spec.yaml` (stage 1).

## Before the deploy

Run `docs/records/2026-10-04-deal-terms-and-settlement-predeploy.sql` against the target database. It is read-only. If any
`PayoutTermsLine.percent` is outside 0–100, it stops with:

```
PayoutTermsLine.percent out of range on N rows; fix before deploying
```

The migration's clause-shape CHECK would otherwise fail the deploy partway with a bare constraint violation.

The guard lives here, not in the migration, because the migration is already applied on the local dev database
(`prisma migrate resolve --applied`), and editing an applied migration changes its recorded checksum.

## The deploy window: old revisions on the new schema

The migration is additive except one relaxation (`percent` becomes nullable). Every existing row keeps its percent
and takes `amountType = PERCENT`, `basis = GROSS`, so old revisions read existing rows exactly as before.

The risk starts only when a NEW revision WRITES a deal while an OLD revision is still serving traffic. Old revisions
have no per-order fence. They read every line of a terms row and:

- **Pay per order what they shouldn't.** A NET_POOL percentage clause would be paid per order by the old
  `computeOrderSplits`.
- **Fail on a FIXED clause.** Its `percent` is NULL, which fails the old split schema, so checkout or finalize on
  those terms errors.
- **Delete the deal.** An old legacy line editor's `replaceLines` deletes every line, settled-directly clauses
  included.

Nothing writes a deal until a client calls `deals.setAgreementDeal`, and no UI does yet. Keep it that way until
every pre-P4b revision is drained: the editor ships after this backend. If the editor and the backend ever ship
together, hold the editor behind a flag until the old revisions are gone.
