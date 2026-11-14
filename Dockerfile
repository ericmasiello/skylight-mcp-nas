FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
