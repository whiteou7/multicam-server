FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 falls back to compiling from source if no prebuilt binary
# matches the target platform/arch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npx --yes esbuild node_modules/mediasoup-client/lib/index.js --bundle --format=esm --outfile=public/mediasoup-client.bundle.js --platform=browser || echo "esbuild bundle failed, continuing"
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY package.json ./

RUN mkdir -p /app/data/upload-tmp

EXPOSE 3000
CMD ["node", "dist/server.js"]
