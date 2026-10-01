#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
# If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Copyright (C) 2025 MundoGIS.
#
# Removes the MGIS-Downloader systemd service on Linux.
# Usage: sudo ./scripts/uninstall-linux-service.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Este script debe ejecutarse con sudo." >&2
  exit 1
fi

SERVICE_NAME="mgis-downloader"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl daemon-reload

echo "Servicio '${SERVICE_NAME}' desinstalado."
