REGISTRY    ?= ghcr.io/devthejo
IMAGE       := $(REGISTRY)/team-claude-devcontainer
TAG         ?= 0.1.0
CHART_DIR   := chart/team-claude
IMAGE_DIR   := images/devcontainer
NAMESPACE   ?= team-claude
SESSION     ?= demo
DOMAIN      ?= team.example.com

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: image-build
image-build: ## Build the devcontainer image
	docker build -t $(IMAGE):$(TAG) -t $(IMAGE):latest $(IMAGE_DIR)

.PHONY: image-push
image-push: ## Push the devcontainer image to the registry
	docker push $(IMAGE):$(TAG)
	docker push $(IMAGE):latest

.PHONY: image-run
image-run: ## Run the image locally (smoke test, no PVC, no SSH)
	docker run --rm -it \
	  -e ENABLE_SSH=false \
	  -e TMUX_SOCKET=/home/devbox/.tmux-claude/socket \
	  $(IMAGE):$(TAG)

.PHONY: chart-lint
chart-lint: ## Lint the Helm chart
	helm lint $(CHART_DIR)

HELM_TEMPLATE = helm template $(SESSION) $(CHART_DIR) \
  --namespace $(NAMESPACE) \
  --set session.name=$(SESSION) \
  --set domain=$(DOMAIN)

.PHONY: chart-template
chart-template: ## Render chart templates with example values
	$(HELM_TEMPLATE)

.PHONY: chart-validate
chart-validate: ## Validate rendered manifests against K8s schemas (full config)
	$(HELM_TEMPLATE) \
	  --set daemon.enabled=true \
	  --set ssh.enabled=true \
	  --set "ssh.authorizedKeys[0]=ssh-ed25519 AAAAtest test@host" \
	  | kubeconform -summary -strict -ignore-missing-schemas

.PHONY: install-phase1
install-phase1: ## Phase 1 install (devcontainer only, kubectl exec access)
	helm upgrade --install session-$(SESSION) $(CHART_DIR) \
	  --namespace $(NAMESPACE) --create-namespace \
	  --set session.name=$(SESSION) \
	  --set codeServer.enabled=false \
	  --set daemon.enabled=false \
	  --set ingress.enabled=false \
	  --set networkPolicy.enabled=false

.PHONY: install-phase2
install-phase2: ## Phase 2 install (+ code-server + Ingress)
	helm upgrade --install session-$(SESSION) $(CHART_DIR) \
	  --namespace $(NAMESPACE) --create-namespace \
	  --set session.name=$(SESSION) \
	  --set domain=$(DOMAIN)

.PHONY: uninstall
uninstall: ## helm uninstall (PVC kept)
	helm uninstall session-$(SESSION) -n $(NAMESPACE)

.PHONY: attach
attach: ## Attach to the tmux/claude session in the running pod
	kubectl exec -it -n $(NAMESPACE) session-$(SESSION)-0 -c devcontainer -- claude-attach

.PHONY: password
password: ## Print the code-server password
	@kubectl get secret -n $(NAMESPACE) session-$(SESSION)-auth -o jsonpath='{.data.codeServerPassword}' | base64 -d; echo

.PHONY: room-url
room-url: ## Print the participants room URL
	@kubectl get secret -n $(NAMESPACE) session-$(SESSION)-auth -o jsonpath='{.data.roomUrl}' | base64 -d; echo

.PHONY: logs
logs: ## Tail logs from the devcontainer
	kubectl logs -f -n $(NAMESPACE) session-$(SESSION)-0 -c devcontainer
