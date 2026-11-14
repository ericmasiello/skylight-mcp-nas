FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Type-check and test with dev dependencies; the runtime stage depends on this
# one, so an image that fails either never gets built.
FROM base AS test
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN node_modules/.bin/tsc -p . && node --test && touch /tested

FROM base AS runtime
COPY --from=test /tested /tested
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh

# No credentials here: the entrypoint reads them from /run/secrets at start.
ENV MCP_DATA_DIR=/data \
    MCP_CONFIRM_ELICITATION=off \
    MCP_CONFIRM_MODE=ask-user \
    NODE_ENV=production

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8001/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
