# DB Backup & Restore Runbook

**Spec:** `docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md`
**Terraform:** `infra/terraform/db-backup.tf` + `infra/terraform/modules/db-backup/`
**Image:** `infra/docker/pg-dump/` (built via `.github/workflows/pg-dump-image.yml`)

A backup you haven't restored isn't a backup. This runbook covers verifying
nightly dumps, manual restore, the **mandatory quarterly restore drill**, and
bringing the pipeline up in an env that lacks it.

Every resource below is in `us-east4`, project `hearthfire-491918`. Backups are
prod-only: `enable_db_backups = true` and `db_backup_image` pinned to
`.../services/pg-dump:v1` in `envs/prod/prod.tfvars`; dev has neither.
`db_backup_lock_retention` is still `false` because no drill has passed yet.

## What exists

| Resource | Name (prod) | Notes |
| --- | --- | --- |
| GCS bucket | `hf-prod-db-backups` | CMEK-encrypted, 7-day retention policy (immutability), per-prefix lifecycle, never `force_destroy` |
| CMEK key | `hf-prod-backups/db-backups` | 90-day rotation; `prevent_destroy`. The 2026-07 region move left an undeletable key ring of the same name in `us-central1`; the live one is in `us-east4`. |
| Cloud Run Job | `hf-prod-pg-dump` | nightly logical dump, `MODE=dump` |
| Cloud Run Job | `hf-prod-pg-dump-promote` | monthly/yearly tier promotion, `MODE=promote` |
| Scheduler | `hf-prod-pg-dump-daily` | `0 3 * * *` UTC (10pm CDT) |
| Scheduler | `hf-prod-pg-dump-promote-monthly` | `30 4 1 * *` UTC |
| Runtime SA | `hf-prod-pg-dump@hearthfire-491918.iam.gserviceaccount.com` | objectCreator+objectViewer on bucket, secretAccessor on the direct DB URL and the Discord alert webhook, pubsub publisher |
| Scheduler SA | `hf-prod-pg-dump-sch@hearthfire-491918.iam.gserviceaccount.com` | `run.invoker` on both jobs |
| Pub/Sub topic | `prod-backup-events` | JSON manifest per run (sha256, size, duration) |

Object layout and retention:

```
daily/YYYY/MM/DD.dump.zst    kept 30 days  (Standard)
monthly/YYYY-MM.dump.zst     kept 12 months (Nearline after 30d)
yearly/YYYY.dump.zst         kept 7 years  (Nearline 30d → Coldline 90d → Archive 365d)
```

Dumps are `pg_dump --format=custom --no-owner --no-acl`, zstd-19 compressed,
taken against the **direct** Neon endpoint (`hf-prod-direct-database-url`
secret — never the pooler). Neon PITR is the fast-RTO mechanism for "undo the
last few minutes", but only inside Neon's history window: 6 hours
(`history_retention_seconds` default in `infra/terraform/modules/neon/variables.tf`;
the module call in `stack/main.tf` doesn't override it). This pipeline is for
anything older, off-platform disaster recovery and long-term retention.

## Verifying backups are healthy

- Cloud Run job history: `gcloud run jobs executions list --job hf-prod-pg-dump --region us-east4 --project hearthfire-491918`
- A failure inside the job posts to the ops Discord channel and shows as a
  failed execution. The webhook is `hf-prod-discord-alerts-webhook` (GitHub
  secret `DISCORD_ALERTS_WEBHOOK_PROD`); with that secret unset the job gets no
  webhook, and a failure shows only as a failed execution, with no Discord
  alert.
- Only the job script alerts. A scheduler that never fires, or a job that never
  starts, sends nothing, and no Cloud Monitoring alert covers it: the spec §7
  "no successful backup in 26h" and size-delta alerts are not in
  `infra/terraform/monitoring.tf`. Check the execution list by hand.
- Manifest events land on `prod-backup-events`. A new subscription receives
  only messages published after it was created, so a fresh peek subscription
  stays empty until the next run; for past runs, use the execution list and
  the bucket listing. To watch future runs:
  ```bash
  gcloud pubsub subscriptions create tmp-backup-peek --topic prod-backup-events --project hearthfire-491918  # once
  gcloud pubsub subscriptions pull tmp-backup-peek --auto-ack --limit 7 --project hearthfire-491918
  ```

## Manual restore (to a Neon branch — NEVER main)

Restore-to-prod is **not** automated by design. Always restore into a branch,
validate, and only then consider swapping connection strings (manual SRE
procedure with a second approver).

1. Pick the dump:
   ```bash
   gcloud storage ls "gs://hf-prod-db-backups/daily/2026/06/"
   gcloud storage cp "gs://hf-prod-db-backups/daily/2026/06/10.dump.zst" /tmp/
   zstd -d /tmp/10.dump.zst
   ```
2. Create a fresh Neon branch off prod's current tip (Neon console or
   `neon branches create --project-id <id> --name restore-drill-YYYY-MM-DD`),
   and grab the branch's **direct** connection string (`$TARGET_URL`).
   Sanity check before proceeding: the URL must NOT point at the default
   branch / pooler host.
