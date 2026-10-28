# The forum bot (README.md, "In Docker").  The image holds only the bot: it clones the code at run time (BOT_REPO, the
# public repository over HTTPS; a private one over SSH with a read-only deploy key mounted at /keys/deploy_key), and
# keeps its clone, archive and log in /state.
FROM node:22-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# sharp (the pictures, shrunk for the model) brings its libvips for this platform (musl, amd64 or arm64): a build
# without it fails here instead of a bot that sends pictures at full size
RUN node -e "require('sharp')"
COPY *.mjs *.md ./
# GitHub's host key, as https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
# publishes it: the clone checks it instead of trusting whatever answers
RUN echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > /app/known_hosts \
 && mkdir /state && chown node:node /state
ENV NODE_ENV=production BOT_STATE=/state \
    GIT_SSH_COMMAND="ssh -i /keys/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/app/known_hosts -o StrictHostKeyChecking=yes"
USER node
VOLUME /state
CMD ["node", "bot.mjs"]
