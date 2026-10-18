# Creates the 2 gateway identities and prints their connection strings (put each in that gateway's secrets.h).
# Needs: az login; az extension add --name azure-iot
param([Parameter(Mandatory)][string]$Hub)
foreach ($n in 1..2) {
  $id = "esp32-dept-cs-0$n"
  az iot hub device-identity create --hub-name $Hub --device-id $id --auth-method shared_private_key | Out-Null
  az iot hub device-identity connection-string show --hub-name $Hub --device-id $id --query connectionString -o tsv
}
