# ADR 0001 — IDE delivery: stay on code-server, defer Coder

- **Status:** Accepted
- **Date:** 2026-06-01
- **Deciders:** project owner (devthejo), Claude
- **Supersedes / superseded by:** —

## Context

team-claude delivers collaborative "vibe coding" sessions. Each session is **one
StatefulSet pod** provisioned by a Helm release (`session-<name>`), with three
containers sharing a PVC:

- **devcontainer** — tmux + the `claude` CLI (the host runs Claude here).
- **code-server** — the browser IDE for co-pilots, plus its integrated terminal.
- **daemon** — Node WS server that tails Claude's transcript and serves the
  participant stream, the admin dashboard, and the invite flow.

The collaborative layer (shared tmux session, transcript streaming, invite codes,
per-participant access, read-only participant view) is **bespoke and is the
project's actual differentiator**. The IDE is just one swappable component.

The question raised: *should we move from code-server to
[coder/coder](https://github.com/coder/coder) (Coder v2)?*

These are **different categories of tool**:

- **code-server** = a single browser-IDE binary/container. It is one box in the pod.
- **Coder v2** = a **workspace-orchestration platform**: a control plane (`coderd`)
  + Postgres + Terraform *templates* + a per-workspace *agent* + a WireGuard/Tailscale
  mesh. It owns provisioning, auth, IDE delivery, lifecycle, and networking.

## Decision drivers

- Keep the current "**helm install → one pod → done, nothing always-on**" simplicity.
- Preserve full control over the bespoke collaborative model (tmux + daemon + invites).
- Keep operational/maintenance surface small for what is still an early-stage project.
- Don't paint ourselves into a corner: keep the IDE layer easy to swap later.

## Considered options

### 1. Keep code-server (chosen)
A single container, configured in the chart. No platform, no extra always-on service.

### 2. Swap to openvscode-server (light, future)
Image-level swap (`codeServer.image.repository`), no architectural change. Frees us
from code-server's marketplace/licensing constraints. Low risk. Already noted as a
later phase. **This is the recommended *intermediate* step if/when we want to move.**

### 3. Adopt Coder v2 (deferred)
Run `coderd` + Postgres; model a "session" as a Coder **workspace** via a Terraform
template that provisions our pod (devcontainer + daemon + code-server as a
`coder_app`) with the Coder agent injected. The daemon/invite layer stays as-is.

## Decision

**Stay on a single code-server container for now.** Keep the IDE layer decoupled
(separate image + Service, already the case) so a later move costs mostly a template,
not a rewrite. If we want to evolve the IDE, take the **openvscode-server** swap first.
**Re-evaluate Coder only when the triggers below are hit**, via a parallel POC that
keeps the daemon/invites intact.

### Re-evaluate Coder when we need
- A **multi-user platform** (many users, many self-served workspaces) rather than
  ephemeral shared rooms.
- **Choice of IDE** (JetBrains, VS Code Desktop over SSH) beyond the browser.
- **SSO / RBAC / audit** as first-class, and fleet features (autostop/scheduling,
  dashboards, templated provisioning).

## Consequences

### What Coder *would* buy us (the upside we're deferring)
- Multi-IDE delivery (code-server **and** JetBrains **and** Desktop-over-SSH **and** web terminal).
- Native OIDC SSO, RBAC, audit logs.
- Agent-based networking (WireGuard) that would **remove the localhost OAuth-callback
  hacks** the project currently carries.
- Lifecycle: autostop/autostart, templated (Terraform) provisioning, dashboard,
  port-forwarding, and "Coder apps" (we could surface the participant stream as one).

### What staying on code-server keeps us from (the cost of *not* moving)
- We continue to hand-roll auth/access, IDE delivery is browser-only, and we own the
  networking/OAuth-callback plumbing.

### Effort to adopt Coder (rough, technical time only)

A **parallel POC** (one template, daemon/invites kept, code-server as the IDE app):

| Work item | Estimate |
|---|---|
| Stand up `coderd` + Postgres (Helm), TLS, base config | 1–2 d |
| Author the Coder template (Terraform): reproduce the pod, inject the Coder agent, wire env (ROOM_TOKEN, SESSION_NAME, PVC subPaths), code-server as `coder_app` | 2–4 d |
| Re-plumb the collaborative layer into the workspace lifecycle (how a "session" maps to a workspace; invites vs Coder workspace-sharing) | 2–3 d |
| Auth model reconciliation (host / participants / Coder users + RBAC) — design-heavy | 1–3 d |
| Networking (agent tunnel) validation on a restricted cluster + ingress for stream/admin | 1–2 d |
| Testing, docs, migrating existing sessions | 2–3 d |
| **POC total** | **~1–1.5 weeks** |

**Production-grade** on top of the POC (HA `coderd`, Postgres backups, upgrade runbook,
multi-user RBAC, autostop policies): **+1–2 weeks**.

**Steady-state maintenance:** `coderd` upgrades (roughly monthly cadence upstream),
Postgres ops/backups, **coderd↔agent version coupling**, and template upkeep — call it
a few days/quarter plus a larger incident surface than "a pod with three containers".

### Loss of control / flexibility under Coder
- **Opinionated workspace model.** A Coder workspace is **single-owner**; our
  *shared-room* semantics (one tmux + daemon + read-only participants) don't map
  natively. We'd keep building the collaborative layer ourselves — so the gain is
  *partial* (IDE delivery + provisioning + access-auth), not a replacement.
- **Indirection in provisioning.** Today we control every StatefulSet field directly
  (PVC subPath layout, the OAuth-proxy sidecar, exact `securityContext`). Under Coder
  those must be re-expressed through the template/provider resource model and may hit
  template constraints; we trade "kubectl/helm, I own every field" for Coder's abstraction.
- **Lifecycle ownership.** Coder drives build/rebuild/autostop. That can **fight our
  hard constraint** "*never restart the whole pod or we kill the live tmux Claude
  session*" — Coder's rebuild state machine is less surgical than our targeted
  per-container restarts.
- **Networking through Coder's mesh.** We lose the simple `Ingress → Service → pod`
  mental model; debugging goes through the agent/tunnel layer.
- **Version coupling.** Base-image/agent must stay compatible with `coderd`; less
  freedom to pin arbitrary images.
- **New stateful source of truth.** Postgres becomes something to back up and operate;
  today our state is just files on the PVC (simpler, more portable).
- **Platform lock-in.** Concepts and templates are Coder-specific; there's an exit cost later.

## Related
- Light intermediate step: openvscode-server (image swap) — see
  `chart/team-claude/values.yaml` (`codeServer.image`).
- The collaborative layer (daemon/invites/stream) is orthogonal to this decision and
  would survive any IDE/platform change.
