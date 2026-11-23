# Mark MCP server over stdio (the client for the Agent Escrow service).
#
# The agent key lives only in MARK_HOME. Persist it with a volume; never bake
# a key into the image. Losing the volume loses this identity.
#
#   docker build -t mark .
#   docker run --rm -i -v mark-home:/home/node/.mark mark
#   docker run --rm -i -v /path/on/host:/home/node/.mark mark
#
# This image builds from the source in this repository (what the Docker MCP
# Catalog builds). To run a published npm release instead:
#   docker run --rm -i -v mark-home:/home/node/.mark \
#     node:22-slim bash -lc 'npm install -g @yuvlero/mark@latest && exec mark mcp'

FROM node:22-slim AS build
WORKDIR /app

COPY package.json npm-shrinkwrap.json tsconfig.json ./
COPY src ./src

# skip lifecycle scripts (prepare would tsc before sources are fully ready in
# some CI layouts); compile explicitly. Omit optional native deps Mark never loads.
RUN npm ci --omit=optional --ignore-scripts \
 && npx tsc \
 && chmod +x dist/src/cli.js \
 && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/npm-shrinkwrap.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
ENV NODE_ENV=production \
    MARK_HOME=/home/node/.mark
VOLUME ["/home/node/.mark"]

# stdio MCP server; no published ports
ENTRYPOINT ["node", "/app/dist/src/cli.js", "mcp"]
