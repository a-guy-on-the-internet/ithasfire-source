# Region Move Runbook — GCP compute `us-central1` → `us-east4`

**Status:** Terraform + CI edits staged (NOT applied). This runbook covers the
cutover.

## Why

The Neon Postgres database lives in **AWS `us-east-1` (N. Virginia)**. All GCP
compute currently runs in **`us-central1` (Iowa)**, so every DB query is both
cross-cloud and cross-region (~25–40 ms RTT). Moving compute to **GCP
`us-east4` (N. Virginia)** puts it in the same metro as the DB (~1–2 ms).

**The database is NOT moving.** Neon stays in `aws-us-east-1`. Cloudflare R2
object storage is region-agnostic and out of scope.

## What the code change does

The single lever is `var.region` in both `envs/dev/dev.tfvars` and
`envs/prod/prod.tfvars` (`us-central1` → `us-east4`). Because every regional
resource resolves to `var.region` — directly or through per-service `coalesce`
locals whose override vars are all unset (`null`) — this one flip carries:

- Cloud Run services: api, web, jobs, audio-transcoder, tileserver
- Artifact Registry repo `services` (co-located with compute in `us-east4`)
- Cloud Run domain mappings (api / web / www / tileserver)
- Cloud Scheduler jobs (27 generated + 2 db-backup) and their Pub/Sub topics/subs
- Tileserver GCS bucket + db-backup GCS bucket + db-backup KMS keyring + db-backup Cloud Run Job/Scheduler

Also updated: the hardcoded Artifact Registry image-host strings in both tfvars
(`us-central1-docker.pkg.dev` → `us-east4-docker.pkg.dev`).

**No stranded region references.** Every `location`/`region` in the Terraform
traces back to `var.region` except `oauth.tf` (`location = "global"`, a GCP
OAuth brand — region-agnostic) and Secret Manager (auto multi-region
replication — unaffected). The only remaining `us-central1` strings are two
stale code comments (`main.tf:370`, `modules/neon/variables.tf:25`) with no
functional effect.

### Things that self-heal (no manual step)

- **Internal service URLs.** `WEB_API_BASE_URL` (web SSR → api), `JOBS_SERVICE_URL`,
  `AUDIO_TRANSCODER_URL`, `TILESERVER_URL`, Pub/Sub push endpoints, and OIDC
  audiences are all Terraform references to module `service_url` outputs. Each
  Cloud Run service gets a new `*.run.app` URL in `us-east4`; consumers pick it
  up automatically on apply.
- **Cloudflare DNS.** All hosts CNAME to `ghs.googlehosted.com` (region-agnostic)
  and prod origin-Host rewrite is off, so no DNS record edits are needed.

## CI is Forgejo, not GitHub

The real CI is **Forgejo at `git.unme.me`**. The `.github/workflows/` files are
a **mirror only** — do NOT set variables or secrets via GitHub. All deploy
workflows already read the region from Forgejo **repo variables**
`GCP_REGION` and `GCP_ARTIFACT_REGISTRY_REGION` (no workflow hardcodes
`us-central1`), so no workflow file edits are required — only the Forgejo repo
variables must change (see below).

`tiles-upload.yml`'s `region` input is a **geographic tile-data selector**
(`planet`/`north-america`/`us`/`europe`), not a GCP region — leave it alone.
Its GCS target is passed as an explicit bucket name.

---

## Pre-work (before any apply)

1. **Search Console domain-ownership sanity check (likely already satisfied — NOT a blocker).**
   Cloud Run domain-mapping creation requires that `ithasfire.com` be verified as
   owned, in Google Search Console, by the identity running the apply (`terraform@…`).
   This is **per-domain and per-identity, NOT region-scoped** — a region change does
   not affect it. The existing `ithasfire.com` mappings in us-central1 are already
   Terraform-managed (created by `terraform@` via CI), which proves `terraform@` is
   **already a verified owner** — so the us-east4 recreate reuses that verification
   and needs nothing new. Treat this as a confirm-before-you-start check, not a task.
   (Verified 2026-07-08: `micah@hearthfire.community` owns `ithasfire.com` in Search
   Console; the TF-managed mappings imply `terraform@` ownership. Local TF runs as a
   limited SA and is state-ops-only; the real apply runs via Forgejo CI as `terraform@`.)

2. **Retire the unmanaged `hearthfire.community` domain mappings.**
   There are ~7 **manual** (non-Terraform) Cloud Run domain mappings for the dead
   old brand `hearthfire.community` (`api.`, apex, `tiles-prod.`, plus dev variants)
   pinned to us-central1. They are NOT in `domain-mappings.tf` (`var.domain =
   "ithasfire.com"` only), so the region flip will NOT carry them — they would dangle
   against services that no longer exist in us-central1 and the old-brand hosts would
   go dark silently. Decision: **retire them.** Delete before/at cutover (they are not
   recreated in us-east4). They are unmanaged, so delete via gcloud, not Terraform:
   `gcloud beta run domain-mappings list --region=us-central1` then
   `gcloud beta run domain-mappings delete <host> --region=us-central1` for each
   `*.hearthfire.community` entry. (This takes the old-brand hosts offline — intended.)

