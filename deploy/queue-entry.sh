#!/bin/bash
set -euo pipefail
if [[ "${SSH_ORIGINAL_COMMAND:-}" == "sync" ]]; then
 exec sudo -n /usr/local/lib/nextech-cicd/queue_bridge.py
fi
echo 'Commande de coordination refusée' >&2
exit 64
