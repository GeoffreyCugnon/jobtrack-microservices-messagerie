# syntax=docker/dockerfile:1

# --- Build stage: full toolchain (also reused as the "migrate" target) --------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# prisma/ must be present BEFORE npm ci: the postinstall hook (`prisma
# generate`) needs prisma/schema.prisma to run, even at the builder stage.
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
# prisma.config.ts uses the strict env() helper (throws if unset), which the
# postinstall's `prisma generate` needs to resolve even though it never
# connects to a DB. Build-time-only placeholder — env_file at runtime (real
# MESSAGING_DATABASE_URL) overrides this image default, same as any ENV.
ENV MESSAGING_DATABASE_URL="postgresql://user:pass@localhost:5432/db"
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
# prisma/ must be present BEFORE npm ci: the postinstall hook (`prisma
# generate`) needs prisma/schema.prisma to run.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Same reason as the builder stage: npm ci --omit=dev still runs the
# postinstall (`prisma generate`), which needs this to resolve even though
# it never connects. Overridden by the real env_file value at container
# runtime, same as the builder stage.
ENV MESSAGING_DATABASE_URL="postgresql://user:pass@localhost:5432/db"
# `prisma` (CLI) is a dependency (not devDependency): needed so
# `npx prisma migrate deploy` runs from this same image (the `migrate`
# service in docker-compose.prod.yml), without rebuilding from source on the
# deploy target — the local dev docker-compose.yml still uses `target: builder`.
RUN npm ci --omit=dev && npm cache clean --force
# Prisma 7 runs through the pg driver adapter — no Rust query-engine binary to
# copy, just the compiled client that ships inside dist/.
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
