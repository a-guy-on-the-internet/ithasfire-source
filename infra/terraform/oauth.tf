##############################################################################
# Google OAuth (Social Sign-In) — Workforce Identity Federation client
#
# ⚠ WARNING: google_iam_oauth_client creates a GCP Workforce Identity
#   Federation OAuth client.  This is NOT the same as a standard Google
#   OAuth 2.0 "Web application" client (the kind with a
#   *.apps.googleusercontent.com ID).
#
#   For "Sign in with Google" in a consumer app, you need a standard OAuth
#   2.0 client from APIs & Services → Credentials.  That resource type
#   is NOT available in the Google Terraform provider today.
#
#   Unless you have a specific use-case for Workforce Identity, set
#   enable_google_oauth = false in your .tfvars and supply the real
#   client ID / secret via:
#     TF_VAR_google_client_id=<id>.apps.googleusercontent.com
#     TF_VAR_google_client_secret=GOCSPX-<secret>
#
# Terraform manages (when enable_google_oauth = true):
#   - The IAM OAuth 2.0 client  (google_iam_oauth_client)        — sets redirect URIs
#   - The client credential     (google_iam_oauth_client_credential) — yields the secret
#
# The generated client_id and secret are surfaced as outputs and wired into
# resolved_api_env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_WEB_CLIENT_ID)
# so the API Cloud Run service gets them automatically.
#
# What stays manual (not expressible via Terraform providers):
#   - Standard web OAuth client → create in GCP console Credentials page
#   - iOS client  → create in GCP console (Application type: iOS), then set
#                   TF_VAR_google_ios_client_id in infra/.env.local
#   - Android client → same, TF_VAR_google_android_client_id
#   - Apple Sign In  → entirely in developer.apple.com, pass via TF_VAR_apple_*
#
# Enable this block by setting  enable_google_oauth = true  in your .tfvars and
# providing oauth_support_email (required by Google for the consent screen).
##############################################################################

# Ensure the required APIs are active before creating OAuth resources.
resource "google_project_service" "iam_googleapis" {
  count   = var.enable_google_oauth ? 1 : 0
  project = var.project_id
  service = "iam.googleapis.com"

  disable_on_destroy = false
}

# IAM OAuth 2.0 web client.
# Unlike google_iap_client, this resource exposes allowed_redirect_uris directly,
# so redirect URIs are fully managed by Terraform (no manual console edits needed).
resource "google_iam_oauth_client" "hearthfire_web" {
  provider = google-beta
  count    = var.enable_google_oauth ? 1 : 0

  project         = var.project_id
  location        = "global"
  oauth_client_id = "hearthfire-web-${local.workspace_environment}"
  display_name    = "Ithas Fire Web (${local.workspace_environment})"
  description     = "Managed by Terraform — do not edit in the console."

  client_type         = "CONFIDENTIAL_CLIENT"
  allowed_grant_types = ["AUTHORIZATION_CODE_GRANT"]
  allowed_scopes = [
    "openid",
    "email",
  ]

  allowed_redirect_uris = var.oauth_redirect_uris

  depends_on = [google_project_service.iam_googleapis]
}

# Client credential — yields the client secret.
resource "google_iam_oauth_client_credential" "hearthfire_web" {
  provider = google-beta
  count    = var.enable_google_oauth ? 1 : 0

  project                    = var.project_id
  location                   = google_iam_oauth_client.hearthfire_web[0].location
  oauthclient                = google_iam_oauth_client.hearthfire_web[0].oauth_client_id
  oauth_client_credential_id = "hearthfire-web-cred-${local.workspace_environment}"
  display_name               = "Ithas Fire Web credential (${local.workspace_environment})"
  disabled                   = false
}
