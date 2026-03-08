# ── Base ──────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma/

# ── App (Next.js standalone) ─────────────────────────────────────
FROM base AS app
COPY . .
RUN npx prisma generate
RUN npm run build
RUN cp -r .next/standalone/. ./standalone/ && \
    cp -r .next/static ./standalone/.next/static && \
    cp -r public ./standalone/public 2>/dev/null || true
WORKDIR /app/standalone
EXPOSE 3000
CMD ["node", "server.js"]

# ── Worker (pg-boss + BullMQ) ────────────────────────────────────
FROM base AS worker
COPY . .
RUN npx prisma generate
CMD ["node", "dist/server/worker/index.js"]
