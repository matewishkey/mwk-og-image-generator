# The engine container: node running the repo's own src/ unchanged.
# Build context is the REPO ROOT (image_build_context in wrangler.jsonc).
FROM node:24-slim

# fontconfig for sharp's pango text path — the band renderer resolves the vendored
# variable font through fontconfig at render time.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY brand ./brand
COPY engine/container ./engine/container

ENV NODE_ENV=production
EXPOSE 8080
# Node 24 runs the TypeScript directly — no build step, same as the CLI.
CMD ["node", "engine/container/server.ts"]