3. **Decide ordering: dev first.** Run the full sequence on **dev**, verify end
   to end, then do **prod in a maintenance window**. Do not do them together.

4. **Snapshot current prod overrides (cost kill-switch).** Record which of the
   22 prod schedulers are currently PAUSED and which `allUsers` invoker bindings
   were manually removed. A prod apply **recreates schedulers ENABLED** and can
   re-add invokers — you must re-assert these after apply (see prod step 7).

5. **Confirm `db_backup_lock_retention = false`** in `prod.tfvars` (it is) and
   keep it false through the move — bucket lock is irreversible and you are
   recreating the bucket.

---

## Sequence — DEV first

> The apply itself runs via **Forgejo CI dispatch** (`terraform apply` as
> `terraform@`). Local Terraform is for `state`/plan inspection only.

1. **Flip Forgejo dev repo variables** to `us-east4`:
   - `GCP_REGION = us-east4`
   - `GCP_ARTIFACT_REGISTRY_REGION = us-east4`

2. **Re-push images to the new-region Artifact Registry repo.** The `services`
   repo in `us-east4` starts empty. Run the dev image-build/push workflows
   (`deploy-dev.yml` build stages, and `pg-dump-image.yml` for the backup image)
   so `us-east4-docker.pkg.dev/hearthfire-491918/services/*` has the tags the
   tfvars now point at. Terraform Cloud Run services won't deploy until their
   image tag exists in the new repo.

3. **Apply Terraform for dev** (Forgejo dispatch). This:
   - creates the new-region Cloud Run services (new `*.run.app` URLs),
   - **destroys + recreates the regional domain mappings** — brief per-host 404
     window until the new mapping provisions its cert,
   - **recreates the tileserver + db-backup buckets** in `us-east4` (dev buckets
     are `force_destroy=true`, so this is clean),
   - recreates schedulers + Pub/Sub subscriptions.

4. **Re-upload PMTiles for the dev tileserver.** The `tileserver_data` bucket
   was recreated empty. Run `tiles-upload.yml` (dispatch) targeting the dev
   bucket name to restore `openmaptiles.pmtiles`.

5. **Verify dev** (see Post-cutover verification). Only proceed to prod once dev
   is green.

---

## Sequence — PROD (maintenance window)

1. **Announce a maintenance window.** Expect a brief per-host 404 window during
   domain-mapping recreate.

2. **Flip Forgejo prod repo variables** to `us-east4`:
   - `GCP_REGION = us-east4`
   - `GCP_ARTIFACT_REGISTRY_REGION = us-east4`

3. **Re-push prod images to the new-region AR repo** (prod build stages +
   `pg-dump-image.yml`) so all `:prod` and `pg-dump:v1` tags exist under
   `us-east4-docker.pkg.dev`.

4. **db-backup bucket recreate (HARD, manual).** The prod `hf-prod-db-backups`
   bucket is NOT `force_destroy` and holds real backups. Before apply:
   - Optionally **copy backup history** to the new-region bucket:
     `gcloud storage cp -r gs://hf-prod-db-backups/** gs://hf-prod-db-backups-tmp/`
     then move into the recreated bucket after apply (or keep the old bucket
     read-only for retention and start fresh in `us-east4`).
   - The regional **KMS keyring cannot be deleted** — the old `us-central1`
     keyring lingers (cosmetic, no cost impact); the new keyring is created in
     `us-east4`.

5. **Apply Terraform for prod** (Forgejo dispatch). Same destroy/recreate
   profile as dev (domain mappings, buckets, schedulers, Pub/Sub). Note prod
   tileserver + db-backup buckets are not force-destroy, so if Terraform can't
   destroy a non-empty bucket you may need to empty/rename it first.

6. **Re-upload PMTiles for prod** via `tiles-upload.yml` (the recreated
   `hf-prod-tileserver-data` bucket is empty; the tileserver serves 404/blank
   tiles until this completes).

