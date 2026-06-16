FROM node:26-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production
ENV UV_THREADPOOL_SIZE=16
ENV NODE_OPTIONS="--max-old-space-size=256 --dns-result-order=ipv4first"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
