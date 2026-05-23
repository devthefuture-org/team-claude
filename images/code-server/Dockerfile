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
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.150 \
    && npm cache clean --force

# Use Microsoft VS Code Marketplace as the extension gallery so we always
# get the latest official build of every extension (Open VSX lags behind
# for some Anthropic-published items). This is a runtime gallery selection;
# `code-server --install-extension` resolves against it.
ENV EXTENSIONS_GALLERY='{"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery", "cacheUrl": "https://vscode.blob.core.windows.net/gallery/index", "itemUrl": "https://marketplace.visualstudio.com/items"}'

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

# Pre-install the official Anthropic Claude Code extension from MS Marketplace.
# Done at image build time so the user gets it instantly; postStart hook in the
# chart can layer additional extensions per session.
RUN su coder -s /bin/sh -c "EXTENSIONS_GALLERY='$EXTENSIONS_GALLERY' code-server --install-extension anthropic.claude-code --force" \
    && chown -R 1000:1000 /home/coder/.local/share/code-server/extensions

USER 1000:1000
