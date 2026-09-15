FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client ripgrep tmux tini \
    && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspace
ENV SHELL=/bin/bash TERM=xterm-256color
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
