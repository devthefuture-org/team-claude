FROM node:20.20-alpine3.22 AS ext-build
WORKDIR /ext
COPY extension/package.json ./
RUN npm install --no-audit --no-fund
COPY extension/extension.js extension/README.md ./
COPY extension/media ./media
RUN npx --yes @vscode/vsce package --no-yarn --skip-license --out /ext/team-claude.vsix

FROM codercom/code-server:4.121.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg tmux \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.150 \
    && npm cache clean --force

# Use Microsoft VS Code Marketplace so we get the latest official build of
# every extension (Open VSX often lags). Resolved at install time below.
ENV EXTENSIONS_GALLERY='{"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery", "cacheUrl": "https://vscode.blob.core.windows.net/gallery/index", "itemUrl": "https://marketplace.visualstudio.com/items"}'

# Auth-aware wrapper at /usr/local/bin/claude (overrides /usr/bin/claude) —
# prevents the broken localhost-callback OAuth on remote pods.
COPY images/devcontainer/claude /usr/local/bin/claude
# `claude-attach` joins the shared tmux session (where claude runs at pod
# startup) so the daemon's stream watcher sees the conversation. Without this,
# typing `claude` directly opens a separate session in /home/coder/.claude/
# that the daemon doesn't see and participants don't watch.
COPY images/devcontainer/claude-attach /usr/local/bin/claude-attach
RUN chmod +x /usr/local/bin/claude /usr/local/bin/claude-attach

# Pre-seed code-server with a dark theme so users don't get the auto-detect
# light flash on first load. Machine-scope settings apply to every workspace.
RUN mkdir -p /home/coder/.local/share/code-server/Machine \
    && echo '{ "workbench.colorTheme": "Default Dark Modern", "window.autoDetectColorScheme": false }' \
        > /home/coder/.local/share/code-server/Machine/settings.json \
    && chown -R 1000:1000 /home/coder/.local

# Pre-install team-claude VS Code extension built in the first stage.
COPY --from=ext-build /ext/team-claude.vsix /opt/team-claude.vsix
RUN su coder -s /bin/sh -c "EXTENSIONS_GALLERY='$EXTENSIONS_GALLERY' code-server --install-extension /opt/team-claude.vsix" \
    && chown -R 1000:1000 /home/coder/.local/share/code-server/extensions

# NOTE: anthropic.claude-code extension is intentionally NOT pre-installed.
# It targets VS Code Desktop and is broken in browser-based VS Code
# (code-server / openvscode-server / vscode.dev):
#   - codicon font @font-face uses data: URI but webview CSP forbids it
#     → icons render as empty squares (anthropics/claude-code#51677, since 2.1.39)
#   - VS Code Chat APIs (chatSessionStore, chatEditingSession, type 'local')
#     are not fully implemented in the web extension host → chat panel
#     fails to initialise.
#   - 2x-4x slower than the CLI even when it does load (anthropics/claude-code#15172,
#     closed as "not planned").
# Users who want the full Anthropic UI should attach VS Code Desktop to the
# pod (Kubernetes extension → "Attach Visual Studio Code"). In the browser,
# the recommended path is the claude CLI in tmux (`claude-attach`).
#
# To install it anyway on a running session:
#   kubectl exec -n team-claude session-<name>-0 -c code-server -- \
#     code-server --install-extension anthropic.claude-code

USER 1000:1000
