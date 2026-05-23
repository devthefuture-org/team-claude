# team-claude Helm chart

Multi-tenant collaborative Claude Code session, deployable on any existing Kubernetes cluster.

Each Helm release = one isolated session = one Pod containing:

- `devcontainer` — devbox image + tmux + Claude Code CLI (tmux session is the source of truth)
- `code-server` — VS Code in the browser (optional, on by default)
- `daemon` — team-claude-host WebSocket server + participants web app (optional, off by default — comes in Phase 4 of the roadmap)

All containers share a single `ReadWriteOnce` PVC, so they see the same filesystem and the same tmux socket.

## Prerequisites

- Kubernetes cluster (any recent version).
- Helm 3.
- An Ingress controller (nginx, traefik, etc.) — set `ingress.className`.
- cert-manager with a ClusterIssuer — set `ingress.tls.clusterIssuer`. (Or disable TLS with `ingress.tls.enabled=false` for a local test.)
- A default StorageClass on the cluster — set `persistence.storageClassName` to override.
- A wildcard DNS / cert for `*.<domain>` if you want subdomain-per-session (default behaviour). Otherwise set `hosts.codeServer` / `hosts.daemon` explicitly to a single FQDN.

## Quickstart

### Phase 1 — minimal devcontainer only (kubectl exec access)

```bash
helm install session-demo ./chart/team-claude \
  --namespace team-claude --create-namespace \
  --set session.name=demo \
  --set session.user=alice \
  --set codeServer.enabled=false \
  --set daemon.enabled=false \
  --set ingress.enabled=false \
  --set networkPolicy.enabled=false

kubectl exec -it -n team-claude session-demo-0 -c devcontainer -- claude-attach
```

### Phase 2 — + code-server + Ingress

```bash
helm install session-demo ./chart/team-claude \
  --namespace team-claude --create-namespace \
  --set session.name=demo \
  --set session.user=alice \
  --set domain=team.example.com \
  --set ingress.className=nginx \
  --set ingress.tls.clusterIssuer=letsencrypt-prod
```

Then:

```bash
# Retrieve URL and password
kubectl get secret -n team-claude session-demo-auth -o jsonpath='{.data.codeServerPassword}' | base64 -d
```

Open `https://code-demo.team.example.com` and enter the password.

### Phase 4 — + collaboration daemon

```bash
helm install session-demo ./chart/team-claude \
  --namespace team-claude --create-namespace \
  --set session.name=demo \
  --set domain=team.example.com \
  --set daemon.enabled=true
```

Retrieve the participant room URL:

```bash
kubectl get secret -n team-claude session-demo-auth -o jsonpath='{.data.roomUrl}' | base64 -d
```

## Lifecycle

```bash
# List sessions
helm list -n team-claude

# Upgrade (rolling, PVC preserved)
helm upgrade session-demo ./chart/team-claude -n team-claude --set ...

# Destroy (PVC is kept, has helm.sh/resource-policy: keep)
helm uninstall session-demo -n team-claude

# Reinstall with same name → reattaches existing PVC
helm install session-demo ./chart/team-claude -n team-claude --set session.name=demo ...

# Delete the PVC permanently
kubectl delete pvc -n team-claude session-demo-data
```

## Key values

See [values.yaml](values.yaml) for the full reference. Highlights:

| Key | Default | Notes |
|---|---|---|
| `session.name` | release name | Used to derive resource names and host subdomains |
| `domain` | `example.com` | Base domain; combined with `session.name` to form Ingress hosts |
| `hosts.codeServer` | `""` | Override the computed `code-<session>.<domain>` host |
| `hosts.daemon` | `""` | Override the computed `team-<session>.<domain>` host |
| `ingress.className` | `nginx` | Set to match your cluster's controller |
| `ingress.tls.clusterIssuer` | `letsencrypt-prod` | cert-manager ClusterIssuer name |
| `persistence.size` | `20Gi` | PVC size |
| `persistence.storageClassName` | `""` | Leave empty for cluster default |
| `codeServer.enabled` | `true` | Toggle code-server container |
| `daemon.enabled` | `false` | Toggle team-claude-host container (Phase 4) |
| `ssh.enabled` | `false` | Enable in-pod sshd (requires `runAsUser: 0`, see notes) |
| `auth.codeServerPassword` | auto | Provide to fix the code-server password |
| `auth.roomToken` | auto | Provide to fix the daemon room token |

## SSH access (Phase 2 optional)

`ssh.enabled=true` runs the devcontainer container as root so sshd can bind to port 22. Provide public keys via `ssh.authorizedKeys`. The SSH Service is `ClusterIP` by default — reach it with `kubectl port-forward`:

```bash
kubectl port-forward -n team-claude svc/session-demo-ssh 2222:22
ssh -p 2222 devbox@localhost
```

For external SSH access, switch `ssh.serviceType` to `NodePort` or `LoadBalancer`.

## Validation

```bash
helm lint chart/team-claude/
helm template test chart/team-claude/ --set session.name=demo --set domain=example.com | kubeconform -summary -strict -ignore-missing-schemas
```
