# =============================================================================
# Imagen de producción de la API (NestJS) + workers BullMQ (en el mismo proceso).
# Monorepo pnpm: se construye `@wzp/shared` y `@wzp/api`, y se genera un paquete
# de despliegue AISLADO y SOLO con dependencias de producción con `pnpm deploy`.
#
# Construir (desde la RAÍZ del repo, no desde apps/api):
#   docker build -f apps/api/Dockerfile -t wzp-api .
# =============================================================================

# ---- Base: Node 22 + pnpm vía corepack -------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---- Builder: instala todo el workspace y compila --------------------------
FROM base AS builder

# 1) Manifiestos primero (mejor caché de capas en reinstalaciones).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# 2) Instala TODAS las dependencias del workspace (con devDeps para compilar).
#    --ignore-scripts: NO ejecutamos postinstalls. La API se compila con tsc y
#    corre con dependencias puras de JS; los scripts nativos (msgpackr-extract,
#    unrs-resolver…) no son necesarios y además pnpm 11 falla si no se aprueban.
RUN pnpm install --frozen-lockfile --ignore-scripts

# 3) Copia el código fuente necesario y compila shared + api.
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @wzp/shared build \
 && pnpm --filter @wzp/api build

# 4) Genera un paquete de despliegue autocontenido SOLO con prod deps en /app.
#    Incluye dist/ (ya compilado) + node_modules podado.
RUN pnpm --filter @wzp/api deploy --prod --legacy --ignore-scripts /app

# ---- Runner: imagen final mínima -------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
# App Runner inyecta PORT; nuestra app lee API_PORT. Mapeamos en el arranque.
ENV API_PORT=3001
WORKDIR /app

# Copiamos el paquete de despliegue (app + node_modules de producción).
COPY --from=builder /app ./

# Migraciones + runner por si quieres aplicarlas como tarea puntual.
COPY --from=builder /repo/supabase ./supabase

EXPOSE 3001
# Usuario sin privilegios (la imagen node trae el usuario `node`).
USER node
CMD ["node", "dist/main.js"]
