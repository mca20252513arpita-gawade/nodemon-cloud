#!/usr/bin/env bash
# Usage: ./create-devices.sh <hub-name>   (needs: az login; az extension add --name azure-iot)
set -euo pipefail
for n in 1 2; do
  id="esp32-dept-cs-0$n"
  az iot hub device-identity create --hub-name "$1" --device-id "$id" --auth-method shared_private_key >/dev/null
  az iot hub device-identity connection-string show --hub-name "$1" --device-id "$id" --query connectionString -o tsv
done
