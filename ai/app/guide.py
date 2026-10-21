"""Conversation guidance around the planner — no LLM calls.

  * preflight():   asks instead of guessing ("near" with no distance) and
                   refuses what would silently lose a condition (two
                   distance conditions in one question).
  * annotate():    says which fuzzy corrections were applied and offers the
                   close alternatives as clickable "Did you mean" options.
  * suggestions(): example questions built from the municipality's real
                   layers, kept only if the no-LLM fast path can plan them —
                   so every suggestion works.
"""
from __future__ import annotations

import re
from typing import List, Optional

from .fastpath import fast_plan
from .repair import _DISTANCE, _FREE_TEXT_FIELD, _NEAREST, _tokens, _value_core, _has_word
from .schema import AttributeFilter, ClarifyOption, GisOperation, LayerInfo, PlanResult

# "near / close to / next to / around / adjacent to <X>" with no distance.
_NEAR = re.compile(r"\b(near(?:by)?|close to|next to|adjacent to|around|surrounding)\b", re.I)
_WITHIN_DISTANCE = re.compile(
    r"\bwithin\s+\d+(?:\.\d+)?\s*(?:km|kilomet\w*|m|met\w*)\s+(?:of|from|around)\b", re.I
)
_NEAR_CHOICES = (50, 100, 250, 500)


def preflight(message: str) -> Optional[PlanResult]:
    text = message.strip()
    if len(_WITHIN_DISTANCE.findall(text)) >= 2:
        return PlanResult(
            answer_kind="unsupported",
            explanation=(
                "I can apply only one distance condition per question for now, so I won't "
                "answer this by silently dropping one. Ask with a single distance, e.g. "
                "the first part of your question."
            ),
        )
    near = _NEAR.search(text)
    if near and not _DISTANCE.search(text) and not _NEAREST.search(text):
        # "near X" -> "within N m of X": the fast path plans that instantly.
        options = [
            ClarifyOption(
                label=f"{d} m",
                message=(text[: near.start()] + f"within {d} m of" + text[near.end():]).strip(),
            )
            for d in _NEAR_CHOICES
        ]
        return PlanResult(
            answer_kind="clarification",
            explanation="The distance for “near” was not given.",
            clarification="How close counts as “near”?",
            options=options,
        )
    return None


def annotate(message: str, plan: PlanResult, layers: List[LayerInfo]) -> PlanResult:
    """Fuzzy-matched values are stated, with close alternatives to pick."""
    op = plan.operation
    if op is None:
        return plan
    target = next((l for l in layers if l.code == op.target_layer), None)
    if target is None:
        return plan
    lower = message.lower()
    words = set(_tokens(message))
    notes: List[str] = list(plan.notes)
    options: List[ClarifyOption] = list(plan.options)
    for index, f in enumerate(op.attribute_filters):
        values = [v for v in ([f.value] if f.value is not None else []) + list(f.values or []) if isinstance(v, str)]
        if not values or any(v.lower() in lower for v in values):
            continue  # the user typed it as stored
        field = next((x for x in target.fields if x.name == f.field), None)
        if field is None or f.op not in ("=", "in"):
            continue
        notes.append(f"Read your words as {f.field} = " + " / ".join(f"“{v}”" for v in values[:4]) + ".")
        chosen = set(values)
        alternatives = [
            v for v in field.sample_values
            if v != "…(more)" and v not in chosen
            and any(_has_word(c, words) for c in _value_core(v))
        ][:3]
        for alt in alternatives:
            changed = op.model_copy(deep=True)
            changed.attribute_filters[index] = AttributeFilter(field=f.field, op="=", value=alt)
            options.append(ClarifyOption(label=f"Did you mean “{alt}”?", operation=changed))
    if notes == plan.notes and options == plan.options:
        return plan
    return plan.model_copy(update={"notes": notes, "options": options})


def _category_fields(layer: LayerInfo):
    for f in layer.fields:
        values = [v for v in f.sample_values if v != "…(more)"]
        if (
            f.type == "text" and 2 <= len(values) <= 25 and "…(more)" not in f.sample_values
            and not _FREE_TEXT_FIELD.search(f.name)
            and not re.search(r"(^|_)(id|code|no|num)$", f.name, re.I)
            and not all(v.strip().lower() in {"yes", "no", "y", "n"} for v in values)
        ):
            yield f, values


def suggestions(layers: List[LayerInfo], limit: int = 8) -> List[str]:
    polygons = [l for l in layers if (l.geometry_type or "").upper() == "POLYGON"]
    per_layer: List[List[str]] = []
    # Things people count and filter (signals, pipelines) before areas.
    ordered = sorted(layers, key=lambda l: (l.geometry_type or "").upper() == "POLYGON")
    for layer in ordered:
        name = layer.name.replace("_", " ")
        candidates: List[str] = []
        for field, values in _category_fields(layer):
            layer_words = set(_tokens(f"{layer.name} {layer.code}"))
            # A clean, readable category: no lists, no long free text, not
            # just the layer's own name ("Lake" on the lake layer).
            value = next((
                v for v in values
                if 4 <= len(v) <= 30 and "," not in v and len(v.split()) <= 4
                and not set(_value_core(v)) <= layer_words
            ), None)
            if value:
                candidates.append(f"Show {name} that are {value}")
            candidates.append(f"Count {name} by {field.name}")
            break
        countable = (layer.geometry_type or "").upper() in ("POINT", "LINE")
        for poly in polygons if countable else []:
            if poly.code != layer.code:
                candidates.append(f"How many {name} are there in each {poly.name.replace('_', ' ')}?")
                break
        for other in layers if countable else []:
            if other.code != layer.code and (other.geometry_type or "").upper() in ("POLYGON", "LINE"):
                candidates.append(f"Find {name} within 100 m of the {other.name.replace('_', ' ')}")
                break
        # Only what the no-LLM planner can answer: every suggestion works.
        valid = [q for q in candidates if fast_plan(q, layers) is not None]
        # Rotate which kind of question each layer leads with, for variety.
        shift = len(per_layer) % len(valid) if valid else 0
        per_layer.append(valid[shift:] + valid[:shift])
    out: List[str] = []
    while len(out) < limit and any(per_layer):
        for qs in per_layer:  # round-robin: variety across layers
            if qs and len(out) < limit:
                out.append(qs.pop(0))
    return out
