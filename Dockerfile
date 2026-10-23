# syntax=docker/dockerfile:1
# Version de Node épinglée (pas une étiquette flottante) : la version embarquée se lit dans le
# dépôt, et Dependabot propose les correctifs de sécurité (24.22.1 : avis du 21 octobre 2026).
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data
# ffmpeg : transcription et mix. pg_dump 17 (dépôt PGDG, Debian n'a que le 15) : sauvegarde
# automatique avant chaque migration ; il doit être au moins de la version du serveur.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg postgresql-common ca-certificates \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# Police du compte rendu en PDF (accents, lettres d'Europe de l'Est, cyrillique…).
COPY assets ./assets
COPY package.json ./
# Version affichée au démarrage et dans /health (renseignées par la CI).
ARG GIT_SHA=""
ARG APP_VERSION=""
ENV GIT_SHA=$GIT_SHA APP_VERSION=$APP_VERSION
USER node
# Santé : connexion Discord et base (serveur interne 127.0.0.1:$HEALTH_PORT, non publié).
ENV HEALTH_PORT=3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
