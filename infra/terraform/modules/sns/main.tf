# SMS plumbing for AWS End User Messaging (SNS SMS).
#
# Outbound SMS is a direct-to-phone sns:Publish from the API/jobs (IAM user in
# modules/aws-hf-api); it needs no topic. The one topic here carries INBOUND
# replies (STOP/START/HELP): End User Messaging publishes each reply to a
# phone number to this topic, and the topic pushes it over HTTPS to the API
# route apps/api/src/routes/aws/sms-inbound.ts, which verifies the SNS
# signature, checks the topic ARN against AWS_SNS_SMS_INBOUND_TOPIC_ARN and
# confirms the subscription itself.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  sms_inbound_topic_name = "${var.name_prefix}-sms-inbound"
}

resource "aws_sns_topic" "sms_inbound" {
  name = local.sms_inbound_topic_name

  # SHA256 signatures on the HTTPS deliveries. The API route accepts only
  # SignatureVersion "2", so this must stay 2.
  signature_version = 2
}

# Lets End User Messaging SMS (service principal sms-voice.amazonaws.com)
# publish inbound replies to the topic. The SourceAccount / SourceArn
# conditions stop another account's phone number from using this topic
# (confused deputy), per the AWS two-way SMS topic-policy guide.
resource "aws_sns_topic_policy" "sms_inbound" {
  arn = aws_sns_topic.sms_inbound.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEndUserMessagingInboundSms"
        Effect    = "Allow"
        Principal = { Service = "sms-voice.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.sms_inbound.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:sms-voice:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"
          }
        }
      }
    ]
  })
}

# Ordering gate. SNS sends the SubscriptionConfirmation the moment the
# subscription is created; the API only accepts it once its revision has
# AWS_SNS_SMS_INBOUND_TOPIC_ARN, so the subscription waits on the API.
resource "terraform_data" "sms_inbound_api_ready" {
  count = var.sms_inbound_subscribe ? 1 : 0

  input = var.sms_inbound_after
}

# HTTPS push to the API. The API route answers the SubscriptionConfirmation
# itself, so the endpoint auto-confirms: Terraform waits up to
# sms_inbound_confirmation_timeout_minutes for the confirmation, and a
# subscription the API never confirms fails the apply instead of leaving STOP
# replies silently undelivered. AWS cannot delete a subscription that is still
# pending confirmation; Terraform drops it from state and leaves it in AWS.
resource "aws_sns_topic_subscription" "sms_inbound_https" {
  count = var.sms_inbound_subscribe ? 1 : 0

  depends_on = [terraform_data.sms_inbound_api_ready]

  topic_arn                       = aws_sns_topic.sms_inbound.arn
  protocol                        = "https"
  endpoint                        = var.sms_inbound_endpoint
  endpoint_auto_confirms          = var.sms_inbound_endpoint_auto_confirms
  confirmation_timeout_in_minutes = var.sms_inbound_confirmation_timeout_minutes

  lifecycle {
    precondition {
      condition     = startswith(coalesce(var.sms_inbound_endpoint, "missing"), "https://")
      error_message = "sms_inbound_endpoint must be an https:// URL when sms_inbound_subscribe is true."
    }
  }
}

# Account-level SMS preferences for the region. Transactional routes OTPs and
# reminders on the higher-reliability path. No default_sender_id: US SMS goes
# out from the registered US origination number (10DLC or toll-free) the app
# passes per message; the same number for OTP and notifications is the
# expected setup. The spend limit must stay at or under the account's approved SMS
# spend quota, or SetSMSAttributes (and the apply) fails.
resource "aws_sns_sms_preferences" "this" {
  count = var.create_sms_preferences ? 1 : 0

  default_sms_type    = var.sms_default_sms_type
  monthly_spend_limit = tostring(var.sms_monthly_spend_limit)

  # Delivery-status logging stays off unless a role is passed in.
  delivery_status_iam_role_arn = var.sms_delivery_status_iam_role_arn
  delivery_status_success_sampling_rate = (
    var.sms_delivery_status_success_sampling_rate == null
    ? null
    : tostring(var.sms_delivery_status_success_sampling_rate)
  )
}
