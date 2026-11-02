# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared ./shared
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
# Redis runs inside the same container unless REDIS_URL points elsewhere (see docker-entrypoint.sh)
RUN apk add --no-cache redis
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=2s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
