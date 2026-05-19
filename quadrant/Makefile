
# ==============================================================================
# Installation & Setup
# ==============================================================================

# Install dependencies using uv package manager
install:
	@command -v uv >/dev/null 2>&1 || { echo "uv is not installed. Installing uv..."; curl -LsSf https://astral.sh/uv/0.8.13/install.sh | sh; source $HOME/.local/bin/env; }
	uv sync

# ==============================================================================
# Playground Targets
# ==============================================================================

# Launch local dev playground
playground:
	@echo "==============================================================================="
	@echo "| 🚀 Starting your agent playground...                                        |"
	@echo "|                                                                             |"
	@echo "| 💡 Try asking: What's the weather in San Francisco?                         |"
	@echo "|                                                                             |"
	@echo "| 🔍 IMPORTANT: Select the 'app' folder to interact with your agent.          |"
	@echo "==============================================================================="
	uv run adk web . --port 8501 --reload_agents

# ==============================================================================
# Local Development Commands
# ==============================================================================

# Launch local development server with hot-reload
# Usage: make local-backend [PORT=8000] - Specify PORT for parallel scenario testing
local-backend:
	uv run uvicorn app.fast_api_app:app --host localhost --port $(or $(PORT),8000) --reload

# ==============================================================================
# Backend Deployment Targets
# ==============================================================================

# Deploy the agent remotely
# Usage: make deploy [IAP=true] [PORT=8080] - Set IAP=true to enable Identity-Aware Proxy, PORT to specify container port
deploy:
	PROJECT_ID=$$(gcloud config get-value project) && \
	gcloud beta run deploy quadrant \
		--source . \
		--memory "4Gi" \
		--project $$PROJECT_ID \
		--region "us-central" \
		--no-allow-unauthenticated \
		--no-cpu-throttling \
		--labels "created-by=adk" \
		--update-build-env-vars "AGENT_VERSION=$(shell awk -F'"' '/^version = / {print $$2}' pyproject.toml || echo '0.0.0')" \
		--update-env-vars \
		"" \
		$(if $(IAP),--iap) \
		$(if $(PORT),--port=$(PORT))

# Alias for 'make deploy' for backward compatibility
backend: deploy

# ==============================================================================
# Drive Doc Classifier — Cloud Run Job + Cloud Scheduler
# ==============================================================================
#
# `classify_drive_documents.py` is incremental (only re-classifies docs where
# modified_time > ingested_at), so it's safe to run on a schedule. We deploy
# it as a Cloud Run JOB (run-to-completion, not a long-lived service), then
# trigger it every N minutes via Cloud Scheduler hitting the job's run endpoint.
#
# Reuses the agent's Dockerfile — the job container overrides CMD to invoke
# the classifier instead of uvicorn. So no second image to maintain.
#
# Usage:
#   make deploy-classifier            # build + deploy / update the job
#   make schedule-classifier          # one-time: wire Cloud Scheduler → job
#   make run-classifier-now           # manual one-off trigger (for testing)

CLASSIFIER_JOB_NAME = quadrant-classify-drive
CLASSIFIER_REGION   = us-central1
CLASSIFIER_SCHEDULE = */15 * * * *   # every 15 minutes

deploy-classifier:
	PROJECT_ID=$$(gcloud config get-value project) && \
	gcloud run jobs deploy $(CLASSIFIER_JOB_NAME) \
		--source . \
		--region $(CLASSIFIER_REGION) \
		--project $$PROJECT_ID \
		--memory 2Gi \
		--task-timeout 900s \
		--max-retries 1 \
		--command="uv" \
		--args="run","python","-m","app.classify_drive_documents" \
		--labels "created-by=quadrant,role=classifier"

# Trigger an ad-hoc run — useful right after deploy to verify the job works.
run-classifier-now:
	PROJECT_ID=$$(gcloud config get-value project) && \
	gcloud run jobs execute $(CLASSIFIER_JOB_NAME) \
		--region $(CLASSIFIER_REGION) \
		--project $$PROJECT_ID \
		--wait

# Cloud Scheduler hits Cloud Run's REST API. Needs a service account with
# `roles/run.invoker` on the job. We use the default Compute service account
# (already exists in every project) and grant it that role.
schedule-classifier:
	PROJECT_ID=$$(gcloud config get-value project) && \
	PROJECT_NUMBER=$$(gcloud projects describe $$PROJECT_ID --format="value(projectNumber)") && \
	SA="$$PROJECT_NUMBER-compute@developer.gserviceaccount.com" && \
	echo "Granting run.invoker on the job to $$SA..." && \
	gcloud run jobs add-iam-policy-binding $(CLASSIFIER_JOB_NAME) \
		--region $(CLASSIFIER_REGION) \
		--project $$PROJECT_ID \
		--member "serviceAccount:$$SA" \
		--role "roles/run.invoker" && \
	echo "Creating scheduler job..." && \
	gcloud scheduler jobs create http $(CLASSIFIER_JOB_NAME)-schedule \
		--location $(CLASSIFIER_REGION) \
		--project $$PROJECT_ID \
		--schedule "$(CLASSIFIER_SCHEDULE)" \
		--uri "https://$(CLASSIFIER_REGION)-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$$PROJECT_ID/jobs/$(CLASSIFIER_JOB_NAME):run" \
		--http-method POST \
		--oauth-service-account-email "$$SA" \
		--time-zone "America/Los_Angeles" \
		--description "Re-classify new/changed Drive docs every 15 min"

# ==============================================================================
# Testing & Code Quality
# ==============================================================================

# Run unit and integration tests
test:
	uv sync --dev
	uv run pytest tests/unit && uv run pytest tests/integration

# ==============================================================================
# Agent Evaluation
# ==============================================================================

# Run agent evaluation using ADK eval
# Usage: make eval [EVALSET=tests/eval/evalsets/basic.evalset.json] [EVAL_CONFIG=tests/eval/eval_config.json]
eval:
	@echo "==============================================================================="
	@echo "| Running Agent Evaluation                                                    |"
	@echo "==============================================================================="
	uv sync --dev --extra eval
	uv run adk eval ./app $${EVALSET:-tests/eval/evalsets/basic.evalset.json} \
		$(if $(EVAL_CONFIG),--config_file_path=$(EVAL_CONFIG),$(if $(wildcard tests/eval/eval_config.json),--config_file_path=tests/eval/eval_config.json,))

# Run evaluation with all evalsets
eval-all:
	@echo "==============================================================================="
	@echo "| Running All Evalsets                                                        |"
	@echo "==============================================================================="
	@for evalset in tests/eval/evalsets/*.evalset.json; do \
		echo ""; \
		echo "▶ Running: $$evalset"; \
		$(MAKE) eval EVALSET=$$evalset || exit 1; \
	done
	@echo ""
	@echo "✅ All evalsets completed"

# Run code quality checks (codespell, ruff, ty)
lint:
	uv sync --dev --extra lint
	uv run codespell
	uv run ruff check . --diff
	uv run ruff format . --check --diff
	uv run ty check .