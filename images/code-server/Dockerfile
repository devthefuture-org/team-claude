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

# Use Microsoft VS Code Marketplace so we get the latest official build of
# every extension (Open VSX often lags). Resolved at install time below.
ENV EXTENSIONS_GALLERY='{"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery", "cacheUrl": "https://vscode.blob.core.windows.net/gallery/index", "itemUrl": "https://marketplace.visualstudio.com/items"}'

# Auth-aware wrapper at /usr/local/bin/claude (overrides /usr/bin/claude) —
# prevents the broken localhost-callback OAuth on remote pods.
COPY images/devcontainer/claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

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

# Pin the official Anthropic extension by downloading the exact VSIX from
# Marketplace (the `--install-extension id@version` syntax isn't supported by
# this code-server release; only `id` (latest) or a path). Matches our CLI
# version to avoid skew rendering / behaviour bugs.
ARG ANTHROPIC_EXT_VERSION=2.1.150
RUN curl -fsSL -o /opt/anthropic-claude-code.vsix \
      "https://anthropic.gallery.vsassets.io/_apis/public/gallery/publisher/anthropic/extension/claude-code/${ANTHROPIC_EXT_VERSION}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage" \
    && su coder -s /bin/sh -c "code-server --install-extension /opt/anthropic-claude-code.vsix --force" \
    && chown -R 1000:1000 /home/coder/.local/share/code-server/extensions

USER 1000:1000
