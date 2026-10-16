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
    kind: one of "select" "aggregate" "nearest" "buffer" "route"
      "service_area" (see KINDS),
    target_layer: <a code or name from AVAILABLE LAYERS>,
    attribute_filters: [ {field:<real column>, op:<one of
      = != > >= < <= in not_in like ilike between is_null is_not_null>,
      value:?, value2:? (for between), values:[] (for in/not_in)} ],
    spatial_filter: null, or {relation:<one of within_distance intersects
      within contains disjoint>, reference_layer:<code/name>,
      distance_meters:<number, for within_distance>, reference_filters:[]},
    limit: integer or null,
    ...plus the extra keys of its kind (omit or null the others) }

KINDS (target_layer + attribute_filters + spatial_filter pick the features):
- select: show / find / list features.
- aggregate: "how many", "count", "total", "average", "per ward".
  metric: count|sum|avg|min|max, metric_field: numeric column (null for
  count), group_by: a column of target_layer to group by, OR
  group_by_layer + group_by_layer_field: a polygon layer and its label
  column to count features falling inside each polygon ("per ward").
- nearest: "nearest / closest N X to Y". target_layer = X,
  reference_layer + reference_filters = Y, count = N (default 1).
- buffer: "buffer / zone of N m around X". target_layer = X,
  distance_meters = N.
- route: "route / path / road distance from A to B". target_layer +
  attribute_filters = A, to_layer + to_filters = B, network_layer = a
  road (LINE) layer or null.
- service_area: "area reachable within N m of X" on the road network.
  target_layer + attribute_filters = X, distance_meters = N,
  network_layer = a road (LINE) layer or null.

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
- "show / find / list / which / how many X ..." is a gis_operation, not
  an "answer". Only use "answer" for a question
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
    {"role": "user", "content": "How many street lights are there in each ward?"},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Count of street '
            'lights inside each ward.","clarification":null,"used_context":[],'
            '"operation":{"kind":"aggregate","target_layer":"STREET_LIGHTS",'
            '"attribute_filters":[],"spatial_filter":null,"metric":"count",'
            '"metric_field":null,"group_by":null,"group_by_layer":"WARDS",'
            '"group_by_layer_field":"ward_name","limit":null}}'
        ),
    },
    {"role": "user", "content": "Total plot area by land use."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Sum of plot area '
            'grouped by land use.","clarification":null,"used_context":[],'
            '"operation":{"kind":"aggregate","target_layer":"PLOTS",'
            '"attribute_filters":[],"spatial_filter":null,"metric":"sum",'
            '"metric_field":"area_sqm","group_by":"land_use","limit":null}}'
        ),
    },
    {"role": "user", "content": "Nearest 3 hospitals to the school named Vidya Niketan."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"The 3 hospitals '
            'closest to Vidya Niketan school.","clarification":null,'
            '"used_context":[],"operation":{"kind":"nearest","target_layer":'
            '"HOSPITALS","attribute_filters":[],"spatial_filter":null,'
            '"reference_layer":"SCHOOLS","reference_filters":[{"field":"name",'
            '"op":"ilike","value":"Vidya Niketan"}],"count":3}}'
        ),
    },
    {"role": "user", "content": "Make a 200 m buffer around the lakes."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"A 200 m zone around '
            'every lake.","clarification":null,"used_context":[],"operation":'
            '{"kind":"buffer","target_layer":"LAKES","attribute_filters":[],'
            '"spatial_filter":null,"distance_meters":200}}'
        ),
    },
    {"role": "user", "content": "Route from fire station 2 to ward office 7."},
    {
        "role": "assistant",
        "content": (
            '{"answer_kind":"gis_operation","explanation":"Shortest road route '
            'from fire station 2 to ward office 7.","clarification":null,'
            '"used_context":[],"operation":{"kind":"route","target_layer":'
            '"FIRE_STATIONS","attribute_filters":[{"field":"station_no","op":'
            '"=","value":2}],"spatial_filter":null,"to_layer":"WARD_OFFICES",'
            '"to_filters":[{"field":"ward_no","op":"=","value":7}],'
            '"network_layer":null}}'
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


# --------------------------------------------------------------------------
# Narration: verified facts -> 1-3 plain sentences. The facts are computed
# by the backend; the model only rephrases them.

NARRATE_SYSTEM = """You write a short answer for a municipal officer from VERIFIED FACTS.
Rules:
- 1 to 3 plain sentences, no markdown, no lists, no headings.
- Use ONLY the numbers and names that appear in FACTS. Never estimate,
  round differently, add, or invent a number, place, cause or recommendation.
- Lead with the direct answer to the question, then the most notable
  detail (largest group, nearest item, biggest change).
- If FACTS show zero results, say so plainly.
"""

RASTER_SYSTEM = """You explain a raster / remote-sensing analysis result to a municipal
officer who is not a GIS expert, from VERIFIED FACTS.
Rules:
- 2 to 4 plain sentences, no markdown, no lists.
- Say what the analysis measured, what the key numbers mean in everyday
  terms, and which zone / area stands out, if any.
- Use ONLY numbers and names that appear in FACTS. Never invent a number,
  place, date or cause. Do not give advice beyond "worth a field check"
  when FACTS show a notable change.
"""


def build_narrate_message(question: str, facts_json: str) -> str:
    return f"QUESTION: {question}\n\nFACTS (JSON):\n{facts_json}"
