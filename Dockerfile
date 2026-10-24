FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Toolchain only needed here: native modules (better-sqlite3, mediasoup worker)
# compile from source when no prebuilt binary matches the platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# No fallback: a failed dashboard bundle must fail the build.
RUN npx esbuild node_modules/mediasoup-client/lib/index.js --bundle --format=esm --outfile=public/mediasoup-client.bundle.js --platform=browser
RUN npm run build
# Keep the already-compiled native modules, drop dev deps.
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node package.json ./

RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
