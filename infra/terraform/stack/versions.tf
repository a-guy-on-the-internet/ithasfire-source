terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }

    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }

    upstash = {
      source  = "upstash/upstash"
      version = "~> 2.1"
    }
  }
}
