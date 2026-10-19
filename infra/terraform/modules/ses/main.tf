# ─────────────────────────────────────────────────────────────────────────────────
# SES Module — Domain identity, DKIM, MAIL FROM, and SMTP credentials
#
# Creates an SES domain identity with DKIM signing, provisions an IAM user
# with ses:SendRawEmail permission, and generates SMTP credentials.
#
# DKIM CNAME records and MAIL FROM MX/TXT records are output so the caller
# can wire them into the DNS provider (Cloudflare).
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  smtp_iam_user_name = "${var.name_prefix}-ses-smtp"
  mail_from_domain   = "mail.${var.domain}"
}

# ── Domain identity ──────────────────────────────────────────────────────────────

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = {
    Application = "ithasfire"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── MAIL FROM domain ─────────────────────────────────────────────────────────────
# Configures a custom MAIL FROM so bounces/complaints go to a subdomain we
# control, and SES sets the envelope-from to mail.ithasfire.com instead
# of amazonses.com.  This improves deliverability and SPF alignment.

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity = aws_sesv2_email_identity.domain.email_identity

  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# ── SMTP IAM user ────────────────────────────────────────────────────────────────
# SES SMTP requires an IAM user whose secret access key is converted to an SMTP
# password via the SES signing algorithm.  The `aws_iam_access_key` resource
# exposes `ses_smtp_password_v4` which is the ready-to-use SMTP password.

resource "aws_iam_user" "smtp" {
  name = local.smtp_iam_user_name

  tags = {
    Application = "ithasfire"
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "SES SMTP sending"
  }
}

resource "aws_iam_user_policy" "smtp_send" {
  name = "${local.smtp_iam_user_name}-send"
  user = aws_iam_user.smtp.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SesSendEmail"
        Effect   = "Allow"
        Action   = ["ses:SendRawEmail", "ses:SendEmail"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ses:FromAddress" = var.from_email
          }
        }
      }
    ]
  })
}

resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}

# ── Email feedback forwarding ────────────────────────────────────────────────────
# Ensures bounce/complaint notifications are forwarded via email to the
# address in the From header (e.g. no-reply@ithasfire.com).
# This is SES's default behaviour but we make it explicit so it survives
# future Terraform drift detection.

resource "aws_sesv2_email_identity_feedback_attributes" "domain" {
  email_identity           = aws_sesv2_email_identity.domain.email_identity
  email_forwarding_enabled = true
}

# ── Configuration set (optional, for SES Console metrics) ────────────────────────
# A lightweight config set that gives us per-email send/delivery/bounce/complaint
# metrics in the SES Console at zero cost.  The SMTP adapter injects the
# X-SES-CONFIGURATION-SET header to opt into tracking.

resource "aws_sesv2_configuration_set" "default" {
  count = var.enable_configuration_set ? 1 : 0

  configuration_set_name = "${var.name_prefix}-emails"

  sending_options {
    sending_enabled = true
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = {
    Application = "ithasfire"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
