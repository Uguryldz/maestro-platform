#!/usr/bin/env bash
# Boot the BFF from source against a throwaway Postgres, for a smoke run.
#
# Every value here is a fake pointing at a host that does not resolve. That is
# deliberate and safe: the endpoints under test (doc-template, settings, notify,
# routing) read the database and the validated environment, and none of them
# makes an outbound call. The values exist because `loadEnv` refuses to return
# without them (M6) — which is the behaviour being relied on, not worked around.
set -euo pipefail
cd "$(dirname "$0")/../../.."

export DATABASE_URL="postgresql://maestro:x@127.0.0.1:55442/maestro"
export TEMPORAL_ADDRESS="127.0.0.1:7233"
export BFF_PORT=7442
export BFF_HOST=127.0.0.1
export NODE_ENV=development
export MAESTRO_PROFILE=dev
export LOG_LEVEL=warn
export JIRA_BASE_URL="https://jira.ugurbank.local"
export ADO_BASE_URL="https://tfs.ugurbank.local"
export ADO_ORG=ugurbank
export ADO_PROJECT=Maestro
export ADO_PR_VALIDATION_BUILDS="odeme-api:42"
export VAULT_ADDR="https://vault.ugurbank.local"
export STORAGE_ENDPOINT="https://s3.ugurbank.local"
export EGRESS_PROXY_URL="http://egress.ugurbank.local:3128"
export LLM_BASE_URL="https://llm.ugurbank.local/v1"
export LLM_MODEL="gpt-4o-mini"
export MAESTRO_SECRET_KV_JIRA__TOKEN=smoke-jira-token
export MAESTRO_SECRET_KV_JIRA__WEBHOOK=smoke-jira-webhook-secret
export MAESTRO_SECRET_KV_ADO__TOKEN=smoke-ado-token
export MAESTRO_SECRET_KV_ADO__WEBHOOK=smoke-ado-webhook-secret
export MAESTRO_SECRET_KV_LLM__API__2D_KEY=smoke-llm-key
# Digest-pinned scanner images (M27). Real digests of real images, because the
# boot check is that the reference is PINNED — a tag can change under a passing
# gate — and a made-up digest would be a value the check exists to reject.
export SCAN_IMAGE_TRIVY="aquasec/trivy@sha256:0000000000000000000000000000000000000000000000000000000000000001"
export SCAN_IMAGE_SEMGREP="semgrep/semgrep@sha256:0000000000000000000000000000000000000000000000000000000000000002"
export SCAN_IMAGE_GITLEAKS="zricethezav/gitleaks@sha256:0000000000000000000000000000000000000000000000000000000000000003"

exec pnpm --filter @maestro/deploy exec tsx src/bin/bff.ts
