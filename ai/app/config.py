"""Runtime configuration for the GIS AI / RAG service.

Every value is environment-driven (12-factor) — nothing municipality- or
deployment-specific is hard-coded. Defaults match the docker-compose stack.

The stack is 100% open-source / self-hosted (no API key, no paid service):
  * LLM       — Ollama serving qwen2.5:1.5b-instruct (Apache-2.0), local CPU
  * Embedding — fastembed BAAI/bge-small-en-v1.5 (MIT), local, in-process
  * Vector DB — pgvector in the existing PostgreSQL/PostGIS database
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def _asyncpg_dsn(raw: str) -> str:
    """Prisma-style DATABASE_URL -> a DSN asyncpg accepts (strip ?schema=)."""
    parts = urlsplit(raw)
    scheme = "postgresql" if parts.scheme in ("postgres", "postgresql") else parts.scheme
    return urlunsplit((scheme, parts.netloc, parts.path, "", ""))


# --- Database (the SAME PostgreSQL/PostGIS instance the rest of the app uses) --
DATABASE_URL: str = _asyncpg_dsn(
    os.environ.get(
        "DATABASE_URL",
        "postgresql://municipal_gis:municipal_gis_dev_password@localhost:5432/municipal_gis",
    )
)
DB_SCHEMA: str = os.environ.get("GIS_AI_DB_SCHEMA", "public")

# --- Local LLM (Ollama — open-source, self-hosted, no API key) --------------
OLLAMA_URL: str = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
# Open-source instruct model (Apache-2.0). Default `qwen2.5:1.5b-instruct`
# runs comfortably on ~8 GB RAM / CPU and is accurate enough for this
# constrained extraction task (RAG + JSON schema + validation do the heavy
# lifting). Set GIS_AI_LLM_MODEL=qwen2.5:3b-instruct on a roomier host for
# higher-quality phrasing.
LLM_MODEL: str = os.environ.get("GIS_AI_LLM_MODEL", "qwen2.5:1.5b-instruct").strip()
LLM_NUM_CTX: int = int(os.environ.get("GIS_AI_LLM_NUM_CTX", "4096"))
LLM_TEMPERATURE: float = float(os.environ.get("GIS_AI_LLM_TEMPERATURE", "0"))
LLM_TIMEOUT_S: float = float(os.environ.get("GIS_AI_LLM_TIMEOUT_S", "240"))
# Constrain output with Ollama's JSON-schema `format`. Very accurate but the
# grammar adds decode overhead; on a slow CPU box `simple` (format="json")
# or `off` (prompt-only) can be several times faster.
LLM_FORMAT_MODE: str = os.environ.get("GIS_AI_LLM_FORMAT", "json").strip().lower()
# Pull the model automatically on startup if it isn't present yet.
LLM_AUTO_PULL: bool = os.environ.get("GIS_AI_LLM_AUTO_PULL", "true").lower() == "true"

# --- Embedding model (local, offline — no external embedding API) -----------
EMBEDDING_MODEL: str = os.environ.get(
    "GIS_AI_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"
)
EMBEDDING_DIM: int = int(os.environ.get("GIS_AI_EMBEDDING_DIM", "384"))

# --- RAG / retrieval --------------------------------------------------------
RAG_TOP_K: int = int(os.environ.get("GIS_AI_RAG_TOP_K", "8"))
INDEX_DISTINCT_SAMPLE: int = int(os.environ.get("GIS_AI_INDEX_DISTINCT_SAMPLE", "25"))

RULES_DIR: str = os.path.join(os.path.dirname(__file__), "knowledge")
