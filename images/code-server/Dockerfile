FROM node:20-alpine AS ext-build
WORKDIR /ext
COPY extension/package.json ./
RUN npm install --no-audit --no-fund
COPY extension/extension.js extension/README.md ./
COPY extension/media ./media
RUN npx --yes @vscode/vsce package --no-yarn --skip-license --out /ext/team-claude.vsix

FROM codercom/code-server:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# Pre-seed code-server with a dark theme so users don't get the auto-detect
# light flash on first load. Machine-scope settings apply to every workspace.
RUN mkdir -p /home/coder/.local/share/code-server/Machine \
    && echo '{ "workbench.colorTheme": "Default Dark Modern", "window.autoDetectColorScheme": false }' \
        > /home/coder/.local/share/code-server/Machine/settings.json \
    && chown -R 1000:1000 /home/coder/.local

# Pre-install team-claude VS Code extension built in the first stage.
COPY --from=ext-build /ext/team-claude.vsix /opt/team-claude.vsix
RUN su coder -s /bin/sh -c "code-server --install-extension /opt/team-claude.vsix" \
    && chown -R 1000:1000 /home/coder/.local/share/code-server/extensions

USER 1000:1000
