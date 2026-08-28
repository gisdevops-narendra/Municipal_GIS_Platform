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


class GisOperation(BaseModel):
    kind: Literal["select"] = "select"
    target_layer: str
    attribute_filters: List[AttributeFilter] = Field(default_factory=list)
    spatial_filter: Optional[SpatialFilter] = None
    limit: Optional[int] = None


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


class ReindexRequest(BaseModel):
    municipality_id: str


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
                "kind": {"type": "string", "enum": ["select"]},
                "target_layer": {"type": "string"},
                "limit": {"type": ["integer", "null"]},
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
