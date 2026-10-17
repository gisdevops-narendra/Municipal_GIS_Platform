"""Deterministic repair of the small local model's plan.

qwen2.5:1.5b reliably understands *what* is asked (its explanation is
right) but often drops the newer operation fields: it answers "how many
valves in each ward?" as `unsupported` with no operation, or picks
`aggregate` for "total pipe length" without a metric. The question's own
words carry those details, so this step reads them and fills / corrects
the plan:

  * intent words -> kind  (how many / total / average -> aggregate,
    nearest -> nearest, buffer -> buffer, route -> route, ...)
  * "total length / area" -> metric sum of the geometry measure
  * "in each / per / by <polygon layer>" -> group_by_layer
  * "by <field>" -> group_by
  * "nearest 3", "200 m", "2 km" -> count / distance_meters
  * layer names mentioned in the question -> target layer when missing

It only ever names layers / fields from AVAILABLE LAYERS, and the Node
backend still validates every field — a wrong repair becomes a
clarification, never an unsafe query.
"""
from __future__ import annotations

import logging
import re
from typing import List, Optional, Tuple

from .schema import GisOperation, LayerInfo, PlanResult

log = logging.getLogger("gis-ai.repair")

_AGG_COUNT = re.compile(r"\b(how many|count|number of|no\. of)\b", re.I)
_AGG_SUM = re.compile(r"\b(total|sum)\b", re.I)
_AGG_AVG = re.compile(r"\b(average|avg|mean)\b", re.I)
_AGG_MAX = re.compile(r"\b(maximum|max|largest|longest|biggest|highest)\b", re.I)
_AGG_MIN = re.compile(r"\b(minimum|min|smallest|shortest|lowest)\b", re.I)
_NEAREST = re.compile(r"\b(nearest|closest)\b(?:\s+(\d+))?", re.I)
_BUFFER = re.compile(r"\bbuffer\b", re.I)
_ROUTE = re.compile(r"\b(route|directions|path)\b.*\bfrom\b.*\bto\b|\broad distance\b", re.I)
_SERVICE = re.compile(r"\b(service area|reachable|can be reached)\b", re.I)
_DISTANCE = re.compile(r"(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|m|met(?:er|re)s?)\b", re.I)
_GROUP = re.compile(r"\b(?:in each|for each|per|in every|each|by|across|in all)\s+([a-z0-9_ ]+)", re.I)
_LENGTH = re.compile(r"\b(length|long|km of|kilometres of|kilometers of)\b", re.I)
_AREA = re.compile(r"\b(area|sq\.? ?m|square met|hectare|acre)\b", re.I)


def _tokens(text: str) -> List[str]:
    out = []
    for t in re.split(r"[^a-z0-9]+", text.lower()):
        if not t:
            continue
        if len(t) > 3 and t.endswith("es") and not t.endswith("ses"):
            t = t[:-2] if t[:-2].endswith(("ch", "sh", "x")) else t[:-1]
        elif len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
            t = t[:-1]
        out.append(t)
    return out


_GENERIC = {"layer", "data", "proposed", "existing", "gis", "map", "the", "of", "and"}


def _layer_score(layer: LayerInfo, words: List[str]) -> float:
    """Share of the layer's distinctive name tokens that appear in `words`."""
    name_tokens = [t for t in _tokens(f"{layer.name} {layer.code}") if t not in _GENERIC]
    if not name_tokens:
        return 0.0
    distinct = set(name_tokens)
    hits = sum(1 for t in distinct if t in words)
    return hits / len(distinct)


def _mentioned_layers(text: str, layers: List[LayerInfo]) -> List[Tuple[LayerInfo, float, int]]:
    """Layers named in `text`, best first, with the position of the first hit."""
    words = _tokens(text)
    found = []
    for lyr in layers:
        score = _layer_score(lyr, words)
        if score >= 0.5:
            name_tokens = set(_tokens(f"{lyr.name} {lyr.code}")) - _GENERIC
            pos = min((i for i, w in enumerate(words) if w in name_tokens), default=len(words))
            found.append((lyr, score, pos))
    found.sort(key=lambda f: (-f[1], f[2]))
    return found


def _find_layer(layers: List[LayerInfo], ref: Optional[str]) -> Optional[LayerInfo]:
    if not ref:
        return None
    needle = ref.strip().lower()
    for lyr in layers:
        if needle in (lyr.code.lower(), lyr.name.lower(), lyr.id.lower()):
            return lyr
    return None


def _distance_m(text: str) -> Optional[float]:
    m = _DISTANCE.search(text)
    if not m:
        return None
    value = float(m.group(1))
    return value * 1000 if m.group(2).lower().startswith("k") else value


def _metric(text: str) -> Optional[str]:
    if _AGG_AVG.search(text):
        return "avg"
    if _AGG_SUM.search(text) and not re.search(r"\btotal (number|count)\b", text, re.I):
        return "sum"
    if _AGG_MAX.search(text):
        return "max"
    if _AGG_MIN.search(text):
        return "min"
    if _AGG_COUNT.search(text):
        return "count"
    return None


