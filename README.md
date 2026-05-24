# team-claude

Sessions de **vibe coding collaboratif avec Claude Code** déployées sur
Kubernetes. Le host pilote Claude depuis VS Code / un terminal ; les
participants distants lâchent des messages depuis un navigateur et regardent
la conversation Claude en direct, en lecture seule.

```
                              cluster Kubernetes
┌──────────────────────────────────────────────────────────────────┐
│  Pod session-<name>  (1 PVC partagé, 3 containers)                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ devcontainer      code-server       daemon team-claude-host │ │
│  │ (tmux + claude)   (VS Code browser)  (WS + UI participants  │ │
│  │                                       + stream Claude       │ │
│  │                                       + proxy OAuth)        │ │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
         │                       │                       │
   claude-attach            code-<name>.…          team-<name>.…?token=…
   (host CLI)               (host browser)         (participants browser)
```

| URL/cmd | Pour qui | Niveau de confiance |
|---|---|---|
| `claude-attach` / `tcl attach` | Host (et co-pilotes) | élevé — terminal + filesystem |
| `https://code-<name>.<domain>/` | Devs en mob coding | élevé — IDE + terminal partagés |
| `https://team-<name>.<domain>/?token=…` | Participants externes | bas — read-only stream + drop |

---

## Pré-requis

- Cluster Kubernetes (1.24+) avec :
  - Ingress controller (haproxy/nginx/traefik, configurable)
  - cert-manager avec un ClusterIssuer (DNS-01 idéalement, ou HTTP-01)
  - StorageClass par défaut supportant ReadWriteOnce
  - Wildcard DNS sur le domaine cible (ou DNS par session)
- Helm 3, `kubectl`, `bash`
- Un compte Claude (Pro/Max recommandé) pour le host

## Quick start

### 1. Une fois par cluster — base (namespace + wildcard TLS)

```bash
helm install team-claude-base ./chart/team-claude-base \
  --namespace team-claude --create-namespace \
  --set certificate.domain=shared-coding-session.devthefuture.org \
  --set certificate.issuer.name=letsencrypt-prod
```

Attendre que le Certificate soit Ready (~1-5 min selon le ClusterIssuer) :

```bash
kubectl wait -n team-claude --for=condition=Ready \
  certificate/team-claude-wildcard --timeout=10m
```

### 2. Par session — via le helper `tcl`

```bash
export KUBECONFIG=./kubeconfig                 # ou ton kubeconfig habituel
export TCL_DOMAIN=shared-coding-session.devthefuture.org

./scripts/tcl create demo --user alice --daemon
# (le flag --daemon active l'app participants + le stream Claude pour eux)
```

Attendre le Pod Running (~1-2 min selon les images) :

```bash
kubectl get pod -n team-claude session-demo-0 -w
```

### 3. Authentifier Claude sur le pod (1 seule fois par session)

Le flux le plus fiable (les flow OAuth localhost ne marchent pas en remote) :

```bash
# Sur ta machine locale, where `claude login` fonctionne nativement :
claude login                          # OAuth navigateur classique, écrit ~/.claude/.credentials.json

# Puis depuis n'importe où ayant kubectl + ce repo :
./scripts/tcl auth demo               # copie le credentials.json sur le PVC du pod
                                      # + marque hasCompletedOnboarding + workspace trust
```

Le token vit ensuite sur le PVC, survit aux restarts et est partagé entre tous
les shells attachés au tmux du pod.

### 4. Démarrer la session Claude

```bash
./scripts/tcl attach demo             # joins le tmux partagé où claude tournera
```

