terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }

    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }

    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Neon Postgres (community provider; see https://neon.com/docs/reference/terraform)
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }

    # Upstash (official provider; see https://github.com/upstash/terraform-provider-upstash)
    upstash = {
      source  = "upstash/upstash"
      version = "~> 2.1"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }

    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
}