def _measure_field(text: str, target: Optional[LayerInfo]) -> Optional[str]:
    """A numeric field named in the text, else the geometry measure."""
    if target:
        words = _tokens(text)
        for f in target.fields:
            if f.type in ("integer", "number") and f.name.lower() not in ("ogc_fid", "id", "objectid"):
                parts = [p for p in _tokens(f.name) if len(p) > 2]
                if parts and all(p in words or any(w.startswith(p) for w in words) for p in parts):
                    return f.name
    geom = (target.geometry_type or "").upper() if target else ""
    if _LENGTH.search(text) and geom in ("LINE", ""):
        return "length"
    if _AREA.search(text) and geom in ("POLYGON", ""):
        return "area"
    return None


def _grouping(text: str, layers: List[LayerInfo], target: Optional[LayerInfo]) -> Tuple[Optional[str], Optional[str]]:
    """(group_by_layer, group_by) from "in each ward" / "by valve type"."""
    for m in _GROUP.finditer(text):
        phrase = m.group(1)
        polys = [
            f for f in _mentioned_layers(phrase, layers)
            if (f[0].geometry_type or "").upper() == "POLYGON" and (not target or f[0].id != target.id)
        ]
        if polys:
            return polys[0][0].code, None
        if target:
            words = _tokens(phrase)[:4]
            best: Tuple[int, Optional[str]] = (0, None)
            for fld in target.fields:
                if fld.type != "text" or _is_identifier(fld.name):
                    continue
                parts = [p for p in _tokens(fld.name) if len(p) > 2]
                hits = sum(1 for p in parts if p in words or any(w.startswith(p[:4]) for w in words))
                if hits > best[0]:
                    best = (hits, fld.name)
            if best[1]:
                return None, best[1]
    return None, None


_IDENTIFIER = re.compile(r"(^|_)(id|gisid|objectid|fid|gid|code|no|num|number)$", re.I)


def _is_identifier(field: str) -> bool:
    """valve_id, gisid, ... — one value per feature, never a useful grouping."""
    return bool(_IDENTIFIER.search(field))


def repair_plan(message: str, plan: PlanResult, layers: List[LayerInfo]) -> PlanResult:
    if plan.answer_kind == "clarification" and plan.operation is None:
        return plan
    text = message
    notes: List[str] = []
    op = plan.operation

    metric = _metric(text)
    nearest = _NEAREST.search(text)
    wants = (
        "nearest" if nearest
        else "route" if _ROUTE.search(text)
        else "service_area" if _SERVICE.search(text)
        else "buffer" if _BUFFER.search(text)
        else "aggregate" if metric
        else None
    )

    mentioned = _mentioned_layers(text, layers)
    target = _find_layer(layers, op.target_layer if op else None)

    # No operation at all, but the request is clearly an aggregate / buffer
    # over a layer the question names: build it.
    if op is None:
        if wants not in ("aggregate", "buffer") or not mentioned:
            return plan
        group_layer, _ = _grouping(text, layers, None)
        candidates = [f for f in mentioned if f[0].code != group_layer]
        if not candidates:
            return plan
        target = candidates[0][0]
        op = GisOperation(kind=wants, target_layer=target.code)
        notes.append(f"built a {wants} operation on {target.name} from the question")

    if target is None and mentioned:
        target = mentioned[0][0]
        op.target_layer = target.code
        notes.append(f"target layer -> {target.name}")

    if wants and op.kind != wants and op.kind in ("select", "aggregate") and wants in ("aggregate", "nearest", "buffer"):
        notes.append(f"kind {op.kind} -> {wants}")
        op.kind = wants

    if op.kind == "aggregate":
        if op.metric is None or (metric and metric != "count" and op.metric == "count"):
            op.metric = metric or "count"
            notes.append(f"metric -> {op.metric}")
        if op.metric != "count" and not op.metric_field:
            op.metric_field = _measure_field(text, target)
            if op.metric_field:
                notes.append(f"metric_field -> {op.metric_field}")
        # The model likes grouping by the id column ("count valves by valve
        # type" -> valve_id); unless the question asks for ids, regroup.
        if op.group_by and _is_identifier(op.group_by) and not re.search(r"\bid\b", text, re.I):
            group_layer, group_field = _grouping(text, layers, target)
            if group_field or group_layer:
                notes.append(f"group_by {op.group_by} -> {group_field or group_layer}")
                op.group_by, op.group_by_layer = group_field, group_layer
        if not op.group_by and not op.group_by_layer:
            group_layer, group_field = _grouping(text, layers, target)
            if group_layer:
                op.group_by_layer = group_layer
                notes.append(f"group_by_layer -> {group_layer}")
            elif group_field:
                op.group_by = group_field
                notes.append(f"group_by -> {group_field}")

    if op.kind == "nearest" and not op.count and nearest and nearest.group(2):
        op.count = int(nearest.group(2))
        notes.append(f"count -> {op.count}")

    if op.kind in ("buffer", "service_area") and not op.distance_meters:
        d = _distance_m(text)
        if d:
            op.distance_meters = d
            notes.append(f"distance -> {d:g} m")

    if not notes:
        return plan
    log.info("plan repaired (%s): %s", message[:80], "; ".join(notes))
    return plan.model_copy(
        update={
            "answer_kind": "gis_operation",
            "operation": op,
            "clarification": None,
            "explanation": plan.explanation or "Interpreted from the question.",
        }
    )
