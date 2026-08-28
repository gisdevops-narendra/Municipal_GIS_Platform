"""Structured GIS prompt templates.

Kept lean on purpose: it runs on a small local model on modest hardware, so
prompt-processing time matters. The RAG context + the response JSON schema
+ the Node-side re-validation carry most of the accuracy load.
"""
from __future__ import annotations

from typing import List

from .schema import LayerInfo
from .vectorstore import Retrieved

SYSTEM_PROMPT = """\
You convert a municipal planner's request into ONE structured GIS operation \
that runs against this municipality's real PostGIS data. You never write SQL.

Output: a single JSON object, no prose, no markdown fences. Keys:
  answer_kind: "gis_operation" | "clarification" | "answer" | "unsupported"
  explanation: 1-2 plain sentences
  clarification: string or null
  used_context: array of CONTEXT titles you used
  operation: null, or {
    kind: "select",
    target_layer: <a code or name from AVAILABLE LAYERS>,
    attribute_filters: [ {field:<real column>, op:<one of
      = != > >= < <= in not_in like ilike between is_null is_not_null>,
      value:?, value2:? (for between), values:[] (for in/not_in)} ],
    spatial_filter: null, or {relation:<one of within_distance intersects
      within contains disjoint>, reference_layer:<code/name>,
      distance_meters:<number, for within_distance>, reference_filters:[]},
    limit: integer or null }

The examples below show the OUTPUT FORMAT only. Their layer names
(BUILDINGS, PLOTS, ROADS, PARCELS, ...) are NOT real — never copy a layer
or field name from an example. Use only names from AVAILABLE LAYERS in the
user message, and answer the user's ACTUAL request.

Rules:
- Use ONLY layers from AVAILABLE LAYERS and ONLY their listed fields/values.
  If a layer the request needs is missing -> answer_kind "unsupported"
  (name what IS available). If which field/value the user means is unclear
  -> "clarification".
- Add an attribute_filter (or reference_filter) ONLY for a condition the
  user actually stated in words. If the user gave no attribute condition,
  attribute_filters MUST be []. Never invent a filter, a value, a number,
  or a field. A distance ("within 150 m") is NOT an attribute filter.
- "show / find / list / which X ... where/with/above/under/larger than ..."
  is a gis_operation, not an "answer". Only use "answer" for a question
  about the data itself ("what layers do I have", "what does this field
  mean").
- "within N m/km of X" -> spatial_filter within_distance (distance_meters).
  "inside / in / falls within X" -> within. "crosses / passes through X"
  -> intersects.
- Prefer an attribute filter when the layer already has the column
  (e.g. ward_no = 5 rather than a spatial "within ward 5" test).
- Convert to metres / square metres: 1 sq ft = 0.092903, 1 acre = 4046.86,
  1 mile = 1609.34.
"""


def _layer_block(layers: List[LayerInfo]) -> str:
    if not layers:
        return "AVAILABLE LAYERS: none"
    out = ["AVAILABLE LAYERS:"]
    for lyr in layers:
        head = f"- {lyr.name} [{lyr.code}] {lyr.geometry_type or ''}".rstrip()
        if lyr.description:
            head += f" — {lyr.description}"
        out.append(head)
        for f in lyr.fields:
            line = f"    {f.name} ({f.type})"
            if f.sample_values:
                line += " e.g. " + ", ".join(map(str, f.sample_values[:8]))
            out.append(line)
    return "\n".join(out)


def _context_block(snippets: List[Retrieved]) -> str:
    if not snippets:
        return ""
    out = ["CONTEXT (cite titles you use in used_context):"]
    for s in snippets[:8]:
        out.append(f"[{s.title}] {s.content}")
    return "\n".join(out)


FEWSHOT = [
    {"role": "user", "content": "Show buildings within 50m of roads."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Buildings within 50 m '
            'of any road.","clarification":null,"used_context":[],"operation":'
            '{"kind":"select","target_layer":"BUILDINGS","attribute_filters":[],'
            '"spatial_filter":{"relation":"within_distance","reference_layer":'
            '"ROADS","distance_meters":50,"reference_filters":[]},"limit":null}}'
        ),
    },
    {
        "role": "user",
        "content": "Find vacant properties larger than 2000 sq ft in Ward 5.",
    },
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Vacant plots over '
            '2000 sq ft (185.8 sq m) in ward 5.","clarification":null,'
            '"used_context":[],"operation":{"kind":"select","target_layer":'
            '"PLOTS","attribute_filters":[{"field":"land_use","op":"ilike",'
            '"value":"vacant"},{"field":"area_sqm","op":">","value":185.8},'
            '{"field":"ward_no","op":"=","value":5}],"spatial_filter":null,'
            '"limit":null}}'
        ),
    },
    {"role": "user", "content": "Find schools within 1 km of hospitals."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Schools within 1 km '
            'of any hospital.","clarification":null,"used_context":[],'
            '"operation":{"kind":"select","target_layer":"SCHOOLS",'
            '"attribute_filters":[],"spatial_filter":{"relation":'
            '"within_distance","reference_layer":"HOSPITALS","distance_meters":'
            '1000,"reference_filters":[]},"limit":null}}'
        ),
    },
    {"role": "user", "content": "Which parcels have an area over 500 sq m?"},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Parcels with an area '
            'greater than 500 sq m.","clarification":null,"used_context":[],'
            '"operation":{"kind":"select","target_layer":"PARCELS",'
            '"attribute_filters":[{"field":"area_sqm","op":">","value":500}],'
            '"spatial_filter":null,"limit":null}}'
        ),
    },
    {"role": "user", "content": "Show all street lights in zone 3."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Street lights that '
            'fall inside zone 3.","clarification":null,"used_context":[],'
            '"operation":{"kind":"select","target_layer":"STREET_LIGHTS",'
            '"attribute_filters":[],"spatial_filter":{"relation":"within",'
            '"reference_layer":"ZONES","reference_filters":[{"field":"zone_no",'
            '"op":"=","value":3}]},"limit":null}}'
        ),
    },
]


def build_user_message(
    message: str,
    layers: List[LayerInfo],
    snippets: List[Retrieved],
    municipality_name: str | None,
) -> str:
    ctx = _context_block(snippets)
    parts = [_layer_block(layers)]
    if ctx:
        parts.append(ctx)
    parts.append(f"REQUEST: {message}")
    return "\n\n".join(parts)
