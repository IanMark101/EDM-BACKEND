FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY backend/package.json backend/prisma.config.ts ./backend/
COPY backend/prisma ./backend/prisma
RUN npm ci --include=dev

COPY backend/src ./backend/src
COPY scripts ./scripts
COPY shared ./shared
RUN npm run build

ENV NODE_ENV=production HOST=0.0.0.0 CLINIC_AUTOBACKUP=0
USER node
CMD ["node", "backend/dist/index.mjs"]
