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
  default = "tileserver"
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
  default = 8080
}

variable "gcs_volume" {
  type = object({
    bucket_name = string
    mount_path  = string
    read_only   = optional(bool, false)
  })
  default = null
}

variable "allow_unauthenticated" {
  type    = bool
  default = true
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 1
}

variable "cpu" {
  description = "CPU limit for the tileserver container (e.g. '1', '2')."
  type        = string
  default     = null
}

variable "memory" {
  description = "Memory limit for the tileserver container (e.g. '512Mi', '1Gi')."
  type        = string
  default     = null
}

variable "env" {
  type    = map(string)
  default = {}
}
