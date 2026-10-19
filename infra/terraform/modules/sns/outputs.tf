output "sms_inbound_topic_arn" {
  description = "ARN of the topic End User Messaging publishes inbound SMS replies to. The API reads it as AWS_SNS_SMS_INBOUND_TOPIC_ARN."
  value       = aws_sns_topic.sms_inbound.arn
}

output "sms_inbound_topic_name" {
  description = "Name of the inbound SMS topic."
  value       = aws_sns_topic.sms_inbound.name
}
