"""Local embedding model (fastembed / ONNX).

A small, CPU-friendly sentence-embedding model runs in-process — no
external embedding API is called, so the RAG index can be built offline
and deterministically. Default: BAAI/bge-small-en-v1.5 (384-dim).
"""
from __future__ import annotations

import threading
from typing import List

from . import config

_model = None
_lock = threading.Lock()


def _get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from fastembed import TextEmbedding

                _model = TextEmbedding(model_name=config.EMBEDDING_MODEL)
    return _model


def embed_documents(texts: List[str]) -> List[List[float]]:
    if not texts:
        return []
    model = _get_model()
    return [vec.tolist() for vec in model.embed(texts)]


def embed_query(text: str) -> List[float]:
    model = _get_model()
    # bge models recommend a retrieval prefix for the query side.
    prefixed = f"Represent this sentence for searching relevant passages: {text}"
    return next(iter(model.embed([prefixed]))).tolist()


def warm() -> None:
    """Force the model to load (called on startup)."""
    _get_model()
