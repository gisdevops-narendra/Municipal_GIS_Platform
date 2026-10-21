"""Wire contracts.

`GisOperation` is the ONLY structured artefact the LLM is allowed to emit
for a GIS request. The Node.js backend re-validates every field of it
against the caller's real, authorised layer catalog before compiling it to
parameterised SQL — so this schema is a convenience/typing layer, not the
security boundary.
"""
from __future__ import annotations

from typing import List, Literal, Optional, Union

from pydantic import BaseModel, Field

AttrOp = Literal[
    "=", "!=", ">", ">=", "<", "<=",
    "in", "not_in", "like", "ilike", "between",
    "is_null", "is_not_null",
]

Scalar = Union[str, int, float, bool]

SpatialRelation = Literal[
    "within_distance", "intersects", "within", "contains", "disjoint"
]

AnswerKind = Literal["gis_operation", "clarification", "answer", "unsupported"]


class AttributeFilter(BaseModel):
    field: str
    op: AttrOp
    value: Optional[Scalar] = None
    value2: Optional[Scalar] = None            # BETWEEN upper bound
    values: Optional[List[Scalar]] = None      # IN / NOT IN list


class SpatialFilter(BaseModel):
    relation: SpatialRelation
    reference_layer: str
    distance_meters: Optional[float] = None
    reference_filters: List[AttributeFilter] = Field(default_factory=list)


OperationKind = Literal[
    "select", "aggregate", "nearest", "buffer", "route", "service_area"
]

Metric = Literal["count", "sum", "avg", "min", "max"]


class GisOperation(BaseModel):
    """One flat shape for every kind (easier for a small model than a
    discriminated union); each kind reads only the fields it needs."""

    kind: OperationKind = "select"
    target_layer: str
    attribute_filters: List[AttributeFilter] = Field(default_factory=list)
    spatial_filter: Optional[SpatialFilter] = None
    limit: Optional[int] = None
    # select: "the 10 tallest" -> order_by=height, order_desc=True, limit=10
    order_by: Optional[str] = None
    order_desc: Optional[bool] = None
    # aggregate
    metric: Optional[Metric] = None
    metric_field: Optional[str] = None
    group_by: Optional[str] = None
    group_by_layer: Optional[str] = None
    group_by_layer_field: Optional[str] = None
    # nearest
    reference_layer: Optional[str] = None
    reference_filters: List[AttributeFilter] = Field(default_factory=list)
    count: Optional[int] = None
    # buffer / service_area
    distance_meters: Optional[float] = None
    # route
    to_layer: Optional[str] = None
    to_filters: List[AttributeFilter] = Field(default_factory=list)
    network_layer: Optional[str] = None


class PlanResult(BaseModel):
    answer_kind: AnswerKind
    # short, user-facing natural-language explanation of what will run / why not
    explanation: str
    operation: Optional[GisOperation] = None
    # populated when answer_kind == "clarification"
    clarification: Optional[str] = None
    # titles of the RAG snippets that informed the plan (for transparency)
    used_context: List[str] = Field(default_factory=list)


# ---- request bodies -------------------------------------------------------

class LayerField(BaseModel):
    name: str
    type: str                     # 'text'|'integer'|'number'|'date'|'boolean'|'id'
    sample_values: List[str] = Field(default_factory=list)


class LayerInfo(BaseModel):
    id: str
    code: str
    name: str
    geometry_type: Optional[str] = None
    description: Optional[str] = None
    fields: List[LayerField] = Field(default_factory=list)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class PlanRequest(BaseModel):
    message: str
    municipality_id: str
    municipality_name: Optional[str] = None
    layers: List[LayerInfo] = Field(default_factory=list)
    history: List[ChatTurn] = Field(default_factory=list)
    # The plan of the previous answer, so a follow-up ("now only those in
    # ward 5") extends the exact operation instead of re-reading prose.
    previous_operation: Optional[GisOperation] = None


class ReindexRequest(BaseModel):
    municipality_id: str


class NarrateRequest(BaseModel):
    """Verified facts (computed by the backend, never by the LLM) to be
    rewritten as a short plain-language answer."""

    kind: Literal["query", "raster"] = "query"
    question: str = Field(max_length=2000)
    facts: dict
    municipality_name: Optional[str] = None


class NarrateResult(BaseModel):
    text: str
    # False when the model's text was rejected (e.g. it introduced a number
    # that is not in the facts) and the caller should keep its own sentence.
    grounded: bool


class SearchRequest(BaseModel):
    query: str = Field(max_length=200)
    municipality_id: str
    top_k: int = 12


class SearchHit(BaseModel):
    layer_id: str
    field: Optional[str] = None
    title: str
    score: float


# ---- JSON schema handed to the LLM (output_config.format) ----------------

_ATTR_FILTER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "field": {"type": "string"},
        "op": {
            "type": "string",
            "enum": list(AttrOp.__args__),  # type: ignore[attr-defined]
        },
        "value": {"type": ["string", "number", "boolean", "null"]},
        "value2": {"type": ["string", "number", "boolean", "null"]},
        "values": {
            "type": ["array", "null"],
            "items": {"type": ["string", "number", "boolean"]},
        },
    },
    "required": ["field", "op"],
}

PLAN_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "answer_kind": {
            "type": "string",
            "enum": list(AnswerKind.__args__),  # type: ignore[attr-defined]
        },
        "explanation": {"type": "string"},
        "clarification": {"type": ["string", "null"]},
        "used_context": {"type": "array", "items": {"type": "string"}},
        "operation": {
            "type": ["object", "null"],
            "additionalProperties": False,
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": list(OperationKind.__args__),  # type: ignore[attr-defined]
                },
                "target_layer": {"type": "string"},
                "limit": {"type": ["integer", "null"]},
                "order_by": {"type": ["string", "null"]},
                "order_desc": {"type": ["boolean", "null"]},
                "metric": {
                    "type": ["string", "null"],
                    "enum": [*Metric.__args__, None],  # type: ignore[attr-defined]
                },
                "metric_field": {"type": ["string", "null"]},
                "group_by": {"type": ["string", "null"]},
                "group_by_layer": {"type": ["string", "null"]},
                "group_by_layer_field": {"type": ["string", "null"]},
                "reference_layer": {"type": ["string", "null"]},
                "reference_filters": {"type": "array", "items": _ATTR_FILTER_SCHEMA},
                "count": {"type": ["integer", "null"]},
                "distance_meters": {"type": ["number", "null"]},
                "to_layer": {"type": ["string", "null"]},
                "to_filters": {"type": "array", "items": _ATTR_FILTER_SCHEMA},
                "network_layer": {"type": ["string", "null"]},
                "attribute_filters": {
                    "type": "array",
                    "items": _ATTR_FILTER_SCHEMA,
                },
                "spatial_filter": {
                    "type": ["object", "null"],
                    "additionalProperties": False,
                    "properties": {
                        "relation": {
                            "type": "string",
                            "enum": list(SpatialRelation.__args__),  # type: ignore[attr-defined]
                        },
                        "reference_layer": {"type": "string"},
                        "distance_meters": {"type": ["number", "null"]},
                        "reference_filters": {
                            "type": "array",
                            "items": _ATTR_FILTER_SCHEMA,
                        },
                    },
                    "required": ["relation", "reference_layer"],
                },
            },
            "required": ["kind", "target_layer", "attribute_filters"],
        },
    },
    "required": ["answer_kind", "explanation"],
}
