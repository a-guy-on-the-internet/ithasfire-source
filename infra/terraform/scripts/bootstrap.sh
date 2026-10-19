#!/usr/bin/env bash
set -euo pipefail

# Ithas Fire infrastructure bootstrap helper
#
# Sets up the minimum cloud prerequisites so Terraform can run its first
# `plan`/`apply` without manual console work using a Google Cloud Storage
# remote state bucket.
#
# Responsibilities
#   - Ensure required Google Cloud APIs are enabled
#   - Create (or reuse) the Terraform service account and grant core roles
#   - Provision a remote-state bucket in Google Cloud Storage

set -o errexit
set -o nounset
set -o pipefail

if [[ "${TRACE:-0}" == "1" ]]; then
	set -o xtrace
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_ENVIRONMENT="dev"
DEFAULT_SA_NAME="terraform"
DEFAULT_GCS_BUCKET_PREFIX="th-terraform-state"

function usage() {
	cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

Required:
	-p, --project <id>          GCP project ID to bootstrap
	-r, --region <region>       Default region for regional resources (e.g. us-central1)

Optional:
	-e, --environment <env>     Environment label (dev|stage|prod). Default: dev
	-B, --bucket <name>         GCS bucket name for Terraform state (defaults to prefix + environment)
	--bucket-location <loc>     Location for the state bucket. Default: us-central1
	--service-account <name>    Service account name (without domain). Default: terraform
	--skip-api                  Do not attempt to enable Google APIs (assume enabled)
	-h, --help                  Show this help message

Environment variables honoured:
	GOOGLE_IMPERSONATE          Service account email to impersonate for gcloud operations
	TRACE=1                     Enable bash tracing for debugging

Examples:
	scripts/bootstrap.sh -p hf-dev -r us-central1
	scripts/bootstrap.sh -p hf-dev -r us-central1 --bucket=hf-dev-tf-state
EOF
}

PROJECT_ID=""
REGION=""
ENVIRONMENT="${DEFAULT_ENVIRONMENT}"
STATE_BUCKET=""
STATE_BUCKET_LOCATION="us-central1"
SERVICE_ACCOUNT_NAME="${DEFAULT_SA_NAME}"
ENABLE_APIS=true

while [[ $# -gt 0 ]]; do
	case "$1" in
		-p|--project)
			PROJECT_ID="$2"; shift 2 ;;
		-r|--region)
			REGION="$2"; shift 2 ;;
		-e|--environment)
			ENVIRONMENT="$2"; shift 2 ;;
		-b|--backend)
			echo "--backend flag is no longer supported. Remote state uses GCS by default." >&2
			exit 1 ;;
		-B|--bucket)
			STATE_BUCKET="$2"; shift 2 ;;
		--bucket-location)
			STATE_BUCKET_LOCATION="$2"; shift 2 ;;
		--service-account)
			SERVICE_ACCOUNT_NAME="$2"; shift 2 ;;
		--skip-api)
			ENABLE_APIS=false; shift 1 ;;
		-h|--help)
			usage; exit 0 ;;
		*)
			echo "Unknown argument: $1" >&2
			usage
			exit 1 ;;
	esac
done

if [[ -z "${PROJECT_ID}" || -z "${REGION}" ]]; then
	echo "Missing required project or region." >&2
	usage
	exit 1
fi

if [[ -z "${STATE_BUCKET}" ]]; then
	STATE_BUCKET="${DEFAULT_GCS_BUCKET_PREFIX}-${ENVIRONMENT}"
fi

function log() {
	echo "[bootstrap] $*"
}

function require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing dependency '$1'. Please install it before running the bootstrap script." >&2
		exit 1
	fi
}

require_command gcloud
require_command gsutil

if [[ -n "${GOOGLE_IMPERSONATE:-}" ]]; then
	gcloud config set auth/impersonate_service_account "${GOOGLE_IMPERSONATE}" >/dev/null
fi

log "Using project: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null

function enable_google_apis() {
	if [[ "${ENABLE_APIS}" != true ]]; then
		log "Skipping API enablement per flag."
		return
	fi

	local services=(
		compute.googleapis.com
		container.googleapis.com
		artifactregistry.googleapis.com
		secretmanager.googleapis.com
		iam.googleapis.com
		cloudkms.googleapis.com
		serviceusage.googleapis.com
		cloudresourcemanager.googleapis.com
	)

	log "Enabling required Google APIs (idempotent)."
	gcloud services enable "${services[@]}" --project "${PROJECT_ID}" --quiet
}

