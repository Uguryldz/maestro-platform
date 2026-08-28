#!/usr/bin/env bash
#
# Installs the Maestro Runner Agent as a launchd LaunchDaemon on macOS.
#
# Run as root (launchd daemons are root-owned by definition), but the agent
# itself runs as a DEDICATED NON-ADMIN user: the sandbox story on macOS is
# "ephemeral user + narrow rights" (there is no container), so an agent running
# as an admin would erase the only isolation this platform has.
#
# Usage:
#   sudo ./install-macos.sh --platform-url https://maestro.internal \
#                           --agent-id mac-mini-07 \
#                           --token-key MAESTRO_AGENT_TOKEN
set -euo pipefail

LABEL="com.maestro.runner-agent"
AGENT_USER="_maestro"
INSTALL_DIR="/usr/local/maestro/runner-agent"
WORK_DIR="/var/maestro/agent"
LOG_DIR="/var/log/maestro"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
KEYCHAIN_SERVICE="maestro-runner-agent"

PLATFORM_URL=""
AGENT_ID=""
TOKEN_KEY="MAESTRO_AGENT_TOKEN"
CAPACITY="2"
LABELS=""
AGENT_VERSION="0.1.0"

usage() {
  sed -n '3,13p' "$0"
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform-url) PLATFORM_URL="$2"; shift 2 ;;
    --agent-id)     AGENT_ID="$2";     shift 2 ;;
    --token-key)    TOKEN_KEY="$2";    shift 2 ;;
    --capacity)     CAPACITY="$2";     shift 2 ;;
    --labels)       LABELS="$2";       shift 2 ;;
    --version)      AGENT_VERSION="$2"; shift 2 ;;
    -h|--help)      usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

# Fail closed: the agent refuses to start half-configured, so the installer
# refuses to install a configuration that cannot start.
[[ -n "$PLATFORM_URL" ]] || { echo "--platform-url is required" >&2; exit 1; }
[[ -n "$AGENT_ID" ]]     || { echo "--agent-id is required" >&2; exit 1; }
[[ "$PLATFORM_URL" == https://* ]] || { echo "--platform-url must be https" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "must run as root (launchd daemon)" >&2; exit 1; }

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
NODE_BIN="$(command -v node)"

# ── dedicated non-admin service account ───────────────────────────────────
if ! dscl . -read "/Users/${AGENT_USER}" >/dev/null 2>&1; then
  echo "creating service account ${AGENT_USER}"
  # Highest free UID below 500 keeps the account out of the login window.
  NEXT_UID=$(dscl . -list /Users UniqueID | awk '$2 < 500 {print $2}' | sort -n | tail -1)
  NEXT_UID=$((NEXT_UID + 1))
  dscl . -create "/Users/${AGENT_USER}"
  dscl . -create "/Users/${AGENT_USER}" UserShell /usr/bin/false
  dscl . -create "/Users/${AGENT_USER}" RealName "Maestro Runner Agent"
  dscl . -create "/Users/${AGENT_USER}" UniqueID "${NEXT_UID}"
  dscl . -create "/Users/${AGENT_USER}" PrimaryGroupID 20
  dscl . -create "/Users/${AGENT_USER}" NFSHomeDirectory "${WORK_DIR}"
  # No password: the account is for launchd, not for a person.
  dscl . -delete "/Users/${AGENT_USER}" AuthenticationAuthority 2>/dev/null || true
  dscl . -delete "/Users/${AGENT_USER}" passwd 2>/dev/null || true
fi

install -d -o "${AGENT_USER}" -g staff -m 0750 "${WORK_DIR}" "${LOG_DIR}"
install -d -m 0755 "${INSTALL_DIR}"

# ── application files ─────────────────────────────────────────────────────
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
/usr/bin/rsync -a --delete \
  --exclude node_modules --exclude test --exclude '*.test.ts' \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

# ── shared secret ─────────────────────────────────────────────────────────
# Stored in the system keychain, NEVER in the plist: a plist is world-readable
# and `launchctl print` shows its environment.
if ! security find-generic-password -a "${AGENT_ID}" -s "${KEYCHAIN_SERVICE}" >/dev/null 2>&1; then
  echo "No shared secret found in the system keychain."
  echo "Add it with:"
  echo "  sudo security add-generic-password -a '${AGENT_ID}' -s '${KEYCHAIN_SERVICE}' -w -U /Library/Keychains/System.keychain"
  exit 1
fi

# Wrapper reads the secret at start time and exports it for the agent only.
cat > "${INSTALL_DIR}/run-agent.sh" <<WRAPPER
#!/bin/sh
set -eu
# Exported into this process only; it never lands in the plist or on disk.
MAESTRO_AGENT_TOKEN="\$(/usr/bin/security find-generic-password -a '${AGENT_ID}' -s '${KEYCHAIN_SERVICE}' -w /Library/Keychains/System.keychain)"
export ${TOKEN_KEY}="\$MAESTRO_AGENT_TOKEN"
unset MAESTRO_AGENT_TOKEN
exec "${NODE_BIN}" --experimental-strip-types "${INSTALL_DIR}/src/main.ts"
WRAPPER
chmod 0750 "${INSTALL_DIR}/run-agent.sh"
chown root:staff "${INSTALL_DIR}/run-agent.sh"

# ── launchd job ───────────────────────────────────────────────────────────
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/run-agent.sh</string>
  </array>
  <key>UserName</key><string>${AGENT_USER}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <!-- SIGTERM first: the agent drains its leases before it exits. -->
  <key>ExitTimeOut</key><integer>120</integer>
  <key>WorkingDirectory</key><string>${WORK_DIR}</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/runner-agent.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/runner-agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>MAESTRO_AGENT_PLATFORM_URL</key><string>${PLATFORM_URL}</string>
    <key>MAESTRO_AGENT_ID</key><string>${AGENT_ID}</string>
    <key>MAESTRO_AGENT_PLATFORM</key><string>macos-xcode</string>
    <key>MAESTRO_AGENT_VERSION</key><string>${AGENT_VERSION}</string>
    <key>MAESTRO_AGENT_CAPACITY</key><string>${CAPACITY}</string>
    <key>MAESTRO_AGENT_LABELS</key><string>${LABELS}</string>
    <key>MAESTRO_AGENT_WORK_DIR</key><string>${WORK_DIR}</string>
    <key>MAESTRO_AGENT_TOKEN_SOURCE</key><string>env</string>
    <key>MAESTRO_AGENT_TOKEN_KEY</key><string>${TOKEN_KEY}</string>
  </dict>
</dict>
</plist>
PLIST_EOF

chown root:wheel "${PLIST}"
chmod 0644 "${PLIST}"

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "${PLIST}"
launchctl enable "system/${LABEL}"

echo "installed. status:  sudo launchctl print system/${LABEL}"
echo "logs:               tail -f ${LOG_DIR}/runner-agent.log"
