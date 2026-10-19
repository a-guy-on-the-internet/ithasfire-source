locals {
  iam_user_name = "${var.name_prefix}-api"
}

resource "aws_iam_user" "api" {
  name = local.iam_user_name

  tags = {
    Application = "ithasfire"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Least privilege for the API/jobs SMS sender (SnsSmsAdapter). The resource
# name and policy name stay the same so an existing user's policy updates in
# place.
resource "aws_iam_user_policy" "sns_publish" {
  name = "${local.iam_user_name}-sns-publish"
  user = aws_iam_user.api.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Direct-to-phone Publish (PhoneNumber parameter) carries no resource
        # ARN, so IAM evaluates it against "*" and the Allow must be "*".
        Sid      = "PublishSmsToPhoneNumbers"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = "*"
      },
      {
        # Every topic and endpoint ARN matches arn:aws:sns:*:*:*, so this
        # explicit Deny keeps a leaked key from publishing to any topic or
        # push endpoint (including the inbound SMS topic) while leaving
        # direct-to-phone SMS untouched.
        # UNPROVEN until one live direct-to-phone Publish succeeds with this
        # key: if AWS ever evaluates a phone-number Publish against an
        # arn:aws:sns ARN, this Deny blocks every SMS. Run that one send
        # before prod flips enable_aws to true.
        Sid      = "DenyPublishToTopicsAndEndpoints"
        Effect   = "Deny"
        Action   = ["sns:Publish"]
        Resource = "arn:aws:sns:*:*:*"
      },
      {
        # Opt-out lookups so the app can skip numbers that replied STOP.
        # Account-level actions with no resource type, hence "*".
        Sid    = "ReadSmsOptOuts"
        Effect = "Allow"
        # sns:ListPhoneNumbersOptedOut is left out on purpose: it exports
        # every number that replied STOP, and no production code calls it.
        Action   = ["sns:CheckIfPhoneNumberIsOptedOut"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_access_key" "api" {
  user = aws_iam_user.api.name
}
