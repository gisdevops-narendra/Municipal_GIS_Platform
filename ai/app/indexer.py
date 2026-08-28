"""Builds / refreshes the RAG index.

Corpus =
  * one document per GIS layer (name, description, geometry, table);
  * one document per attribute field (type + sampled real values);
  * static GIS-tool capability docs and municipal planning reference notes.

Layer/field docs are municipality-scoped; the knowledge docs are global.
"""
from __future__ import annotations

import glob
import os
import re
from typing import List

from . import config, embeddings
from .catalog import LayerCatalog, load_municipality_catalog
from .vectorstore import RagDoc, replace_scope


def _layer_doc(layer: LayerCatalog) -> RagDoc:
    lines = [
        f"GIS layer: {layer.name} (code {layer.code}).",
        f"Geometry: {layer.geometry_type or 'unknown'}.",
    ]
    if layer.description:
        lines.append(f"Description: {layer.description}.")
    field_names = [c.name for c in layer.columns]
    if field_names:
        lines.append("Attribute fields: " + ", ".join(field_names) + ".")
    lines.append(
        "Use this layer as target_layer or reference_layer in a spatial "
        "operation."
    )
    return RagDoc(
        municipality_id=None,  # set by caller
        doc_type="layer",
        ref_key=f"layer:{layer.layer_id}",
        title=f"Layer · {layer.name}",
        content="\n".join(lines),
    )


def _field_docs(layer: LayerCatalog) -> List[RagDoc]:
    docs: List[RagDoc] = []
    for col in layer.columns:
        parts = [
            f'Field "{col.name}" on layer "{layer.name}" (code {layer.code}).',
            f"Data type: {col.data_type} ({col.kind}).",
        ]
        if col.sample_values:
            shown = ", ".join(repr(v) for v in col.sample_values[:20])
            parts.append(f"Example values: {shown}.")
        docs.append(
            RagDoc(
                municipality_id=None,
                doc_type="field",
                ref_key=f"field:{layer.layer_id}:{col.name}",
                title=f"Field · {layer.name}.{col.name}",
                content=" ".join(parts),
            )
        )
    return docs


def _knowledge_docs() -> List[RagDoc]:
    docs: List[RagDoc] = []
    for path in sorted(glob.glob(os.path.join(config.RULES_DIR, "*.md"))):
        base = os.path.splitext(os.path.basename(path))[0]
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        # split on markdown H2 so each chunk is a focused topic
        chunks = re.split(r"\n(?=## )", text)
        for i, chunk in enumerate(chunks):
            chunk = chunk.strip()
            if len(chunk) < 40:
                continue
            heading = chunk.splitlines()[0].lstrip("# ").strip() or f"section {i}"
            doc_type = "tool" if "tool" in base or "operation" in base else "rule"
            docs.append(
                RagDoc(
                    municipality_id=None,
                    doc_type=doc_type,
                    ref_key=f"kb:{base}:{i}",
                    title=f"Reference · {heading}",
                    content=chunk,
                )
            )
    return docs


async def reindex_municipality(municipality_id: str) -> dict:
    layers = await load_municipality_catalog(municipality_id)

    layer_docs: List[RagDoc] = []
    for layer in layers:
        d = _layer_doc(layer)
        d.municipality_id = municipality_id
        layer_docs.append(d)
        for fd in _field_docs(layer):
            fd.municipality_id = municipality_id
            layer_docs.append(fd)

    n_layer = 0
    if layer_docs or not layers:
        vecs = embeddings.embed_documents([d.content for d in layer_docs])
        n_layer = await replace_scope(
            municipality_id, ["layer", "field"], layer_docs, vecs
        )

    # global knowledge — refresh whenever any municipality reindexes so a
    # deploy that changed the .md files takes effect.
    kb_docs = _knowledge_docs()
    kb_vecs = embeddings.embed_documents([d.content for d in kb_docs])
    n_kb = await replace_scope(None, ["tool", "rule"], kb_docs, kb_vecs)

    return {
        "municipality_id": municipality_id,
        "layers_indexed": len(layers),
        "layer_field_documents": n_layer,
        "knowledge_documents": n_kb,
    }
