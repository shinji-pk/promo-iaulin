# Servidor do WhatsApp (worker) para rodar 24h em uma hospedagem — é isso que
# permite conectar o WhatsApp lendo o QR Code direto no site, sem instalar nada.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.worker.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN npm run build:worker && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/worker ./dist/worker
COPY package.json ./
# Sessão do WhatsApp, banco e cofre ficam aqui: monte um disco persistente neste caminho.
VOLUME ["/app/data"]
EXPOSE 10000
ENV PORT=10000
CMD ["node", "dist/worker/apps/worker/src/index.js"]
