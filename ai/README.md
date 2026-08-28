# Municipal GIS — AI / RAG backend

Natural-language front door to the existing GIS tools (Query Builder,
Attribute Table, Buffer/Overlay, Identify). It does **not** add a parallel
GIS engine.

**100% open-source / self-hosted. No API key, no external paid AI service.**

## Pipeline

```
Open-source LLM  ◄─  Prompt templates  ◄─  RAG / retrieval  ◄─  Vector DB (pgvector)
  (Ollama +                                                       ▲
   qwen2.5:3b-instruct,                              Embedding model (local, fastembed
   Apache-2.0)                                        BAAI/bge-small-en-v1.5, MIT)
```

| Piece | What | Licence |
|-------|------|---------|
| LLM | `ollama` container running `qwen2.5:1.5b-instruct` (`:3b` on a roomier host) | Apache-2.0 |
| Embeddings | `fastembed` `BAAI/bge-small-en-v1.5` (ONNX, in-process) | MIT |
| Vector DB | `pgvector` in the existing PostgreSQL/PostGIS DB | PostgreSQL Licence |
| HTTP / API | FastAPI + httpx | BSD / MIT |

No API key, no Anthropic/OpenAI, no network calls to any AI service. On an
8 GB / 4-core CPU box a question takes ~45–100 s (the UI shows a "Thinking…"
indicator); the JSON response schema + the backend's re-validation keep the
result **safe and correct even when the small model phrases the plan
imperfectly** — a bad layer/field becomes a clarifying question, never a
wrong or unsafe query.

## Request flow

```
Angular chatbot (GIS workspace left dock)
      │  POST /api/gis/ai/chat
      ▼
NestJS  GisAiController → GisAiService
      │  POST http://gis-ai:8000/plan   (message + this municipality's real,
      │                                  authorised layer catalog + RAG context)
      ▼
Python  RAG retrieve (pgvector)  →  prompt  →  Ollama / qwen2.5 (JSON output)
      │  returns a structured `operation` object — NEVER SQL
      ▼
NestJS  GisQueryCompilerService
      │  • re-validates every layer / field / value against the real catalog
      │  • compiles to ONE parameterised, read-only PostGIS query
      │  • executes in a READ ONLY transaction with statement_timeout
      ▼
Angular renders matches on the existing OpenLayers map (query highlight
        overlay) + the existing Attribute Table (ECQL feature-id filter)
```

The LLM never sees or emits SQL/ECQL. Every identifier in the compiled
query comes from `information_schema`; every value is a bound parameter.

## Endpoints (called only by the NestJS backend)

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/health`   | liveness + `llm_configured` flag |
| POST   | `/reindex`  | rebuild the RAG index for `{municipality_id}` |
| POST   | `/plan`     | message → validated structured `operation` |

## Configuration

| Env | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL` | — | same PostgreSQL/PostGIS DB as the rest of the platform |
| `OLLAMA_URL` | `http://ollama:11434` | self-hosted LLM runtime |
| `GIS_AI_LLM_MODEL` | `qwen2.5:3b-instruct` | translates NL → structured operation; use `qwen2.5:1.5b-instruct` on a very RAM-constrained host |
| `GIS_AI_LLM_AUTO_PULL` | `true` | pull the model on startup if missing |
| `GIS_AI_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | local, 384-dim, CPU |

The model downloads on first `docker compose up` (into the `ollama-models`
volume) — `/plan` returns HTTP 503 with a clear message until it's ready.
Manual pull: `docker compose exec ollama ollama pull qwen2.5:3b-instruct`.

## RAG corpus (all real, no dummy data)

- one doc per GIS layer (name, description, geometry, fields)
- one doc per attribute field, **with sampled real distinct values** from
  that municipality's own PostGIS table
- `app/knowledge/*.md` — GIS-tool capabilities + Indian municipal planning
  reference norms (URDPFI / Model Building Bye-laws) used only for phrasing

## Testing the compiler without the LLM

Set `GIS_AI_ENABLE_RAW_PLAN=true` on the NestJS backend to enable
`POST /api/gis/ai/execute-plan`, which runs a hand-written structured
`operation` through the same validation + compilation + execution path
(no LLM). Off by default.
