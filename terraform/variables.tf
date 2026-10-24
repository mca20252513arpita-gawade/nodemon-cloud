variable "subscription_id" { type = string }
variable "location" {
  type    = string
  default = "centralindia"
}
variable "pg_admin_user" {
  type    = string
  default = "nodemonadmin"
}
variable "pg_admin_password" {
  type      = string
  sensitive = true
}
variable "db_name" {
  type    = string
  default = "nodemon"
}
variable "dev_ip" {
  type        = string
  default     = ""
  description = "Your laptop's public IP, to run migrations / psql."
}
variable "offhours_enabled" {
  type    = bool
  default = true
}
variable "alert_emails" {
  type        = string
  default     = ""
  description = "Comma-separated alert recipients."
}

variable "api_key" {
  type        = string
  sensitive   = true
  description = "Secret key the dashboard sends as X-Api-Key header. Generate with: openssl rand -hex 32"
}