7. **Re-assert the cost kill-switch overrides.** A prod apply recreated all
   schedulers **ENABLED** and may have re-added invoker bindings. Using the
   snapshot from Pre-work step 4:
   - re-PAUSE the 22 schedulers that were paused, and
   - re-remove any `allUsers`/public invoker bindings that were manually
     stripped to take prod dark.
   (These are the manual overrides a prod apply reverts — see the "Prod cost
   kill switch" note.)

8. **db-backup restore drill.** Before trusting the new-region backup pipeline,
   run one manual backup job and a restore drill per
   `docs/runbooks/db-backup-restore.md`. Keep `db_backup_lock_retention =
   false` until the drill passes.

---

## Post-cutover verification (dev, then prod)

1. **Cloud Run health.** `gcloud run services list --region=us-east4` shows all
   services in the new region; hit `https://api.ithasfire.com/health` (and the
   dev equivalent) → 200.

2. **DB latency win.** Confirm API request latency to DB-backed endpoints
   dropped (spot-check Cloud Run logs / a timed query) — this is the whole point
   of the move.

3. **Domain mappings resolved.** `api.ithasfire.com`, apex, `www` (prod),
   `tiles-*.ithasfire.com` all serve 200 with valid certs (mappings can take a
   few minutes to issue certs after recreate).

4. **Tileserver.** Map tiles load in the web app (PMTiles re-upload landed).

5. **Schedulers + Pub/Sub.** Scheduler jobs exist in `us-east4` and Pub/Sub
   push subscriptions point at the new `*.run.app` endpoints (self-healed).
   Confirm paused-state re-asserted in prod.

6. **Authenticated SSR smoke test BEFORE flipping `ENFORCE_ORIGIN_SECRET`.**
   `enforce_origin_secret` is currently `false` (default) in both envs.
   `WEB_API_BASE_URL` now points web SSR at the API's **new `us-east4`
   `*.run.app` origin**. Before you ever flip `enforce_origin_secret = true`,
   load an **authenticated SSR page** (e.g. an admin or account page that does
   server-side tRPC) and confirm it renders logged-in data. This validates the
   Better Auth "Fix-A" token mint against the new `*.run.app` host — a host
   mismatch here would surface as failed SSR auth, and flipping origin-secret
   enforcement on top of a broken origin can 403 all traffic. Only after this
   smoke test is green, and after `origin_secret_mismatch` warnings are quiet in
   prod logs, should `enforce_origin_secret` be flipped.

7. **Artifact Registry.** Old `us-central1` `services` repo can be left in place
   or deleted once the new repo is confirmed serving all deploys. Deleting it
   reclaims storage but is optional.

---

## Rollback

Revert `var.region` (and the image-host strings) back to `us-central1` in both
tfvars, flip the Forgejo `GCP_REGION`/`GCP_ARTIFACT_REGISTRY_REGION` vars back,
ensure the `us-central1` AR repo still has the image tags (it does unless
deleted), and re-apply. Domain mappings + buckets recreate again (same brief
404 window + PMTiles re-upload). Because the old `us-central1` KMS keyring and
(if not deleted) buckets/AR repo persist, rollback is a re-apply, not a rebuild.

## State reconciliation (hard-won during the prod cutover)

The prod move surfaced two state-shape hazards. Both are fixed; this documents
the model so the next region move / out-of-band resource doesn't repeat them.

- **Shared Artifact Registry repo — single owner.** The `services` repo is ONE
  physical resource used by every env (images differ by tag). It is now owned by
  exactly one workspace: `manage_shared_artifact_registry = true` in
  `prod.tfvars`; every other env inherits `false` and READS it via a
  `data "google_artifact_registry_repository"`. The resource carries
  `prevent_destroy = true` so any accidental destroy/replace (a future region
  move, or a botched ownership change) fails as a LOUD plan error instead of
  deleting the registry. **To move regions:** in the OWNER workspace,
  `terraform state rm google_artifact_registry_repository.services[0]` then
  re-`import` it at the new-region id (the region flip forces a replace that
  `prevent_destroy` will otherwise block). Non-owner workspaces self-heal via the
  data source.

- **Out-of-band resources → import into the WORKSPACE state.** Resources created
  live via a cloud API (e.g. the neon-compute-quota log metric + alert policy,
  armed during the Jun outage before being codified; or a manually-created GSM
  secret) exist in GCP but not in Terraform state, so the next apply tries to
  CREATE them → 409. Fix: `terraform -chdir=infra/terraform` (workspace selected)
  `import <bare.address> <id>` — e.g.
  `import google_logging_metric.neon_compute_quota hf-prod-neon-compute-quota`.
  NOTE: import must target the **bare** address in the `infra/terraform` root
  (what CI uses), NOT `module.infra.*`. A prior `envs/prod/imports.tf` used
  `module.infra.*` addresses in a directory CI never loads — it was dead and has
  been deleted. Import blocks can't cleanly guard a single non-`for_each`
  resource per-workspace (and alert-policy ids are server-assigned numerics), so
  reconcile out-of-band resources with an explicit `terraform import` when
  codifying them, per this convention.

## Notes / references

- Apply identity: `terraform@` via Forgejo CI dispatch. Local TF is
  state-ops-only (limited SA).
- Cost kill-switch details: prod was taken dark by removing `allUsers` invoker
  on web+api and pausing 22 schedulers — a prod apply reverts both.
- db-backup restore procedure: `docs/runbooks/db-backup-restore.md`.
