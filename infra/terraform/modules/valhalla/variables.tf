variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "service_name" {
  type    = string
  default = "valhalla"
}

variable "name_prefix" {
  description = "Prefix for resource names (e.g. th-dev)."
  type        = string
  default     = null
}

variable "image" {
  type = string
}

variable "port" {
  type    = number
  default = 8002
}

variable "invoker_service_accounts" {
  description = "Map of stable keys to service account emails allowed to invoke this internal service."
  type        = map(string)
  default     = {}
}

variable "min_instances" {
  description = "Minimum instances. 0 = scale to zero when idle (saves cost)."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum instances."
  type        = number
  default     = 1
}

variable "cpu" {
  description = "CPU limit (e.g. '1', '2'). Valhalla is CPU-bound for route computation."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit (e.g. '2Gi'). Valhalla loads the routing graph into RAM."
  type        = string
  default     = "2Gi"
}

variable "env" {
  type    = map(string)
  default = {}
}
