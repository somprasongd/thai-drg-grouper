# syntax=docker/dockerfile:1
#
# Thai DRG grouper API.
#
#   docker compose up -d                       (image from ghcr.io)
#   docker compose up -d --build               (build it here)
#
# The image holds the code only, no TCMC files. On the first start tools/start.mjs runs
# "npm run setup" (tools/setup.mjs): it downloads the TCMC zips into /data/cache (or takes the
# ones you put there), checks them, builds native/rules.json from the Thai DRG 6.3.3 books
# with pdftotext and keeps the four 6.3.4 tables in /data/groupers. The exe in S0021.zip is
# never unpacked. Keep /data on a volume so this happens once.
#
# The /data volume then holds TCMC data: use it inside your own organisation and do not
# publish it (or an image made from it) without TCMC's permission.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- production packages
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim
# poppler-utils: pdftotext for the first start (Debian bookworm gives the rules.json that was
# compared with the exe)
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.title="thai-drg-grouper" \
      org.opencontainers.image.description="Thai DRG 6.3.4 grouper REST API, written from the TCMC Thai DRG 6.3.3 books. No TCMC files inside: they are fetched on the first start." \
      org.opencontainers.image.source="https://github.com/somprasongd/thai-drg-grouper" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8089 \
    GROUPERS_DIR=/data/groupers \
    TCMC_CACHE=/data/cache \
    SETUP_ARGS=--strict
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY src ./src
COPY tools/setup.mjs tools/build-rules.mjs tools/start.mjs ./tools/
COPY groupers ./groupers
RUN mkdir -p /data/groupers /data/cache && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8089
# the first start builds the rules (about a minute, plus the download)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8089)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "tools/start.mjs"]
