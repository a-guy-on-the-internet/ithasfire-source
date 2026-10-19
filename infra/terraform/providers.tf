// Root provider configuration.
//
// NOTE:
// Terraform only loads *.tf files that are in the root module directory.
// Files under ./provider are NOT evaluated unless they are part of a module.
//
// We keep these blocks here to ensure `terraform plan/apply` always has the
// providers configured.

locals {
  gcp_default_labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    managed_by  = "terraform"
  }

  cloudflare_use_api_token = var.cloudflare_api_token != null && trimspace(var.cloudflare_api_token) != ""
  cloudflare_use_api_key   = !local.cloudflare_use_api_token && var.cloudflare_api_key != null && var.cloudflare_email != null
}

provider "google" {
  project = var.project_id
  region  = var.region

  impersonate_service_account = var.google_impersonated_service_account
  request_timeout             = "60s"
  user_project_override       = true

  default_labels = local.gcp_default_labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  impersonate_service_account = var.google_impersonated_service_account
  request_timeout             = "60s"
  user_project_override       = true

  default_labels = local.gcp_default_labels
}


# Provider notes:
# - Terraform validates provider config at plan-time even if you don't intend to touch that provider.
# - The patterns below make `terraform plan` usable without having all credentials present.
# - When a provider isn't configured, any modules/resources that require it must be disabled via feature flags.

provider "cloudflare" {
  api_token = var.enable_cloudflare_dns ? (
    local.cloudflare_use_api_token ? var.cloudflare_api_token : (local.cloudflare_use_api_key ? null : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  ) : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  api_key = var.enable_cloudflare_dns && local.cloudflare_use_api_key ? var.cloudflare_api_key : null
  email   = var.enable_cloudflare_dns && local.cloudflare_use_api_key ? var.cloudflare_email : null
}

provider "upstash" {
  alias = "enabled"
  # Upstash provider requires both values.
  email   = var.enable_upstash && var.upstash_email != null ? var.upstash_email : "disabled@example.com"
  api_key = var.enable_upstash && var.upstash_api_key != null ? var.upstash_api_key : "__disabled__"
}

# Default provider config used when Upstash is disabled.
provider "upstash" {
  email   = var.enable_upstash && var.upstash_email != null ? var.upstash_email : "disabled@example.com"
  api_key = var.enable_upstash && var.upstash_api_key != null ? var.upstash_api_key : "__disabled__"
}

provider "neon" {
  alias   = "enabled"
  api_key = var.enable_neon && var.neon_api_key != null ? var.neon_api_key : "__disabled__"
}

# Default provider config used when Neon is disabled.
provider "neon" {
  api_key = var.enable_neon && var.neon_api_key != null ? var.neon_api_key : "__disabled__"
}

locals {
  # When enable_aws is false (default) we still need the AWS provider to
  # configure without exploding on missing creds — the SES/SNS/IAM modules
  # are count = 0, so the provider has zero resources to manage. Use static
  # dummy credentials so the SDK doesn't fall back to EC2 IMDS (which doesn't
  # exist on CI runners and produces a fatal "failed to refresh cached
  # credentials" error at terraform apply time).
  aws_provider_access_key = var.enable_aws && var.aws_access_key_id != null ? var.aws_access_key_id : "AKIA__AWS_DISABLED__"
  aws_provider_secret_key = var.enable_aws && var.aws_secret_access_key != null ? var.aws_secret_access_key : "__AWS_DISABLED__"
}

provider "aws" {
  alias   = "enabled"
  profile = (var.enable_aws && var.aws_access_key_id == null && var.aws_secret_access_key == null) ? "terraform" : null
  region  = var.aws_region

  access_key = local.aws_provider_access_key
  secret_key = local.aws_provider_secret_key

  dynamic "assume_role" {
    for_each = var.enable_aws && var.aws_assume_role_arn != null ? [var.aws_assume_role_arn] : []
    content {
      role_arn     = assume_role.value
      session_name = "ithasfire-terraform"
    }
  }

  skip_credentials_validation = var.enable_aws ? false : true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = var.enable_aws ? false : true

  default_tags {
    tags = {
      Application = "ithasfire"
      Environment = local.workspace_environment
      ManagedBy   = "terraform"
    }
  }
}

# Default AWS provider — the one child modules actually use.
# When enable_aws=true, inject credentials so SES/SNS/IAM resources work.
# When disabled, the provider stays inert (no aws_* resources are managed).
provider "aws" {
  region  = var.aws_region
  profile = (var.enable_aws && var.aws_access_key_id == null && var.aws_secret_access_key == null) ? "terraform" : null

  access_key = local.aws_provider_access_key
  secret_key = local.aws_provider_secret_key

  dynamic "assume_role" {
    for_each = var.enable_aws && var.aws_assume_role_arn != null ? [var.aws_assume_role_arn] : []
    content {
      role_arn     = assume_role.value
      session_name = "ithasfire-terraform"
    }
  }

  skip_credentials_validation = var.enable_aws ? false : true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = var.enable_aws ? false : true

  default_tags {
    tags = {
      Application = "ithasfire"
      Environment = local.workspace_environment
      ManagedBy   = "terraform"
    }
  }
}
