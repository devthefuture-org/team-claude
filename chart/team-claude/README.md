# team-claude Helm chart

Multi-tenant collaborative Claude Code session, deployable on any existing Kubernetes cluster.

Each Helm release = one isolated session = one Pod containing:

- `devcontainer` — devbox image + tmux + Claude Code CLI (tmux session = source of truth, survives client disconnects).
- `code-server` — VS Code in the browser (on by default).
- `daemon` — team-claude-host WebSocket server + participants web app (off by default; turn on with `--set daemon.enabled=true`).

All containers share a single `ReadWriteOnce` PVC. The tmux socket lives on the PVC so the devcontainer's session is reachable from the other containers' shells.

## Prerequisites

- Kubernetes cluster (1.24+).
- Helm 3.
- Ingress controller (nginx, traefik, haproxy, ...). Set `ingress.className` to match.
- cert-manager — for the wildcard TLS cert (see `team-claude-base` chart).
- A default StorageClass that supports `ReadWriteOnce`.
- Wildcard DNS for `*.<domain>` pointing at the ingress.

## Two-chart layout

1. **`team-claude-base`** — install **once per cluster**. Creates the namespace and a wildcard TLS Certificate via cert-manager. Sessions reuse that single cert (avoids hitting the Let's Encrypt 50-certs-per-domain-per-week limit).
2. **`team-claude`** (this chart) — install **once per session**.

```bash
# One-shot, per cluster
helm install team-claude-base ./chart/team-claude-base \
  --namespace team-claude --create-namespace \
  --set certificate.domain=shared-coding-session.devthefuture.org

# Per session (repeat for each session you want)
helm install session-demo ./chart/team-claude \
  --namespace team-claude \
  --set session.name=demo \
  --set session.user=alice \
  --set domain=shared-coding-session.devthefuture.org \
  --set devcontainer.image.tag=latest \
  --set daemon.enabled=true
```

The repo ships a [`scripts/tcl`](../../scripts/tcl) helper that wraps this into one-liners: `tcl create demo --daemon`, `tcl url demo`, `tcl room demo`, `tcl attach demo`, `tcl destroy demo`, …

## Phased turn-on

The same chart supports incremental enablement of features:

```bash
# Phase 1 — devcontainer only (kubectl exec access, no ingress)
helm install session-demo ./chart/team-claude \
  --set session.name=demo \
  --set codeServer.enabled=false \
  --set daemon.enabled=false \
  --set ingress.enabled=false \
  --set networkPolicy.enabled=false

# Phase 2 — + code-server + Ingress
helm install session-demo ./chart/team-claude \
  --set session.name=demo \
  --set domain=shared-coding-session.devthefuture.org

# Phase 4 — + collaboration daemon
helm install session-demo ./chart/team-claude \
  --set session.name=demo \
  --set domain=shared-coding-session.devthefuture.org \
  --set daemon.enabled=true
```

## Access patterns

| Mode | Cmd / URL | Notes |
|---|---|---|
| Editor in browser | `https://code-<session>.<domain>/` | code-server, password = `tcl url <session>` |
| Editor in VS Code Desktop | "Attach Visual Studio Code" via Kubernetes extension on `session-<name>-0` | direct to the devcontainer container, full DX |
| Terminal / claude CLI | `kubectl exec -it … -c devcontainer -- claude-attach` (or `tcl attach <name>`) | attaches the persistent tmux session |
| SSH (Phase 2 optional) | `tcl create <name> --ssh` + provide `--set ssh.authorizedKeys[0]=…` | port 22 via Service (default ClusterIP — port-forward to reach) |
| Participants web app | `https://team-<session>.<domain>/?token=<…>` | URL printed by `tcl room <name>` |

## Lifecycle

```bash
helm list -n team-claude                # list sessions
helm upgrade <release> ./chart/team-claude --set …    # rolling upgrade, PVC kept
helm uninstall <release> -n team-claude               # PVC kept (Retain)
kubectl delete pvc -n team-claude <release>-data      # permanently delete data
```

## Key values

See [values.yaml](values.yaml) for the full reference. Highlights:

| Key | Default | Notes |
|---|---|---|
| `session.name` | `""` (release name) | Used to derive resource names + host subdomains |
| `domain` | `example.com` | Composed into `code-<session>.<domain>` and `team-<session>.<domain>` |
| `hosts.codeServer` / `hosts.daemon` | `""` | Override the computed host |
| `ingress.className` | `haproxy` | Match your cluster |
| `ingress.tls.secretName` | `team-claude-wildcard-tls` | Shared TLS secret from team-claude-base |
| `ingress.tls.clusterIssuer` | `""` | Empty = reuse shared secret; set to a name to issue per-session |
| `persistence.size` | `20Gi` | PVC size, Retain reclaim |
| `codeServer.enabled` | `true` | Toggle code-server container |
| `daemon.enabled` | `false` | Toggle collaboration daemon |
| `ssh.enabled` | `false` | Run sshd in devcontainer (requires `runAsUser: 0`) |
| `imagePullSecrets` | `[]` | For private GHCR/registries |
| `auth.codeServerPassword` / `auth.roomToken` | auto | Auto-generated, preserved across upgrades via `lookup` |

## Resilience

| Event | Survives? | Recovery |
|---|---|---|
| Client disconnect / laptop closed | ✅ | Reconnect; tmux session in pod is still there |
| Pod restart | ⚠️ (tmux dies) | tmux-continuum auto-restores from PVC snapshot (~5 min cadence) |
| Pod reschedule | ✅ | PVC follows pod, tmux-continuum restores |
| Helm upgrade | ✅ | StatefulSet rolling update |
| Helm uninstall | ⚠️ (Pod gone) | PVC `helm.sh/resource-policy: keep` → reinstall reuses data |
| Node loss | ✅ (with PVC available) | Reschedules, restores |
| Cluster loss | ❌ | Use Velero / VolumeSnapshots at cluster level |

## Validation

```bash
helm lint chart/team-claude
helm template demo chart/team-claude --set session.name=demo --set domain=example.com \
  | kubeconform -summary -strict -ignore-missing-schemas
```
