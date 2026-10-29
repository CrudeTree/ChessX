# ChessX: single Node process serving the built client, the /api routes and the websocket.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
# Mount a persistent volume here so accounts and games survive restarts/deploys.
ENV DB_PATH=/data/chessx.sqlite
VOLUME ["/data"]

# Run as the unprivileged `node` user the base image already provides (uid 1000), never as root: if the server were
# ever made to run code it did not intend to, it would have no rights beyond this container's own files.
# The data volume has to belong to that user. A volume created here inherits ownership from this directory, so a fresh
# deploy is right from the start; an existing volume is handed over by deploy/set-volume-owner.sh before the switch.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
# Run node directly (not via npm wrappers) so SIGTERM reaches the server for a graceful shutdown.
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
