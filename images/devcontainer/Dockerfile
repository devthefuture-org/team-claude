FROM jetpackio/devbox:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         tmux \
         openssh-server \
         git \
         curl \
         ca-certificates \
         sudo \
         tini \
         iproute2 \
         jq \
    && mkdir -p /var/run/sshd \
    && sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && echo 'AllowUsers devbox' >> /etc/ssh/sshd_config \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'devbox ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/devbox \
    && chmod 0440 /etc/sudoers.d/devbox

# Install tmux plugins to /opt so they survive PVC mounting over /home/devbox.
RUN mkdir -p /opt/tmux-plugins \
    && git clone --depth 1 https://github.com/tmux-plugins/tpm /opt/tmux-plugins/tpm \
    && git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect /opt/tmux-plugins/tmux-resurrect \
    && git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum /opt/tmux-plugins/tmux-continuum \
    && chown -R 1000:1000 /opt/tmux-plugins

COPY tmux.conf /etc/team-claude/tmux.conf
COPY team-claude-init /usr/local/bin/team-claude-init
COPY claude-attach /usr/local/bin/claude-attach
RUN chmod 0644 /etc/team-claude/tmux.conf \
    && chmod +x /usr/local/bin/team-claude-init /usr/local/bin/claude-attach

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/team-claude-init"]
