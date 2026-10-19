# Rollback (Cloud Run)

Services `hf-prod-{api,web,jobs,tileserver,audio-transcoder}`, region
`us-east4`, project `hearthfire-491918`. A prod rollback is the owner's call.

**The procedure is in [`docs/deploy.md#hotfix-and-rollback`](../deploy.md#hotfix-and-rollback):**
pin traffic, move the `:prod` tag to the last good digest, deploy that tag,
unpin. That section also lists what undoes a pin on its own (any apply, any
deploy, the monthly Apple secret rotation), which is why a pin alone is not a
rollback. This page covers what it doesn't: whether to roll back, finding the
good revision, per-service differences, checking the result, and the database.

Nothing rolls back by itself after a `deploy-prod` or `redeploy-prod`: their
`post_deploy_verify` job can warn or fail, but never reverts. Only `hotfix.yml`'s roll
(`scripts/ci/roll-cloud-run.sh`) reverts on its own, and only when its own
probe fails.

## When to roll back vs fix forward

- **Roll back** when the API is hard-down or erroring on core flows
  (checkout, ticket issuance, webhooks) and the cause shipped in the last
  deploy. Restore service first, debug after.
- **Fix forward** when the regression is minor, or when the deploy included
  a **DB migration the old code can't run against** (see
  [the database does not roll back](#the-database-does-not-roll-back)).

## Find the last good revision

```bash
gcloud run revisions list \
  --service hf-prod-api --region us-east4 --project hearthfire-491918 \
  --format='table(name, metadata.creationTimestamp, status.conditions[0].status)'
```

Revisions are newest-first. The one serving now:

```bash
gcloud run services describe hf-prod-api \
  --region us-east4 --project hearthfire-491918 \
  --format='value(status.traffic)'
```

To tie a revision to a commit, use the digest-to-tag lookup in step 1 of the
audio rotation in [`docs/deploy.md#rotate-a-secret`](../deploy.md#rotate-a-secret);
it works for any image.

Skip traffic splits such as `GOOD=90,BAD=10`. A split is a pin, and gets
undone the same way.

## Per service

- **api, jobs, tileserver:** `:prod` is a retag of `:dev` (`deploy-prod.yml`
  promote steps). After a rollback, the next `deploy-prod` retags `:dev` again,
  so if dev still runs the broken build, it ships the bug again. Fix dev, or
  confirm what `:dev` points at, before dispatching it. `redeploy-prod` rolls
  whatever `:prod` points at, so after the retag it keeps the rollback.
- **web:** built per dispatch from the ref (`build_web`), tagged `:prod` and
  `prod-<sha7>`. `NEXT_PUBLIC_*` values are inlined at build time, so a web
  rollback also reverts those.
- **audio-transcoder:** Terraform ignores its image, and neither prod deploy
  rolls it. But `deploy-prod` still retags `audio-transcoder:dev` →
  `:prod` (its promote step), so after a bad promote the next audio revision
  (any apply that changes its service config) pulls the bad image.
  Point `:prod` back at the good digest as for the other services. Its retag
  and redeploy are in
  [`docs/deploy.md#rotate-a-secret`](../deploy.md#rotate-a-secret).

## Check the result

```bash
curl -s https://api.ithasfire.com/health        # expect {"ok":true}
```

`/health` returns 503 with `"error":"migration_drift"` when the image needs
migrations the database lacks (`apps/api/src/routes/health.ts`).

- Watch Sentry for the error rate dropping.
- Confirm Stripe webhook deliveries succeed (Stripe Dashboard → Webhooks →
  recent deliveries). Webhook traffic hits the same API service.
- Check the Discord alerts channel for recovery.

## The database does not roll back

Deploys migrate before they roll (`migrate_db` runs before `terraform_apply`
and `deploy_prod`), and rolling the image back leaves the schema where the bad
deploy put it. Prisma has no down migrations.

- The drift guard won't stop an older image. It blocks only when the image
  has migrations the database is missing (`packages/adapters/src/infra/migration-drift.ts`);
  a database that is ahead passes, so the old revision boots and serves.
- **Additive migrations** (new tables, nullable or defaulted columns): the old
  revision is safe.
- **Destructive or renaming migrations:** the old code fails at query time
  (Prisma `P2022`, column does not exist). Prefer fixing forward.
- **Bad data, not bad code:** Neon PITR covers the last 6 hours (`history_retention_seconds`
  default in `infra/terraform/modules/neon/variables.tf`). Older than that,
  restore a nightly dump into a Neon branch per
  [`db-backup-restore.md`](db-backup-restore.md). Neither path is automated,
  and swapping prod onto a restored branch is the owner's call.