3. Restore (the dump is portable: `--no-owner --no-acl` at dump time):
   ```bash
   pg_restore --clean --if-exists --no-owner --no-acl \
     --dbname="$TARGET_URL" /tmp/10.dump
   ```
   Postgres major must match: Neon prod is **Postgres 16** — use pg_restore 16+
   (the `infra/docker/pg-dump` image has the right client if you don't have it
   locally).
4. Validate (see drill checklist below).
5. Destroy the branch when done.

## Quarterly restore drill (mandatory — calendar invite)

Target RTO: **< 30 min** for a full restore at current DB size.

1. Pick a **random** daily backup from the last 30 days (don't always pick
   yesterday's).
2. Start a timer. Restore into a fresh Neon branch per the procedure above.
3. Verify:
   - Row counts on key tables (`User`, `Order`, `Ticket`, `Payout`/settlement
     tables) are plausible vs the production dashboard for that date.
   - The API boots against the branch: point a local `apps/api` at
     `DATABASE_URL=$TARGET_URL` and hit `/health`.
   - Key invariants hold (orders reference existing users; settlement totals
     are non-negative).
4. Stop the timer. Record below: date, dump used, observed RTO, dump size,
   any surprises.
5. Destroy the Neon branch.
6. If the drill fails or RTO exceeds 30 min, open a P1 issue — a broken
   restore path means we have no backups.

### Drill log

| Date | Dump restored | RTO observed | Size | Operator | Notes |
| --- | --- | --- | --- | --- | --- |
| _(first drill pending)_ | | | | | |

## Failure modes & gotchas

- **Dump job OOM:** `/tmp` is tmpfs — only the compressed dump (~2 GB today)
  is staged. If the compressed dump outgrows ~half the job's memory limit
  (the module default of `4Gi`; `db-backup.tf` passes no override), set
  `memory` on the module call. The job also times out at 30 minutes with one
  retry (`timeout_seconds`, `max_retries`).
- **Postgres major upgrade on Neon:** rebuild the image
  (`infra/docker/pg-dump/Dockerfile` pins `postgres:16-bookworm`) and push a
  new tag BEFORE upgrading the server — pg_dump client major must be ≥ server
  major.
- **Promotion source missing:** the promote job fails loudly if the
  1st-of-month daily dump doesn't exist (i.e. the nightly failed). Re-run the
  dump job manually, then re-run promote — both are idempotent (each skips an
  object that already exists). Do both before 00:00 UTC: each job names its
  object from the run's own UTC date, so a promote run on the 2nd promotes the
  2nd's dump as that month's backup, and a dump run on the 2nd never fills the
  1st.
- **Object deletion blocked:** expected — the bucket retention policy makes
  objects immutable for 7 days. Lifecycle rules handle all deletion.
- **Secret rotation:** the job reads `hf-prod-direct-database-url:latest` at
  execution time; rotating the Neon password via Terraform requires no job
  changes.

## Bring-up in a new env

Prod's tfvars carry steps 1–3; steps 5 and 6 wait on the first drill. Every
apply below goes through the workflows and, for prod, is the owner's call.

1. `enable_db_backups = true` in the env's tfvars provisions the storage layer
   (bucket, CMEK, SA, topic) on the next apply. It requires `enable_neon = true`
   (`check "db_backups_require_neon"` in `db-backup.tf`).
2. Build and push the job image with `pg-dump-image.yml` (dispatch, `tag`
   input, for example `v1`). It pushes `services/pg-dump:<tag>` and
   `:<git-sha>`.
3. Set `db_backup_image` to that tag (never `:latest`) and apply. This creates
   the two Cloud Run Jobs and their Scheduler triggers.
4. Smoke test — trigger the dump manually in **that env**. Every name carries
   the env (`name_prefix = "hf-<env>"` in `db-backup.tf`), so substitute it;
   running the prod job by hand is the owner's call.
   ```bash
   ENV=dev   # the env you are bringing up
   gcloud run jobs execute "hf-${ENV}-pg-dump" --region us-east4 --project hearthfire-491918 --wait
   gcloud storage ls -l "gs://hf-${ENV}-db-backups/daily/$(date -u +%Y/%m)/"
   ```
   The listing must show an object written by this execution (check its time),
   not an older dump.
5. Run a restore drill (above) against the fresh dump.
6. Only after a successful drill: set `db_backup_lock_retention = true` and
   apply. **This is irreversible** (GCS Bucket Lock) — the 7-day immutability
   window can never be reduced afterwards.

## Decommissioning (read before touching `enable_db_backups`)

Do **not** flip `enable_db_backups = false` in prod: the plan will try to destroy
the CMEK crypto key, `prevent_destroy` turns that into a hard plan error, and the
workspace becomes un-applyable until the lifecycle block is hand-edited. This is
deliberate — a backup system should resist casual teardown.

Actual teardown requires, in order: remove the `prevent_destroy` lifecycle block,
schedule key destruction (30-day GCP window), and accept that the
`hf-{env}-backups` **key ring name is permanently reserved** (GCP key rings are
undeletable — recreate attempts collide). After `db_backup_lock_retention = true`
(Bucket Lock), teardown is **impossible** while any object remains under
retention; that flag is irreversible by design.
