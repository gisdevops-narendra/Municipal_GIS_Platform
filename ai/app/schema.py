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
    # More spatial conditions, ANDed with spatial_filter.
    spatial_filters: List[SpatialFilter] = Field(default_factory=list)
    limit: Optional[int] = None
    # nearest: one answer per reference feature ("nearest X to each Y")
    per_reference: Optional[bool] = None
    # select: "the 10 tallest" -> order_by=height, order_desc=True, limit=10
    order_by: Optional[str] = None
    order_desc: Optional[bool] = None
    # aggregate
    metric: Optional[Metric] = None
    metric_field: Optional[str] = None
    group_by: Optional[str] = None
    group_by_layer: Optional[str] = None
    group_by_layer_field: Optional[str] = None
    # aggregate step 2: keep groups passing a threshold ("wards with more
    # than 100 signals"); `limit` + `order_desc` keep the top / lowest N.
    having_op: Optional[Literal[">", ">=", "<", "<=", "="]] = None
    having_value: Optional[float] = None
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


class ClarifyOption(BaseModel):
    """A clickable choice: re-ask with `message`, or run `operation` as is
    (the backend validates it like any plan)."""
    label: str
    message: Optional[str] = None
    operation: Optional[GisOperation] = None


class Instruction(BaseModel):
    """A standing instruction for the rest of the chat ("from now on only
    show working signals" -> layer SIGNAL, type = Working; "use 200 m for
    near" -> near_m 200)."""
    text: str
    layer: Optional[str] = None
    filters: List[AttributeFilter] = Field(default_factory=list)
    near_m: Optional[float] = None


class PlanResult(BaseModel):
    answer_kind: AnswerKind
    # short, user-facing natural-language explanation of what will run / why not
    explanation: str
    operation: Optional[GisOperation] = None
    # populated when answer_kind == "clarification"
    clarification: Optional[str] = None
    # titles of the RAG snippets that informed the plan (for transparency)
    used_context: List[str] = Field(default_factory=list)
    # Which path produced the plan: "fast" (no LLM) or "model". Set by the
    # service, never by the model (not in PLAN_JSON_SCHEMA).
    planner: Optional[Literal["fast", "model"]] = None
    # Clickable choices (clarification, "Did you mean ...") and plain notes
    # about how the question was read (fuzzy corrections). Set by the
    # service, never by the model.
    options: List[ClarifyOption] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)
    # A new standing instruction to save ("add"), or "clear" all of them.
    instruction: Optional[Instruction] = None
    instruction_action: Optional[Literal["add", "clear"]] = None


# ---- request bodies -------------------------------------------------------

class LayerField(BaseModel):
    name: str
    type: str                     # 'text'|'integer'|'number'|'date'|'boolean'|'id'
    sample_values: List[str] = Field(default_factory=list)
    # learned from the data at upload (see metadata.py); absent = unknown
    role: Optional[str] = None    # id|name|category|measure|free_text|date|flag|hidden
    unit: Optional[str] = None
    description: Optional[str] = None
    aliases: List[str] = Field(default_factory=list)


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
    # Standing instructions saved in this conversation.
    instructions: List[Instruction] = Field(default_factory=list)
    # Assistant setting "Instant answers only": never call the model.
    instant_only: bool = False


class SuggestRequest(BaseModel):
    layers: List[LayerInfo] = Field(default_factory=list)


class ReindexRequest(BaseModel):
    municipality_id: str


class IconTermsField(BaseModel):
    name: str = Field(max_length=120)
    sample_values: List[str] = Field(default_factory=list, max_length=8)


class IconTermsRequest(BaseModel):
    """A layer to find a map-marker icon for: its name and what it holds."""

    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=1000)
    geometry_type: Optional[str] = None
    fields: List[IconTermsField] = Field(default_factory=list, max_length=8)


class IconTermsResult(BaseModel):
    # English icon-library search words, most specific first.
    terms: List[str]


ICON_TERMS_JSON_SCHEMA = {
    "type": "object",
    "properties": {"terms": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 6}},
    "required": ["terms"],
}


class NarrateRequest(BaseModel):
    """Verified facts (computed by the backend, never by the LLM) to be
    rewritten as a short plain-language answer."""

    kind: Literal["query", "raster"] = "query"
    question: str = Field(max_length=2000)
    facts: dict
    municipality_name: Optional[str] = None
    # Language of the wording (assistant setting): en | mr | hi.
    language: Optional[Literal["en", "mr", "hi"]] = None


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

_SPATIAL_FILTER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "relation": {"type": "string", "enum": list(SpatialRelation.__args__)},  # type: ignore[attr-defined]
        "reference_layer": {"type": "string"},
        "distance_meters": {"type": ["number", "null"]},
        "reference_filters": {"type": "array", "items": _ATTR_FILTER_SCHEMA},
    },
    "required": ["relation", "reference_layer"],
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
                "per_reference": {"type": ["boolean", "null"]},
                "order_desc": {"type": ["boolean", "null"]},
                "metric": {
                    "type": ["string", "null"],
                    "enum": [*Metric.__args__, None],  # type: ignore[attr-defined]
                },
                "metric_field": {"type": ["string", "null"]},
                "group_by": {"type": ["string", "null"]},
                "group_by_layer": {"type": ["string", "null"]},
                "group_by_layer_field": {"type": ["string", "null"]},
                "having_op": {"type": ["string", "null"], "enum": [">", ">=", "<", "<=", "=", None]},
                "having_value": {"type": ["number", "null"]},
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
                "spatial_filters": {"type": "array", "items": _SPATIAL_FILTER_SCHEMA},
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
