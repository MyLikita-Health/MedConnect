# Integration Hub — Docker image (plan §4.1 Packaging target: "Docker image +
# Windows installer + Linux systemd"; §4.2 "Ships as Docker compose"). The
# image is the facility installer unit: the release tag IS the version axis
# the signed-update machinery swaps between.
#
#   docker build -t medconnect-hub:0.1.0 .        (or: npm run image:build)
#   docker compose up -d db hub                   (or: npm run up:stack)
#
# The hub runs from source via tsx (same as npm start) so the image carries
# the full workspace; migrations auto-apply against DATABASE_URL on boot.
FROM node:22-alpine AS build
WORKDIR /app

# npm workspaces need every package.json (and the lockfile) present before
# `npm ci`. Each workspace package.json must land in its OWN directory (a
# glob COPY would collide on the shared basename and empty the workspaces).
COPY package.json package-lock.json ./
RUN mkdir -p packages/core packages/astm packages/server packages/shared \
             packages/simulator packages/api packages/gateway
COPY packages/core/package.json packages/core/
COPY packages/astm/package.json packages/astm/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/simulator/package.json packages/simulator/
COPY packages/api/package.json packages/api/
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY packages ./packages
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000 5000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health > /dev/null || exit 1
CMD ["node_modules/.bin/tsx", "packages/server/src/cli.ts"]
