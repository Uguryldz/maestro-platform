# Maestro deployment.
#
#   make up        bring the whole stack up (builds on first run)
#   make down      stop it, keeping the database
#   make logs      follow every service
#   make ps        what is running, and whether it is healthy
#   make migrate   apply migrations against a running stack
#   make config    render the resolved compose file (a syntax check)
#   make clean     stop it AND delete the database volume
#
# The same targets are reachable from the repository root as
# `pnpm deploy:up`, `deploy:down`, `deploy:logs` — the scripts there call this
# file, so there is one definition of what "up" means rather than two.

COMPOSE := docker compose -f compose.yaml
ENV_FILE := .env

.DEFAULT_GOAL := help
.PHONY: help up down logs ps migrate config clean build

help:
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

# The guard is the point: without `.env`, compose interpolates every unset
# variable to an empty string and the stack comes up half-configured — which
# the services would then refuse anyway, but several minutes later and with a
# less obvious message.
$(ENV_FILE):
	@echo "deploy/.env is missing. Copy the template and fill it in:"
	@echo "    cp deploy/.env.example deploy/.env"
	@exit 1

up: $(ENV_FILE) ## Bring the stack up (detached), waiting until services are healthy
	$(COMPOSE) up --build --detach --wait
	@echo
	@echo "  studio       http://localhost:$${STUDIO_PORT:-7000}"
	@echo "  bff          http://localhost:$${BFF_PORT:-7001}/healthz"
	@echo "  temporal ui  http://localhost:$${TEMPORAL_UI_PORT:-8233}"

build: $(ENV_FILE) ## Build the images without starting anything
	$(COMPOSE) build

down: ## Stop the stack, keeping the database volume
	$(COMPOSE) down --remove-orphans

logs: ## Follow logs for every service
	$(COMPOSE) logs --follow --tail=100

ps: ## Show each service and its health
	$(COMPOSE) ps

migrate: $(ENV_FILE) ## Apply migrations against the running stack
	$(COMPOSE) run --rm migrate

config: ## Render the resolved compose file (validates syntax and interpolation)
	$(COMPOSE) config

# Destructive, and named so nobody runs it by reflex: `down --volumes` deletes
# the Postgres volume, which is the audit trail as well as the run state.
clean: ## Stop the stack AND DELETE the database volume
	$(COMPOSE) down --remove-orphans --volumes
