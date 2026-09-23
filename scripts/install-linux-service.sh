#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
# If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Copyright (C) 2025 MundoGIS.
#
# Installs MGIS-Downloader as a systemd service on Linux.
# Usage: sudo ./scripts/install-linux-service.sh [run-as-user]

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="mgis-downloader"
RUN_USER="${1:-${SUDO_USER:-$(whoami)}}"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "No se encontró 'node' en el PATH. Instala Node.js antes de continuar." >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Este script debe ejecutarse con sudo." >&2
  exit 1
fi

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ArtData och LMV data (MGIS-Downloader)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} --max-old-space-size=8192 server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "Servicio '${SERVICE_NAME}' instalado y arrancado."
echo "Ver estado: systemctl status ${SERVICE_NAME}"
echo "Ver logs:   journalctl -u ${SERVICE_NAME} -f"
