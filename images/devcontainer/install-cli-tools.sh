#!/usr/bin/env bash
# Shared CLI tooling for the team-claude images (devcontainer + code-server).
# Both bases are Debian-derived; run as root at build time. Architecture is
# taken from $TARGETARCH (amd64|arm64, default amd64).
#
# Installs: jq, gh, kubectl, helm, yq (mikefarah), k9s, and krew with a curated
# set of kubectl plugins (cnpg, oidc-login, ctx, ns). krew is installed
# system-wide under /usr/local/krew so it survives a PVC mounting over $HOME at
# runtime; add /usr/local/krew/bin to PATH (done via ENV in each Dockerfile).
set -euo pipefail

ARCH="${TARGETARCH:-amd64}"
KARCH="$([ "$ARCH" = "arm64" ] && echo arm64 || echo amd64)"
export DEBIAN_FRONTEND=noninteractive

# --- apt packages: jq + gh (from its official repo) + prerequisites ----------
apt-get update
apt-get install -y --no-install-recommends jq ca-certificates curl gnupg openssl tar

mkdir -p /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh
rm -rf /var/lib/apt/lists/*

# --- single-binary tools -----------------------------------------------------
# kubectl
curl -fsSLo /usr/local/bin/kubectl \
  "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$KARCH/kubectl"
chmod +x /usr/local/bin/kubectl

# helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# yq (mikefarah)
curl -fsSLo /usr/local/bin/yq \
  "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$KARCH"
chmod +x /usr/local/bin/yq

# k9s
curl -fsSL "https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_$KARCH.tar.gz" \
  | tar -xz -C /usr/local/bin k9s
chmod +x /usr/local/bin/k9s

# --- kubectl plugins via krew (system-wide) ----------------------------------
export KREW_ROOT=/usr/local/krew
export PATH="$KREW_ROOT/bin:$PATH"
cd /tmp
curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/latest/download/krew-linux_${KARCH}.tar.gz"
tar -xzf "krew-linux_${KARCH}.tar.gz"
"./krew-linux_${KARCH}" install krew
kubectl krew install cnpg oidc-login ctx ns
rm -f "/tmp/krew-linux_${KARCH}.tar.gz" "/tmp/krew-linux_${KARCH}"
chmod -R a+rX "$KREW_ROOT"

# Login shells (e.g. the code-server integrated terminal) re-derive PATH from
# /etc/profile, which drops the image's ENV PATH. Make the plugins resolvable
# regardless by symlinking them into /usr/local/bin (always on PATH), and export
# KREW_ROOT via profile.d so `kubectl krew` manages the system-wide root.
ln -sf "$KREW_ROOT"/bin/kubectl-* /usr/local/bin/
cat > /etc/profile.d/krew.sh <<'PROFILE'
export KREW_ROOT=/usr/local/krew
export PATH="$KREW_ROOT/bin:$PATH"
PROFILE
chmod 0644 /etc/profile.d/krew.sh
