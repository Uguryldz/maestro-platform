#!/usr/bin/env bash
#
# Removes the Maestro Runner Agent launchd daemon.
#
# The service account and the work directory are kept by default: the work
# directory holds ticket workspaces, and deleting a workspace is an AUDITED
# operation on the platform side (M31/M65), not something an uninstaller should
# do silently. Pass --purge when the machine is being decommissioned.
set -euo pipefail

LABEL="com.maestro.runner-agent"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
INSTALL_DIR="/usr/local/maestro/runner-agent"
WORK_DIR="/var/maestro/agent"
AGENT_USER="_maestro"
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '3,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# `bootout` sends SIGTERM and waits, so the agent drains its leases and
# deregisters instead of leaving the platform to time them out.
if launchctl print "system/${LABEL}" >/dev/null 2>&1; then
  echo "stopping ${LABEL} (draining leases)…"
  launchctl bootout "system/${LABEL}" || true
fi

rm -f "${PLIST}"
rm -rf "${INSTALL_DIR}"

if [[ $PURGE -eq 1 ]]; then
  echo "purging work directory and service account"
  rm -rf "${WORK_DIR}"
  security delete-generic-password -s "maestro-runner-agent" /Library/Keychains/System.keychain 2>/dev/null || true
  dscl . -delete "/Users/${AGENT_USER}" 2>/dev/null || true
else
  echo "kept ${WORK_DIR} and the ${AGENT_USER} account (use --purge to remove them)"
fi

echo "uninstalled."
