FROM oven/bun:1.3.6-alpine AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY policy ./policy
ENV NODE_ENV=production \
    DATABASE_PATH=/data/quotes.sqlite \
    PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "src/index.ts"]