function ensure_service_account() {
	local sa_name="$1"
	local sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"

	if gcloud iam service-accounts describe "${sa_email}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
		log "Service account ${sa_email} already exists."
	else
		log "Creating service account ${sa_email}."
		gcloud iam service-accounts create "${sa_name}" \
			--display-name "Ithas Fire Terraform" \
			--project "${PROJECT_ID}"
	fi

	local roles=(
		roles/editor
		roles/storage.admin
		roles/secretmanager.admin
		roles/container.admin
		roles/iam.serviceAccountUser
		roles/artifactregistry.admin
		# roles/editor carries no *.setIamPolicy permissions; the db-backup
		# module sets IAM on its CMEK key and Pub/Sub topic, so the deployer
		# needs the admin roles for those services.
		# NOTE: CI's GCP_SA_KEY actually belongs to github-actions@, not the
		# terraform@ SA this script creates — grant BOTH (done manually
		# 2026-06-12 for github-actions@; keep them in sync or consolidate).
		roles/cloudkms.admin
		roles/pubsub.admin
		# PROJECT-level IAM management. roles/editor lacks
		# resourcemanager.projects.setIamPolicy, so any module that creates a
		# project-level google_project_iam_member (a new service needing a
		# project role) 403s at create AND teardown. This bit us retiring
		# Meilisearch (2026-07-03). projectIamAdmin lets the deployer manage
		# project IAM bindings. Also granted manually to github-actions@ on
		# 2026-07-03. (Prefer bucket/topic/secret-scoped IAM where possible —
		# see modules/cloud-run-service — but this covers genuinely
		# project-scoped grants for future services.)
		roles/resourcemanager.projectIamAdmin
		# Queue-scoped Cloud Tasks IAM (modules/cloud-tasks-queue). roles/editor
		# can create queues but carries no cloudtasks.queues.setIamPolicy.
		# Grant to github-actions@ as well (see the NOTE above).
		roles/cloudtasks.admin
	)

	for role in "${roles[@]}"; do
		if gcloud projects get-iam-policy "${PROJECT_ID}" \
			--flatten="bindings[]" \
			--format="value(bindings.role,bindings.members)" \
			| grep -q "${role}.*serviceAccount:${sa_email}"; then
			continue
		fi

		log "Granting ${role} to ${sa_email}."
		gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
			--member "serviceAccount:${sa_email}" \
			--role "${role}" \
			--quiet >/dev/null
	done

	echo "${sa_email}"
}

function ensure_state_bucket() {
	local bucket_name="$1"
	local location="$2"

	if gsutil ls -b "gs://${bucket_name}" >/dev/null 2>&1; then
		log "State bucket gs://${bucket_name} already exists."
	else
		log "Creating state bucket gs://${bucket_name} in ${location}."
		gcloud storage buckets create "gs://${bucket_name}" \
			--project "${PROJECT_ID}" \
			--location "${location}" \
			--uniform-bucket-level-access \
			--default-storage-class STANDARD \
			--quiet
	fi
}


function bootstrap() {
	enable_google_apis

	local sa_email
	sa_email=$(ensure_service_account "${SERVICE_ACCOUNT_NAME}")

	ensure_state_bucket "${STATE_BUCKET}" "${STATE_BUCKET_LOCATION}"

	cat <<EOF

Bootstrap completed ✅

Summary:
	Project:              ${PROJECT_ID}
	Region:               ${REGION}
	Environment:          ${ENVIRONMENT}
	Backend:              gcs
	Service account:      ${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com
	State bucket:         ${STATE_BUCKET}
	Bucket location:      ${STATE_BUCKET_LOCATION}

Next steps:
	1. Generate a service-account key if your Terraform runner requires one:
			 gcloud iam service-accounts keys create key.json \
				 --iam-account ${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com
			 Store it securely (e.g. as a local environment variable or CI secret).
	2. Update infra/terraform/backend.tfbackend with the chosen GCS backend configuration.
	3. Run terraform init/plan from infra/terraform/.
EOF
}

bootstrap
