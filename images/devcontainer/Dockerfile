FROM jetpackio/devbox:0.17.2

USER root

# Core OS packages + Node + Claude Code CLI + dev convenience tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         tmux \
         openssh-server \
         git \
         curl \
         wget \
         ca-certificates \
         sudo \
         tini \
         iproute2 \
         jq \
         direnv \
         unzip \
         less \
         gnupg \
         lsb-release \
         file \
         make \
         build-essential \
         pkg-config \
    && mkdir -p /var/run/sshd \
    && sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#*Port .*/Port 2222/'  /etc/ssh/sshd_config \
    && echo 'AllowUsers devbox' >> /etc/ssh/sshd_config \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@2.1.150 \
    && echo 'devbox ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/devbox \
    && chmod 0440 /etc/sudoers.d/devbox \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its apt repo.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Static / single-binary tools. ARCH detection so the image stays
# multi-arch-ready if we add platforms later.
ARG TARGETARCH
RUN ARCH="${TARGETARCH:-amd64}" \
    && KARCH="$([ "$ARCH" = "arm64" ] && echo arm64 || echo amd64)" \
    # kubectl
    && curl -fsSLo /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$KARCH/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    # helm
    && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash \
    # yq (mikefarah)
    && curl -fsSLo /usr/local/bin/yq \
        "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$KARCH" \
    && chmod +x /usr/local/bin/yq \
    # k9s
    && curl -fsSL "https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_$KARCH.tar.gz" \
        | tar -xz -C /usr/local/bin k9s \
    && chmod +x /usr/local/bin/k9s

# Go toolchain (latest stable). `go` itself acts as the version manager via
# `go install golang.org/dl/goX.Y@latest && goX.Y download` once installed.
RUN ARCH="${TARGETARCH:-amd64}" \
    && GO_VERSION="$(curl -fsSL https://go.dev/VERSION?m=text | head -n1)" \
    && curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-${ARCH}.tar.gz" \
        | tar -xz -C /usr/local \
    && ln -s /usr/local/go/bin/go    /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Per-user tools that install into $HOME — done as the devbox user so they
# live under /home/devbox (which the PVC will mount over at runtime). We seed
# them into /opt/team-claude-skel and the init script copies missing pieces.
USER devbox
RUN mkdir -p /home/devbox/.local/share \
    # fnm (Node version manager)
    && curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir /home/devbox/.local/share/fnm --skip-shell

USER root

# Tools for the shared init step (loaded by /etc/profile.d for interactive shells).
RUN cat > /etc/profile.d/team-claude.sh <<'EOF'
# Added by team-claude devcontainer image.
export PATH="$HOME/.local/share/fnm:$HOME/go/bin:$PATH"
command -v direnv >/dev/null && eval "$(direnv hook bash)"
command -v fnm    >/dev/null && eval "$(fnm env --use-on-cd --shell bash)"
EOF

# Install tmux plugins to /opt so they survive PVC mounting over /home/devbox.
RUN mkdir -p /opt/tmux-plugins \
    && git clone --depth 1 https://github.com/tmux-plugins/tpm /opt/tmux-plugins/tpm \
    && git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect /opt/tmux-plugins/tmux-resurrect \
    && git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum /opt/tmux-plugins/tmux-continuum \
    && chown -R 1000:1000 /opt/tmux-plugins

# Seed user dotfiles into /opt so the init script can copy them onto an empty PVC.
RUN mkdir -p /opt/team-claude-skel/.local/share \
    && cp -r /home/devbox/.local/share/fnm /opt/team-claude-skel/.local/share/fnm \
    && chown -R 1000:1000 /opt/team-claude-skel

COPY tmux.conf /etc/team-claude/tmux.conf
COPY team-claude-init  /usr/local/bin/team-claude-init
COPY team-claude-login /usr/local/bin/team-claude-login
COPY claude-attach     /usr/local/bin/claude-attach
RUN chmod 0644 /etc/team-claude/tmux.conf \
    && chmod +x /usr/local/bin/team-claude-init \
               /usr/local/bin/team-claude-login \
               /usr/local/bin/claude-attach

# Rootless image — required by clusters that enforce PSA `restricted` /
# runAsNonRoot=true. K8s needs a NUMERIC uid here (it can't resolve names
# without entering the container). ssh.enabled in the chart will not work
# on rootless-only clusters because sshd needs to bind port 22 (root-only);
# use kubectl exec or VS Code "Attach Visual Studio Code" instead.
USER 1000:1000
WORKDIR /home/devbox

# SSH listens on 2222 (rootless: only ports >1023 are bindable). The chart's
# Service exposes it as :22 externally via targetPort: 2222.
EXPOSE 2222

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/team-claude-init"]
