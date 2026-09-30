# syntax=docker/dockerfile:1
#
# D-5 — container image for servicenow-mcp-ai.
#
# Build:  docker build -t servicenow-mcp-ai .
# Run (Streamable HTTP, the image default):
#   docker run --rm -p 3000:3000 \
#     -e SN_INSTANCE=dev12345.service-now.com -e SN_USER=admin \
#     -e SN_PASSWORD_FILE=/run/secrets/sn_password \
#     -e SN_HTTP_TOKEN_FILE=/run/secrets/sn_http_token \
#     -v "$PWD/secrets:/run/secrets:ro" -v sn-data:/data \
#     servicenow-mcp-ai
# Run over stdio instead (an MCP client spawning the container):
#   docker run --rm -i -e SN_TRANSPORT=stdio -e SN_INSTANCE=... servicenow-mcp-ai
#
# The image binds 0.0.0.0 so the published port is reachable — set
# SN_HTTP_TOKEN (or SN_HTTP_TOKEN_FILE) whenever the port is reachable from
# anything but this host; without it every client that reaches the port can
# drive the instance with the configured credentials.

# ---- build: compile, pack, and install production dependencies ----------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY README.md LICENSE ./
# npm pack applies the package.json "files" list (no source maps, no dark
# Jira client), so the image ships exactly what `npm install` would.
RUN npm run build \
 && npm pack --ignore-scripts --pack-destination /tmp \
 && mkdir -p /app /data/docs \
 && tar -xzf /tmp/servicenow-mcp-ai-*.tgz -C /app --strip-components=1 \
 && cp package-lock.json /app/ \
 && cd /app \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm package-lock.json \
 && npm cache clean --force

# ---- runtime: distroless Node, no shell, non-root (uid 65532) -----------
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=65532:65532 /app /app
COPY --from=build --chown=65532:65532 /data /data
ENV NODE_ENV=production \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    SN_TRANSPORT=http \
    SN_HTTP_HOST=0.0.0.0 \
    SN_PORT=3000 \
    SN_DOCS_DIR=/data/docs \
    SN_ENV_FILE=/data/.env
USER 65532:65532
EXPOSE 3000
# Liveness only: a TCP connect to the listener. The server has no
# unauthenticated health path (every HTTP route sits behind SN_HTTP_TOKEN).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "require('net').connect(Number(process.env.SN_PORT)||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/app/bin/servicenow-mcp-ai.cjs"]
