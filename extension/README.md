# team-claude — VS Code extension

Live participant feed + quick actions for collaborative Claude Code sessions powered by the [team-claude](https://github.com/devthefuture-org/team-claude) Helm chart.

## What it does

- Adds a **team-claude** view in the Activity Bar.
- Connects to the in-pod daemon via WebSocket (`ws://localhost:7000/ws` by default; same Pod = same network namespace).
- Shows live participants + recent contributions.
- Lets the host send presence / status / contribution messages directly from the sidebar (alternative to the public web app at `team-<session>.<domain>`).
- Commands: `team-claude: Ouvrir live.md`, `team-claude: Copier le prompt initial`, `team-claude: Reconnecter`.

## Activation

Auto-activated when the workspace contains `.team-claude/live.md` or `.team-claude/config.json`. Otherwise dormant.

## Configuration

Reads from env vars on the extension host process:

| Env var | Default | Purpose |
|---|---|---|
| `TEAM_CLAUDE_WS_URL` | `ws://localhost:7000/ws` | Daemon WebSocket endpoint |
| `TEAM_CLAUDE_TOKEN` (or `ROOM_TOKEN`) | none (required) | Room token to authenticate |
| `SESSION_NAME` | `session` | Cosmetic label |

The team-claude Helm chart injects these automatically into the code-server container.

## Build a `.vsix` locally

```bash
cd extension/
npm install
npx @vscode/vsce package --no-yarn --skip-license --out team-claude.vsix
```
