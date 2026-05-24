# team-claude

Sessions de **vibe coding collaboratif avec Claude Code** déployées sur
Kubernetes. Le host pilote Claude depuis VS Code ou un terminal ; les
participants distants lâchent des messages depuis un navigateur et regardent
la conversation Claude en direct, en lecture seule.

```
Pod session-<name>  ·  1 PVC partagé  ·  3 containers
┌──────────────────────┬──────────────────────┬──────────────────────┐
│   devcontainer       │   code-server        │   team-claude-host   │
│   tmux + claude CLI  │   VS Code navigateur │   WS + UI + stream   │
└──────────────────────┴──────────────────────┴──────────────────────┘
        │                       │                       │
  claude-attach            code-<name>.…          team-<name>.…?token=…
  (host CLI)               (host browser)         (participants browser)
```

| URL / commande | Pour qui | Confiance |
|---|---|---|
| `tcl attach` | Host & co-pilotes | élevée — terminal + filesystem |
| `https://code-<name>.<domain>/` | Devs en mob coding | élevée — IDE + terminal partagés |
| `https://team-<name>.<domain>/?token=…` | Participants externes | basse — read-only + drop messages |

---

## Pré-requis

- Cluster Kubernetes 1.24+ avec ingress (haproxy / nginx / traefik), cert-manager
  + ClusterIssuer, StorageClass `ReadWriteOnce`, wildcard DNS.
- Helm 3, `kubectl`, `bash`.
- Compte Claude (Pro / Max recommandé) pour le host.

## Getting started

### 1. Cluster (une fois)

```bash
helm install team-claude-base ./chart/team-claude-base \
  --namespace team-claude --create-namespace \
  --set certificate.domain=<your-domain> \
  --set certificate.issuer.name=letsencrypt-prod

kubectl wait -n team-claude --for=condition=Ready \
  certificate/team-claude-wildcard --timeout=10m
```

### 2. Session

```bash
export KUBECONFIG=./kubeconfig
export TCL_DOMAIN=<your-domain>

./scripts/tcl create demo --user alice --daemon
kubectl get pod -n team-claude session-demo-0 -w   # attendre Running
```

Le flag `--daemon` active l'app participants + le stream Claude.

### 3. Auth Claude sur le pod

Les flow OAuth localhost ne marchent pas en remote — on copie le credential local :

```bash
claude login                # localement, écrit ~/.claude/.credentials.json
./scripts/tcl auth demo     # copie sur le PVC + marque onboarding/trust done
```

Le token vit sur le PVC, survit aux restarts.

### 4. Démarrer Claude & partager

```bash
./scripts/tcl attach demo   # tmux partagé, prompt Claude prêt
./scripts/tcl room demo     # → URL https://team-…?token=…  (participants)
./scripts/tcl url demo      # → URL code-server + password   (co-pilotes IDE)
```

Premier prompt à envoyer à Claude :

```text
Lis /workspace/CLAUDE.md et lance un Monitor sur .team-claude/events.jsonl
avec `tail -F`. Tu recevras chaque drop participant comme une notification ;
intègre-les naturellement et cite le nom du participant. Confirme quand
le Monitor est actif.
```

Le `CLAUDE.md` (auto-écrit dans `/workspace` au boot du daemon) briefe Claude
sur le contexte collaboratif (pause sur contradiction, ne pas forcer le
consensus, etc.).

---

## Workflow

```
HOST                                  PARTICIPANTS
─────                                 ────────────
tcl attach → claude up                ouvrent https://team-demo…?token=…
Monitor sur events.jsonl              remplissent Nom + Message
  │                                     │
  ▼                                     ▼
Claude voit "Alice suggère X" ◀──── daemon append events.jsonl
intègre, code, répond           ────▶ stream Claude live (spinner)
```

Quand un participant contredit la direction en cours, Claude pause à la fin
de l'étape atomique courante, résume le désaccord, pose 1-2 questions
ouvertes. Pas d'arbitrage forcé : tout passe par la conversation.

## Commandes `tcl`

```text
tcl create <name> [--user U] [--repo URL] [--daemon] [--ssh]
tcl list
tcl attach <name>             joint le tmux/claude du pod
tcl auth   <name> [path]      copie ~/.claude/.credentials.json sur le pod
tcl url    <name>             URL + password code-server
tcl room   <name>             URL + token participants
tcl logs   <name> [-c ctn]
tcl destroy <name>            helm uninstall (PVC préservé)
tcl purge   <name>            destroy + delete PVC (DONNÉES PERDUES)
```

Env reconnues : `TCL_NAMESPACE`, `TCL_DOMAIN`, `TCL_CHART_DIR`,
`TCL_IMAGE_PULL_SECRET`, `KUBECONFIG`.

## Troubleshooting

- **Login loop après `tcl auth`** — soit `CLAUDE_CODE_OAUTH_TOKEN` est sticky
  dans le shell (`unset` + relance), soit un vieux process claude tourne sur
  le login screen (`pkill -f claude.exe; claude-attach`), soit l'onboarding /
  workspace trust n'avait pas été patché (re-run `tcl auth` — idempotent).
- **`/callback` répond 404** — le proxy OAuth vit sur `team-<name>.…`, pas
  `code-<name>.…`. Édite l'URL pour mettre `team-`.
- **Extension Anthropic Claude cassée dans code-server** — connu (extension
  cible VS Code Desktop, pas web host). On ne la pré-installe plus ; passe
  par `claude-attach` dans le terminal intégré. Recipe d'install manuelle
  dans [chart/team-claude/README.md](chart/team-claude/README.md).
- **Stuck dans un éditeur (Ctrl+Q capturé par le navigateur)** :
  ```bash
  kubectl exec -n team-claude session-demo-0 -c devcontainer -- \
    tmux -S /home/devbox/.tmux-claude/socket send-keys -t claude-main C-q
  ```

## Architecture

3 images publiées sur `ghcr.io/devthefuture-org/`, rootless (USER 1000) :

| Image | Source | Base |
|---|---|---|
| `team-claude-devcontainer` | [images/devcontainer/](images/devcontainer/) | `jetpackio/devbox:0.17.2` + claude CLI + tmux + toolchain dev |
| `team-claude-code-server`  | [images/code-server/](images/code-server/)  | `codercom/code-server:4.121.0` + claude CLI + tmux + extension team-claude |
| `team-claude-host`         | [daemon/](daemon/)                          | `node:20.20-alpine3.22` — WS daemon + UI + stream Claude + OAuth proxy |

Voir [chart/team-claude/README.md](chart/team-claude/README.md) pour le détail
des values Helm et les patterns multi-tenant.

## Build & CI

GitHub Actions builde les 3 images en matrix sur push qui touche
`images/*`, `daemon/` ou `extension/`, push sur `ghcr.io/devthefuture-org/`,
+ `helm lint` + `kubeconform -strict` sur le chart.

```bash
make chart-lint
make chart-validate
make image-build IMAGE_DIR=images/devcontainer
```

## License

À définir.
