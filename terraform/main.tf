terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

resource "random_string" "sfx" {
  length  = 5
  upper   = false
  special = false
}

locals {
  sfx = random_string.sfx.result
  iothub_owner = [for p in azurerm_iothub.hub.shared_access_policy : p if p.key_name == "iothubowner"][0]
  database_url = "postgres://${var.pg_admin_user}:${urlencode(var.pg_admin_password)}@${azurerm_postgresql_flexible_server.pg.fqdn}:5432/${var.db_name}"
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-nodemon"
  location = var.location
}

# ---- IoT Hub (free tier: 8,000 messages/day) ----
resource "azurerm_iothub" "hub" {
  name                = "nodemon-iothub-${local.sfx}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku {
    name     = "F1"
    capacity = 1
  }
}

# ---- PostgreSQL Flexible Server ----
resource "azurerm_postgresql_flexible_server" "pg" {
  name                          = "nodemon-pg-${local.sfx}"
  resource_group_name           = azurerm_resource_group.rg.name
  location                      = azurerm_resource_group.rg.location
  version                       = "16"
  administrator_login           = var.pg_admin_user
  administrator_password        = var.pg_admin_password
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  public_network_access_enabled = true
  lifecycle { ignore_changes = [zone] }
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  name      = var.db_name
  server_id = azurerm_postgresql_flexible_server.pg.id
  collation = "en_US.utf8"
  charset   = "UTF8"
}

# 0.0.0.0 = "Allow public access from any Azure service" (the Function App, including its dashboard API, needs it)
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.pg.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "dev" {
  count            = var.dev_ip == "" ? 0 : 1
  name             = "dev-laptop"
  server_id        = azurerm_postgresql_flexible_server.pg.id
  start_ip_address = var.dev_ip
  end_ip_address   = var.dev_ip
}

# ---- Function App (IoT Hub trigger + monitor timer). The storage account only holds
#      the Functions runtime state (checkpoints, timer locks); no data archive. ----
resource "azurerm_storage_account" "func" {
  name                     = "stnodemon${local.sfx}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
}

resource "azurerm_service_plan" "func" {
  name                = "plan-nodemon-${local.sfx}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "func" {
  name                       = "nodemon-func-${local.sfx}"
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  service_plan_id            = azurerm_service_plan.func.id
  storage_account_name       = azurerm_storage_account.func.name
  storage_account_access_key = azurerm_storage_account.func.primary_access_key

  site_config {
    application_stack { node_version = "20" }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME = "node"
    IOTHUB_CONNECTION        = "Endpoint=${azurerm_iothub.hub.event_hub_events_endpoint};SharedAccessKeyName=iothubowner;SharedAccessKey=${local.iothub_owner.primary_key};EntityPath=${azurerm_iothub.hub.event_hub_events_path}"
    IOTHUB_EVENTHUB_NAME     = azurerm_iothub.hub.event_hub_events_path
    DATABASE_URL             = local.database_url
    OFFHOURS_ENABLED         = tostring(var.offhours_enabled)
    BUSINESS_TZ              = "Asia/Kolkata"
    DASHBOARD_ORIGIN         = trimsuffix(azurerm_storage_account.web.primary_web_endpoint, "/")
    ACS_CONNECTION_STRING    = azurerm_communication_service.acs.primary_connection_string
    ALERT_FROM               = "DoNotReply@${azurerm_email_communication_service_domain.domain.mail_from_sender_domain}"
    ALERT_TO                 = var.alert_emails
  }
}

# ---- Dashboard: React build served from a storage static website (Static Web Apps is blocked by the student region policy) ----
resource "azurerm_storage_account" "web" {
  name                     = "stweb${local.sfx}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
}
resource "azurerm_storage_account_static_website" "web" {
  storage_account_id = azurerm_storage_account.web.id
  index_document     = "index.html"
  error_404_document = "index.html"
}

# ---- Azure Communication Services (email alerts, Azure-managed sender domain) ----
resource "azurerm_communication_service" "acs" {
  name                = "nodemon-acs-${local.sfx}"
  resource_group_name = azurerm_resource_group.rg.name
  data_location       = "Asia Pacific"
}
resource "azurerm_email_communication_service" "mail" {
  name                = "nodemon-mail-${local.sfx}"
  resource_group_name = azurerm_resource_group.rg.name
  data_location       = "Asia Pacific"
}
resource "azurerm_email_communication_service_domain" "domain" {
  name              = "AzureManagedDomain"
  email_service_id  = azurerm_email_communication_service.mail.id
  domain_management = "AzureManaged"
}
resource "azurerm_communication_service_email_domain_association" "assoc" {
  communication_service_id = azurerm_communication_service.acs.id
  email_service_domain_id  = azurerm_email_communication_service_domain.domain.id
}
