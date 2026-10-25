FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run check && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data COOKIE_SECURE=true
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/modules/orders ./modules/orders
COPY --from=build /app/modules/sales ./modules/sales
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(v=>{if(v.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]

# Explicit isolated target only; the production image does not contain QA hooks.
FROM runtime AS test-runtime
USER root
COPY qa ./qa
USER node

FROM runtime AS production
