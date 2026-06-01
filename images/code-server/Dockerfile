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
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg tmux python3 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.150 \
    && npm cache clean --force

# Same CLI tooling as the devcontainer (gh, jq, kubectl, helm, yq, k9s, krew +
# plugins) so the code-server integrated terminal has them too. Shared script
# lives under the devcontainer image dir; this build's context is the repo root.
ARG TARGETARCH
ENV KREW_ROOT=/usr/local/krew
ENV PATH=/usr/local/krew/bin:$PATH
COPY images/devcontainer/install-cli-tools.sh /usr/local/bin/install-cli-tools.sh
RUN bash /usr/local/bin/install-cli-tools.sh

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

# anthropic.claude-code is intentionally NOT pre-installed. Even with the
# codicon CSS patch (see below), the chat panel uses VS Code Chat APIs
# (chatSessionStore, chatEditingSession, type "local") that aren't fully
# implemented in the web extension host, so the panel is unreliable in
# browser. For the full Anthropic UI, attach VS Code Desktop to the pod
# via the Kubernetes extension. In the browser, drive Claude from the CLI
# in tmux via `claude-attach` in the integrated terminal.
#
# The codicon-CSS patch script is kept in the image so you can install the
# extension manually and then patch it in one go:
#
#   code-server --install-extension anthropic.claude-code
#   python3 /usr/local/bin/patch-anthropic-codicon
#   # then hard-refresh your code-server tab
#
# (Workaround for anthropics/claude-code#51677: rewrite the webview CSS so
# the codicon @font-face loads from a sibling codicon.ttf instead of a
# data: URI that the webview CSP blocks.)
COPY images/code-server/patch-anthropic-codicon.py /usr/local/bin/patch-anthropic-codicon
RUN chmod +x /usr/local/bin/patch-anthropic-codicon

USER 1000:1000
