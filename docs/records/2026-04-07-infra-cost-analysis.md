# Ithas Fire Infrastructure Cost Analysis

> Generated: April 2026  
> Stack: GCP (Cloud Run, GCS, Pub/Sub, Scheduler, Secret Manager, Artifact Registry) + Neon (Postgres) + Upstash (Redis) + Cloudflare (DNS, R2) + AWS (SES, SNS) + Stripe  
> Region: `us-central1` (GCP), `aws-us-east-1` (Neon), `global/us-east-1` (Upstash), `us-east-1` (AWS)

---

## Table of Contents

1. [Stack Inventory](#1-stack-inventory)
2. [Per-Service Cost Breakdown](#2-per-service-cost-breakdown)
3. [Dev Environment Estimate](#3-dev-environment-estimate)
4. [Prod Environment Estimate](#4-prod-environment-estimate)
5. [Free Tiers & Credits Summary](#5-free-tiers--credits-summary)
6. [Feature-Driven Cost Drivers](#6-feature-driven-cost-drivers)
7. [Cost Monitoring Recommendations](#7-cost-monitoring-recommendations)
8. [Optimization Opportunities](#8-optimization-opportunities)

---

## 1. Stack Inventory

### Cloud Run Services (6 total in dev)

| Service | Image | CPU | Memory | Min Instances | Max Instances | Billing Model |
|---------|-------|-----|--------|---------------|---------------|---------------|
| **API** (Fastify) | `services/api:dev` | 1 vCPU | 512 Mi | 0 (dev) / 1 (prod) | 10 | Request-based |
| **Web** (Next.js) | `services/web:dev` | 1 vCPU | 512 Mi | 0 (dev) / 1 (prod) | 10 | Request-based |
| **Jobs** (Fastify) | `services/jobs:dev` | default | default | 0 | default | Request-based |
| **Meilisearch** | `getmeili/meilisearch:v1.11` | 1 vCPU | 1 Gi | 0 | 2 | Request-based |
| **Tileserver** | `services/tileserver:dev` | 1 vCPU | 512 Mi | 0 | 2 | Request-based |
| **Valhalla** | `services/valhalla:dev` | 1 vCPU | 2 Gi | 0 | 1 | Disabled in dev |

### Database Schema Complexity

- **102 Prisma models** across 13 schema files (auth, event, place, ticket, order, finance, org, notification, waiver, volunteer, application, resale, platform)
- PostGIS-enabled (geospatial queries for events/places)

### Background Jobs

**8 queue jobs** (Pub/Sub → push subscription → Cloud Run):
- `tickets.issue`, `tickets.hold`, `tickets.generate-qr`, `tickets.send-reminder`
- `emails.order-confirmation`
- `settlements.execute-transfer`
- `accounts.sync-stripe`
- `search.rebuild-event-index`

**3 scheduled tasks** (Cloud Scheduler → HTTP → Cloud Run):
- `tickets.release-expired-holds` — every 5 min
- `settlements.process-due-payouts` — daily midnight CST
- `sitemaps.generate` — daily 1:30am UTC

---

## 2. Per-Service Cost Breakdown

### A. Google Cloud Run

**Pricing (us-central1, request-based billing):**

| Metric | Active Rate | Idle Rate (min instance) |
|--------|-------------|------------------------|
| CPU | $0.000024/vCPU-sec | $0.0000025/vCPU-sec |
| Memory | $0.0000025/GiB-sec | $0.0000025/GiB-sec |
| Requests | $0.40/million | — |

**Free tier (per billing account/month):**
- 180,000 vCPU-seconds
- 360,000 GiB-seconds
- 2 million requests

**Idle min-instance cost formula (per service, per month):**
```
Monthly idle = (vCPU × $0.0000025 × 2,592,000 sec) + (GiB × $0.0000025 × 2,592,000 sec)
```

| Service Config | Idle $/mo |
|----------------|-----------|
| 1 vCPU + 512 Mi | $6.48 + $3.24 = **$9.72** |
| 1 vCPU + 1 Gi | $6.48 + $6.48 = **$12.96** |
| 1 vCPU + 2 Gi | $6.48 + $12.96 = **$19.44** |

### B. Neon (Serverless Postgres)

**Free plan (current):**
- 100 CU-hours/month per project (1 CU ≈ 1 vCPU + 4 GB RAM)
- 0.5 GB storage per project
- Scale to zero after 5 min idle
- 6-hour time travel

**Launch plan (usage-based, no monthly minimum):**
- $0.106/CU-hour
- $0.35/GB-month (data storage)
- $0.20/GB-month (history/WAL storage)
- Scale to zero, autoscaling up to 16 CU

**Realistic Ithas Fire estimate:**
- Dev: Free plan handles ~3 hrs/day at 1 CU = 90 CU-hrs (within 100 free). Storage <0.5 GB → **$0**
- Early prod (Launch): ~140 CU-hrs, 1 GB → $14.84 + $0.35 = **~$15/mo**
- Active prod (Launch): ~720 CU-hrs, 10 GB → $76.32 + $3.50 = **~$80/mo**

### C. Upstash (Serverless Redis)

**Free plan:**
- 256 MB data, 500K commands/month, 10K commands/day max

**Pay-as-you-go:**
- $0.20/100K commands
- $0.25/GB storage beyond free
- 100 GB max data, unlimited bandwidth

**Ithas Fire Redis usage (idempotency keys, hot-event cache, rate limiting, session):**
- Dev: Well within free tier → **$0**
- Early prod: ~2M commands/mo → (2M - 500K free) / 100K × $0.20 = **~$3/mo**
- Active prod: ~10M commands/mo → ~$19/mo, with <1 GB data = **~$20/mo**

### D. Cloudflare (DNS + R2 + CDN)

**DNS:** Free forever on all Cloudflare plans.

**R2 Storage:**
- 10 GB free, then $0.015/GB-month
- 1M Class A ops free, 10M Class B ops free
- **Zero egress fees** (major cost advantage)

**Ithas Fire R2 usage (exports, file uploads):**
- Early stage: <10 GB, minimal ops → **$0**
- Growth: 50 GB, moderate ops → ~$0.60/mo

**Edge caching:** Free plan — cache rules for tileserver CDN.

### E. AWS SES (Transactional Email)

**Pricing:**
- $0.10/1,000 outbound emails
- $0.12/GB attachments
- 3,000 messages free/month (first 12 months)

**Ithas Fire email types:** Order confirmations, event reminders, verification emails, password resets, announcements, org invitations.

| Traffic Level | Emails/mo | Cost |
|---------------|-----------|------|
| Dev | <100 | **$0** (free tier) |
| Early prod | ~2,000 | **$0** (within 3K free) |
| Growth | ~10,000 | **~$0.70** |
| Scale (50K) | ~50,000 | **~$5** |

### F. AWS SNS (SMS)

**Pricing:** ~$0.0075/SMS (US), varies by country. No free tier for SMS.

**Ithas Fire usage:** Event reminders, verification codes.
- Dev: 0 → **$0**
- Early prod: ~200 SMS/mo → **~$1.50**
- Growth: ~2,000 SMS/mo → **~$15**

### G. Google Cloud Pub/Sub

**Free tier:** First 10 GB of messages/month free.

**Pricing:** $0.04/GB after free tier.

**Ithas Fire usage:** 8 queue job topics, small JSON payloads (~1-5 KB each).
- Even at 100K messages/mo × 5 KB = 0.5 GB → **$0** (well within free tier)

### H. Google Cloud Scheduler

**Free tier:** First 3 jobs per billing account free.

**Pricing:** $0.10/job/month after the first 3.

**Ithas Fire: 4 scheduled jobs → 1 job beyond free tier = **$0.10/mo**

### I. Google Secret Manager

**Free tier:** 6 active secret versions free, 10K access operations/month free.

**Pricing:** $0.06/active secret version/month, $0.03/10K access operations.

**Ithas Fire: ~10 wallet secrets + runtime secrets:**
- ~15 active versions → (15-6) × $0.06 = **~$0.54/mo**

### J. Google Artifact Registry

**Free tier:** 0.5 GB storage free.

**Pricing:** $0.10/GB/month storage, network egress at standard rates.

**Ithas Fire: keep_last=10 across ~5 images (api, web, jobs, tileserver, audio-transcoder):**
- ~50 image tags × ~200 MB average = ~10 GB → **~$0.95/mo**
- With cleanup policy: likely ~5 GB → **~$0.45/mo**

### K. Google Cloud Storage (GCS)

**Free tier:** 5 GB Standard storage, 5K Class A ops, 50K Class B ops.

**Pricing (us-central1):** ~$0.020/GB-month Standard storage.

**Ithas Fire GCS buckets:**
- `hf-{env}-meilisearch-data`: Search index data, <1 GB → ~$0.02
- `hf-{env}-tileserver-data`: PMTiles, ~500 MB-2 GB → ~$0.04
- `hf-terraform` state: negligible

**Total: ~$0-$0.10/mo** (well within free tier for dev)

### L. Stripe

Not infrastructure-managed, but Stripe charges:
- 2.9% + $0.30 per successful card charge
- Connect: additional fees for payouts
- No idle/fixed cost — purely transactional

### M. Sentry

**Team plan:** $26/mo for 50K errors + 100K transactions (or free Developer plan for 1 user).
- This is a fixed SaaS cost, not usage-based infra.

### N. Geoapify

**Free tier:** 3,000 requests/day. Should cover dev and early prod.
- Growth: $49/mo for 30K requests/day if needed.

---

## 3. Dev Environment Estimate

With `min_instances = 0` across all services, dev scales to zero and only costs money when actively in use.

| Service | Monthly Cost |
|---------|-------------|
| Cloud Run (API + Web + Jobs + Meili + Tileserver) | $0 – $5 (sporadic use within free tier) |
| Neon (Free plan) | $0 |
| Upstash (Free plan) | $0 |
| Cloudflare (DNS + R2) | $0 |
| AWS SES | $0 |
| Pub/Sub | $0 |
| Cloud Scheduler (4 jobs) | $0.10 |
| Secret Manager | ~$0.54 |
| Artifact Registry | ~$0.45 |
| GCS | $0 (within free tier) |
| **Dev Total** | **~$1–$6/mo** |

> With your $300 Google credits, the dev environment is effectively free for years.

---

## 4. Prod Environment Estimate

### Early Prod (soft launch, <1K users, <100 events)

| Service | Monthly Cost |
|---------|-------------|
| Cloud Run API (min_instances=1, idle) | $9.72 |
| Cloud Run Web (min_instances=1, idle) | $9.72 |
| Cloud Run API/Web (active request time) | ~$5–10 |
| Cloud Run Jobs (scale-to-zero, burst) | ~$1–3 |
| Cloud Run Meilisearch (scale-to-zero) | ~$0–2 |
| Cloud Run Tileserver (scale-to-zero) | ~$0–1 |
| Neon Launch (intermittent, 1 GB) | ~$15 |
| Upstash Pay-as-you-go | ~$3 |
| Cloudflare (DNS + R2 <10 GB) | $0 |
| AWS SES (~2K emails) | $0 (free tier) |
| AWS SNS (~200 SMS) | ~$1.50 |
| Pub/Sub | $0 |
| Cloud Scheduler | $0.10 |
| Secret Manager | ~$0.54 |
| Artifact Registry | ~$0.45 |
| GCS | ~$0.10 |
| **Early Prod Total** | **~$46–56/mo** |

### Growth Prod (1K–10K users, 500+ events, regular ticket sales)

| Service | Monthly Cost |
|---------|-------------|
| Cloud Run API (min=1 + burst to 3-5) | ~$30 |
| Cloud Run Web (min=1 + burst to 2-3) | ~$20 |
| Cloud Run Jobs | ~$5–10 |
| Cloud Run Meilisearch (min=1 for search UX) | ~$13 |
| Cloud Run Tileserver | ~$2–5 |
| Neon Launch (medium load, 10 GB) | ~$80 |
| Upstash (~10M cmds) | ~$20 |
| Cloudflare R2 (50 GB, exports/uploads) | ~$0.60 |
| AWS SES (10K emails) | ~$0.70 |
| AWS SNS (2K SMS) | ~$15 |
| Pub/Sub | $0 |
| Scheduler + GSM + AR + GCS | ~$2 |
| **Growth Prod Total** | **~$190–200/mo** |

---

## 5. Free Tiers & Credits Summary

| Provider | Free Tier Highlights | Expiry |
|----------|---------------------|--------|
| **GCP** | $300 credits | 90 days from signup |
| **Cloud Run** | 180K vCPU-sec, 360K GiB-sec, 2M requests/mo | Ongoing |
| **GCS** | 5 GB Standard, 5K Class A ops | Ongoing |
| **Pub/Sub** | 10 GB messages/mo | Ongoing |
| **Cloud Scheduler** | 3 jobs free | Ongoing |
| **Secret Manager** | 6 versions free, 10K accesses | Ongoing |
| **Artifact Registry** | 0.5 GB storage | Ongoing |
| **Neon** | 100 CU-hrs/project, 0.5 GB storage | Ongoing |
| **Upstash** | 256 MB, 500K cmds/mo | Ongoing |
| **Cloudflare DNS** | Unlimited | Ongoing |
| **Cloudflare R2** | 10 GB, 1M Class A, 10M Class B | Ongoing |
| **AWS SES** | 3K messages/mo | 12 months |

Your $300 Google credits expire 90 days from initial signup. After that, the ongoing free tiers cover a significant portion of dev workloads indefinitely.

---

## 6. Feature-Driven Cost Drivers

Each application feature maps to specific infra cost centers. This helps you predict how feature usage scales cost:

### Ticketing & Checkout (highest cost sensitivity)
- **Stripe charges**: 2.9% + $0.30 per transaction (pass-through, not infra)
- **Infra**: API compute (Prisma tx), Pub/Sub (ticket.issue, ticket.hold, order-confirmation), Redis (idempotency keys, holds), Neon (orders, tickets, settlements)
- **At scale**: A 1,000-ticket event generates ~3K Pub/Sub messages, ~5K Redis commands, ~2K DB queries

### Search (Meilisearch)
- **Infra**: Cloud Run container + GCS FUSE volume
- **Cost driver**: Index size (events, places, orgs) and query frequency
- **At scale**: If search gets heavy traffic, Meilisearch needs min_instances=1 (~$13/mo) for acceptable latency

### Map Tiles (Tileserver)
- **Infra**: Cloud Run + GCS FUSE (PMTiles data)
- **Cost driver**: MapLibre client tile requests (per-user map loads)
- **Optimization**: Cloudflare CDN caching configured, max_instances=2 caps runaway scaling

### Email & Notifications
- **Infra**: SES ($0.10/1K), SNS SMS ($0.0075/SMS), Pub/Sub (async delivery)
- **Cost driver**: Announcement blasts to large attendee lists
- **At scale**: 10K-user announcement = ~$1 SES + small Pub/Sub cost

### Audio Transcoding
- **Infra**: Cloud Run (2 vCPU, 2 Gi memory — CPU-hungry FFmpeg)
- **Cost driver**: Number of audio uploads × processing time
- **Optimization**: Scale-to-zero means zero cost when idle

### Valhalla Routing
- **Infra**: Cloud Run (1 vCPU, 2 Gi memory — graph loaded in RAM)
- **Cost driver**: Travel-time API queries (gated behind `ENABLE_TRAVEL_TIME`)
- **Currently disabled** in dev. Only costs when enabled + image pushed.

### Settlements & Payouts
- **Infra**: Scheduled Cloud Scheduler job (daily), Pub/Sub → Jobs service
- **Cost driver**: Number of events with completed sales
- **Financial correctness** more important than cost here

---

## 7. Cost Monitoring Recommendations

### Tier 1: Do Now (5 minutes each)

1. **GCP Billing Budget Alert**
   - Billing → Budgets & Alerts → Create Budget
   - Set $50/mo budget with alerts at 50%, 80%, 100%
   - Optional: Can be Terraform-managed via `google_billing_budget`

2. **Neon Console Usage Dashboard**
   - Already available at console.neon.tech → your project → Usage
   - Shows CU-hours, storage, and branch count in real-time

3. **Upstash Console**
   - console.upstash.com → your database → Usage tab
   - Shows daily commands, data size, bandwidth

### Tier 2: Set Up This Week

4. **GCP Billing Export to BigQuery**
   - Enables SQL queries over historical cost data
   - Set up via Billing → Billing Export → BigQuery dataset
   - Free to export; BigQuery charges for queries (first 1 TB/mo free)

5. **Cloud Run Metrics Dashboard**
   - Cloud Console → Cloud Run → each service → Metrics tab
   - Key metric: `container/billable_instance_time`
   - Can create a custom Cloud Monitoring dashboard combining all services

6. **Infracost (CLI tool)**
   - `brew install infracost`
   - `infracost breakdown --path infra/terraform --terraform-var-file envs/prod/prod.tfvars`
   - Shows estimated monthly cost before `terraform apply`
   - Can integrate into CI for PR-time cost impact comments

### Tier 3: Growth Phase

7. **GCP Cost Labels**
   - Your Cloud Run module already labels resources with `application`, `environment`, `component`
   - Use these labels in Billing Reports to slice costs per service

8. **Committed Use Discounts (CUDs)**
   - If you consistently run min_instances=1 across prod services, CUDs give 17-40% discount
   - Evaluate after 3 months of stable prod traffic patterns

---

## 8. Optimization Opportunities

### Already Implemented ✅
- **Scale-to-zero** for dev (min_instances=0)
- **Startup probes** on API (`/health`) and Web (`/api/health`) — prevents billing for broken instances
- **Startup CPU boost** (default true) — free double-CPU during cold start
- **Artifact Registry cleanup policy** (keep_last=10)
- **Feature gates** (enable_valhalla=false, enable_create_events, enable_buy_tickets)

### Should Implement
- **Cloud Run concurrency tuning**: Default is 80 concurrent requests per instance. For the API (Prisma + connection pooling), test with 200+ to reduce instance count under load.
- **Meilisearch min_instances=1 in prod**: Cold-starting a search engine with GCS FUSE mount takes 15-30s. Worth the ~$13/mo for search UX.
- **R2 for image/asset hosting**: Zero egress fees vs GCS ($0.12/GB). Move user-uploaded images to R2 when volume grows.
- **Neon autoscaling limits**: Cap max CU size (e.g., 4 CU) to prevent runaway costs from expensive queries.

### Future Considerations
- **Cloud CDN / Cloudflare proxy**: When web traffic grows, put Cloudflare in front (proxied=true) to cache static assets and reduce Cloud Run request volume. Requires paid Cloudflare plan for Host header rewriting.
- **Regional optimization**: All services are in `us-central1`. If your audience is US-based, this is optimal. For global, consider multi-region Upstash read replicas.
- **Cloud Run instance-based billing**: If services stay active >60% of the time, instance-based billing ($0.000018/vCPU-sec vs $0.000024 active + $0.0000025 idle) may be cheaper.

---

## Quick Reference: Monthly Cost by Stage

| Stage | Cloud Run | Database | Redis | Email/SMS | Storage | Other | **Total** |
|-------|-----------|----------|-------|-----------|---------|-------|-----------|
| **Dev** | $0–5 | $0 | $0 | $0 | $0 | ~$1 | **~$1–6** |
| **Early Prod** | ~$25–30 | ~$15 | ~$3 | ~$2 | $0 | ~$2 | **~$47–52** |
| **Growth** | ~$70 | ~$80 | ~$20 | ~$16 | ~$1 | ~$2 | **~$190** |
| **Scale (10K+ users)** | ~$150+ | ~$200+ | ~$50+ | ~$50+ | ~$10+ | ~$5 | **~$465+** |

> **Bottom line**: With $300 Google credits, dev is free. Early prod is ~$50/mo. The stack scales gracefully because nearly everything is pay-per-use with generous free tiers.
