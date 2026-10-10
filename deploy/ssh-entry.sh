#!/bin/bash
set -euo pipefail
if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
 exec sudo -n /usr/local/lib/nextech-cicd/dispatcher.py deploy "${BASH_REMATCH[1]}"
fi
echo 'Commande de déploiement refusée' >&2
exit 64
