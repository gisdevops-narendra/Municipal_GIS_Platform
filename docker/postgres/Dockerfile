# PostgreSQL 16 + PostGIS 3.4 + pgvector.
#
# Extends the SAME alpine PostGIS image the project already used (so the
# existing data directory keeps working unchanged — identical PG major
# version, identical libc) and adds pgvector so RAG embeddings can live in
# the one shared database alongside the spatial data.
#
# pgvector is compiled without the LLVM JIT bitcode (`with_llvm=no`): the
# alpine PostGIS image ships llvm15, which alpine 3.20 no longer packages a
# matching clang for. JIT is irrelevant for the tiny RAG index anyway.
FROM postgis/postgis:16-3.4-alpine

ARG PGVECTOR_VERSION=v0.8.0

RUN set -eux; \
    apk add --no-cache --virtual .pgvector-build build-base git; \
    git clone --depth 1 --branch "${PGVECTOR_VERSION}" \
        https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make with_llvm=no; \
    make with_llvm=no install; \
    cd /; rm -rf /tmp/pgvector; \
    apk del .pgvector-build
