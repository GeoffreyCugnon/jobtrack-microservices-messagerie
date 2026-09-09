# syntax=docker/dockerfile:1

# --- Build stage: full toolchain (also reused as the "migrate" target) --------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# `prisma generate` writes the client to src/generated/prisma; `nest build`
# compiles it into dist/generated/prisma alongside the app.
RUN npx prisma generate && npm run build

# --- Runtime stage: prod deps + compiled output only -------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Prisma 7 runs through the pg driver adapter — no Rust query-engine binary to
# copy, just the compiled client that ships inside dist/.
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3100
# Schema migrations are applied by the one-shot `migrate` service in
# docker-compose (target: builder), not here.
CMD ["node", "dist/main.js"]
