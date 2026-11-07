# SyncWatch relay server (the Chrome extension is not part of this image).
# Build context is the repository root so Coolify needs no base-directory setting.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app

# Install dependencies first so this layer is cached until package files change.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/server.js ./

# Run unprivileged.
USER node
EXPOSE 8787

# /healthz is answered by the relay's plain HTTP handler.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" | grep -q ok || exit 1

CMD ["node", "server.js"]
