# syntax=docker/dockerfile:1
#
# Thai DRG grouper API.
#
#   docker compose up -d --build
#
# The "data" stage runs "npm run setup": it downloads the TCMC files (or takes the zips you
# put in cache/), checks them, builds native/rules.json from the Thai DRG 6.3.3 books and
# keeps only the four 6.3.4 tables. The exe in S0021.zip is never unpacked.
#
# The image you build holds TCMC data (tables and rules made from the books). Use it inside
# your own organisation; do not push it to a public registry without TCMC's permission.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- TCMC data and rules
FROM node:${NODE_VERSION}-bookworm-slim AS data
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY groupers ./groupers
# empty in git; put S0021.zip, S0062.zip and S0063.zip here to build without internet
COPY cache ./cache
# --strict: stop when poppler gives rules other than the build compared with the exe
ARG SETUP_ARGS=--strict
RUN node tools/setup.mjs ${SETUP_ARGS}

# ---------------------------------------------------------------- production packages
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-alpine
LABEL org.opencontainers.image.title="thai-drg-grouper" \
      org.opencontainers.image.description="Thai DRG 6.3.4 grouper REST API, written from the TCMC Thai DRG 6.3.3 books" \
      org.opencontainers.image.source="https://github.com/somprasongd/thai-drg-grouper" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8089
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY src ./src
COPY --from=data /build/groupers ./groupers
USER node
EXPOSE 8089
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8089)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