Tu te retrouves directement dans le prompt Claude (les onboarding/trust ont été
marqués done à l'étape 3). Le daemon a aussi écrit un `CLAUDE.md` dans
`/workspace` qui briefe Claude sur le contexte collaboratif.

**Prompt de kickoff à envoyer en premier** :

```text
On démarre une session team-claude collaborative.

Lis /workspace/CLAUDE.md et lance immédiatement un Monitor sur
.team-claude/events.jsonl avec `tail -F`. Tu recevras chaque drop
participant comme une notification en temps réel ; intègre-les
naturellement dans la conversation et cite le nom du participant quand
tu en parles.

Confirme-moi quand le Monitor est actif et qu'on peut commencer.
```

Claude lit alors le CLAUDE.md (auto-chargé) et démarre son Monitor. Les
participants apparaîtront dans son flux dès qu'ils enverront un message.

### 5. Partager aux participants

```bash
./scripts/tcl room demo               # imprime l'URL https://team-…?token=…
./scripts/tcl url demo                # imprime l'URL code-server + password (pour les co-pilotes IDE)
```

- **Participants distants** : envoie-leur l'URL de `tcl room` — ils ouvrent
  ça dans n'importe quel navigateur, choisissent un nom, lâchent des
  messages, et voient le stream Claude en temps réel.
- **Co-pilotes IDE** (devs de confiance) : envoie-leur l'URL + password
  de `tcl url`. Ils ont VS Code complet en navigateur ; depuis le
  terminal intégré, ils font `claude-attach` pour rejoindre la même
  session tmux que toi.

---

## Workflow type

```
┌─ HOST ─────────────────┐         ┌─ PARTICIPANTS ──────────────┐
│ ./scripts/tcl attach demo│        │ ouvrent https://team-demo… │
│                          │        │     │                       │
│ Claude up & running     │        │ remplissent Nom + Message  │
│ Monitor actif sur       │◀───────│ → daemon écrit              │
│ events.jsonl            │        │   .team-claude/events.jsonl │
│                          │        │   live.md, state.json      │
│ Claude voit le message  │        │                             │
│ "Alice suggère X"       │        │ Voient la réponse Claude    │
│ → intègre, code, répond│────────▶│ dans le panneau "Claude"    │
│                          │        │ en stream (loader spinner) │
└──────────────────────────┘        └─────────────────────────────┘
```

Quand un participant contredit la direction en cours, Claude (briefé par
`CLAUDE.md`) pause à la fin de l'étape atomique courante, résume le désaccord
en une phrase, et pose 1-2 questions ouvertes. Pas d'arbitrage forcé, pas de
"j'ai encore des arguments" à cocher : tout se passe dans la conversation.

---

## Commandes `tcl`

```text
./scripts/tcl create <name> [--user U] [--repo URL] [--daemon] [--ssh]
                          Installe une nouvelle session via Helm
./scripts/tcl list        Liste les sessions actives
./scripts/tcl attach <name>     Joint le tmux/claude du pod
./scripts/tcl auth <name> [path]   Copie ~/.claude/.credentials.json sur le pod
                                   (workaround OAuth + marque l'onboarding done)
./scripts/tcl url <name>  URL + password code-server
./scripts/tcl room <name> URL + token participants
./scripts/tcl logs <name> [-c container]   Tail des logs
./scripts/tcl destroy <name>  helm uninstall (PVC préservé)
./scripts/tcl purge <name>    destroy + delete PVC (DONNÉES PERDUES)
```

Variables d'env reconnues : `TCL_NAMESPACE`, `TCL_DOMAIN`, `TCL_CHART_DIR`,
`TCL_IMAGE_PULL_SECRET`, `KUBECONFIG`.

---

## Troubleshooting

### "il me redemande de me connecter" même après auth

Trois causes connues, par ordre de fréquence :

1. **`CLAUDE_CODE_OAUTH_TOKEN` env sticky** : si tu l'as `export`é une fois
   dans ton shell tmux, il reste actif et override silencieusement le
   `.credentials.json`. Le wrapper `/usr/local/bin/claude` auto-unset
   maintenant, mais si tu cours le vrai binaire (`/usr/bin/claude`) ça
   bypass le wrapper. Fix : `unset CLAUDE_CODE_OAUTH_TOKEN`.
2. **Vieux process claude bloqué** : si une instance claude était sur le
   login screen avant ton `tcl auth`, elle ne relit pas le disque.
   Fix : `pkill -f claude.exe; claude-attach`.
3. **Onboarding / workspace trust pas marqués** : si tu as setup le pod
   AVANT que `tcl auth` ne patche ces flags, le welcome flow tourne et
   ressemble à un login loop. Fix : `tcl auth demo` (re-run, idempotent).

### Le proxy `/callback` répond 404

C'est que **le hostname est mauvais** : le proxy OAuth vit sur le daemon
(domaine `team-<name>.<domain>`), PAS sur code-server (`code-<name>.…`).
Édite l'URL pour mettre `team-` au lieu de `code-`.

### L'extension Claude Code native dans code-server est cassée

Connu — l'extension Anthropic targets VS Code Desktop, pas le web extension
host. On ne la pré-installe plus. Pour l'UI native : VS Code Desktop avec
l'extension Kubernetes + "Attach Visual Studio Code" sur le Pod. En
navigateur : `claude-attach` dans le terminal intégré.

Recipe d'install manuelle (si tu veux essayer quand même) dans
[chart/team-claude/README.md](chart/team-claude/README.md).

### Stuck dans un éditeur, `Ctrl+Q` capturé par le navigateur

Depuis l'extérieur :

```bash
kubectl exec -n team-claude session-demo-0 -c devcontainer -- \
  tmux -S /home/devbox/.tmux-claude/socket send-keys -t claude-main C-q
```

Ou plus brutal : `kubectl exec … -- pkill -u devbox <editor>`.

---

## Architecture

3 images publiées sur `ghcr.io/devthefuture-org/`, toutes rootless (USER 1000),
pinnées :

| Image | Source | Base | Tag courant |
|---|---|---|---|
| `team-claude-devcontainer` | [images/devcontainer/](images/devcontainer/) | `jetpackio/devbox:0.17.2` | claude CLI `2.1.150` + tmux + toolchain dev (gh/jq/yq/kubectl/helm/k9s/go/node/devbox/direnv) |
| `team-claude-code-server` | [images/code-server/](images/code-server/) | `codercom/code-server:4.121.0` (VS Code 1.121) | + claude CLI + tmux + extension team-claude pré-installée (notre extension custom, pas celle d'Anthropic) |
| `team-claude-host` | [daemon/](daemon/) | `node:20.20-alpine3.22` | daemon WS + UI + stream Claude + OAuth proxy |

Chart Helm : voir [chart/team-claude/README.md](chart/team-claude/README.md)
pour le détail des values, la `team-claude-base` pour le wildcard cert, et
les patterns multi-tenant.

Plan d'architecture historique : [team_claude_code_plan_architecture.md](team_claude_code_plan_architecture.md)
+ [.agent/session/CONTEXT_BRIEF.md](.agent/session/CONTEXT_BRIEF.md) pour
l'état courant.

## Build & CI

GitHub Actions builde les 3 images en matrix sur chaque push qui touche
`images/devcontainer/`, `images/code-server/`, `daemon/` ou `extension/`,
les pousse sur `ghcr.io/devthefuture-org/`, et valide le chart en parallèle
(`helm lint` + `kubeconform -strict`).

```bash
make chart-lint                       # helm lint
make chart-validate                   # full config rendered + kubeconform
make image-build IMAGE_DIR=images/devcontainer  # local build
```

## License

À définir.
