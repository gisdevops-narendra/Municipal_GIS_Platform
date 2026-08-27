# Development-only image for the NestJS backend, used by the root
# docker-compose.yml. Source is bind-mounted at runtime (see the `backend`
# service's `volumes`) so `npm run start:dev` hot-reloads on file changes;
# this image only needs to provide a consistent Node runtime + node_modules.
#
# This is NOT a production image — there is no multi-stage build, no
# `npm run build`, and no non-root user hardening here. Production
# deployment is a later task.
#
# Base is the official OSGeo GDAL Alpine image, not node:22-alpine +
# `apk add gdal` — Alpine's own community `gdal` package is built WITHOUT
# the PostgreSQL/PostGIS vector driver (only PGDUMP, which writes a .sql
# file rather than connecting live), which GdalService.importToPostgis
# depends on. The official image bundles a GDAL build with the full
# driver set, including a live PostgreSQL driver — see docs/backend.md
# "GDAL Configuration" for how this was diagnosed.
FROM ghcr.io/osgeo/gdal:alpine-normal-latest

# GDAL/OGR (ogrinfo, ogr2ogr) is already present in this base image —
# Task 7's GIS upload processing engine. Invoked as subprocesses
# (child_process.execFile with argv arrays, never a shell string) from
# GdalService; never used as an npm binding, so no native build
# toolchain is needed for our own code.
RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json package-lock.json ./
# `npm install` rather than `npm ci`: this dev image runs on a different
# platform (linux/musl) than most contributors' hosts, and optional
# platform-specific transitive dependencies can differ from what's pinned
# in package-lock.json for the host platform. Fine for a dev-only image.
RUN npm install

COPY . .
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
