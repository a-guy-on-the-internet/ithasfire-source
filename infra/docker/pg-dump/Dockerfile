# pg-dump backup job image — runs as a Cloud Run Job (MODE=dump|promote).
#
# Spec: docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md
# Built/pushed via .github/workflows/pg-dump-image.yml
#
# Base pins the Postgres CLIENT major to the prod server major. Neon prod is
# Postgres 16 (infra/terraform/modules/neon: pg_version default = 16) — bump
# this base image in lockstep when the Neon project is upgraded.
FROM postgres:16-bookworm

# google-cloud-cli: GCS upload + Pub/Sub manifest publish (ADC via the Cloud
# Run metadata server — no key material in the image).
# zstd: dump compression.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    zstd \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/backup-entrypoint.sh
RUN chmod 0755 /usr/local/bin/backup-entrypoint.sh

# Non-root. The postgres user ships with the base image and owns a writable
# HOME (/var/lib/postgresql) for gcloud's config dir.
USER postgres

ENTRYPOINT ["/usr/local/bin/backup-entrypoint.sh"]
