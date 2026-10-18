output "iothub_hostname"   { value = azurerm_iothub.hub.hostname }
output "function_app_name" { value = azurerm_linux_function_app.func.name }
output "postgres_fqdn"     { value = azurerm_postgresql_flexible_server.pg.fqdn }
output "dashboard_url"     { value = azurerm_storage_account.web.primary_web_endpoint }
output "api_base_url"      { value = "https://${azurerm_linux_function_app.func.default_hostname}" }
