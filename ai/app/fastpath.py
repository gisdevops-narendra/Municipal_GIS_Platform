"""Plans simple requests without calling the LLM.

On a CPU-only host every model call costs seconds, yet many requests are
made of a few recognisable pieces:

  * a layer to show or count           "show signals", "how many signals"
  * a category value of that layer     "Not Working", "Dehu Alandi Road"
  * an area number                     "in zone no 13", "ward 7"
  * a numeric comparison               "taller than 5 m", "diameter over 300"
  * a distance to another layer        "within 300 m of Pawna River"
  * grouping                           "in each zone", "by type"
  * a follow-up on the previous plan   "now only those in ward 5"
  * several values of one column       "Pedestrian or Fixed time signals"
  * a negated value / yes-no column    "landmarks other than Religious",
                                       "signals not at a chowk"
  * a range                            "height between 4 and 6"
  * the N largest / smallest           "the 10 tallest signals",
                                       "top 5 pipelines by diameter"

When EVERY word of the request is accounted for by such pieces, the plan is
built directly from them. Any word left over means the request says more
than this can express, so it goes to the model instead — the fast path never
silently drops a condition. The plan still goes through the backend's full
validation, like any other.
"""
from __future__ import annotations

import re
from typing import List, Optional, Set, Tuple

from .repair import (
    _CODED,
    _FOLLOW_UP,
    _NUMBERED,
    _coded_filters,
    is_follow_up,
    _drop_redundant_area_filter,
    _find_layer,
    _grouping,
    _has_word,
    _mentioned_layers,
    _numbered_field,
    _numbered_filters,
    _tokens,
    _value_phrase_filters,
    abbreviation_words,
    implied_layers,
    matching_values,
    value_filter,
)
from .schema import AttributeFilter, GisOperation, LayerInfo, PlanResult, SpatialFilter

# Words that carry no condition of their own.
_FILLER = set(_tokens(
    "show display list find get locate highlight view see give me please all the a an "
    "of in on at with that which who are is there where what feature features layer "
    "layers map data record records every entire whole any have has or and made built"
))
_COUNT_WORDS = set(_tokens("how many count number total no"))
_GROUP_WORDS = set(_tokens("each every per by"))
_NUMBER_MARKERS = set(_tokens("no number num"))
_FOLLOW_WORDS = set(_tokens("now only those these them they ones one same previous of among just also"))

_COUNTING = re.compile(r"^\s*(how many|count|number of)\b", re.I)

# "within 300 m of Pawna River", "within 1.5 km from the BRTS" — each one
# a spatial condition; several are ANDed.
_WITHIN_HEAD = re.compile(
    r"\bwithin\s+(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>km|kilomet\w*|m|met\w*)\s+(?:of|from|around)\s+",
    re.I,
)

# "taller than 5 m", "diameter more than 300", "height at least 4", "below 2"
_COMPARE = re.compile(
    r"\b(?:(?P<field>[a-z][a-z_]*)\s+)?(?:is\s+|are\s+|of\s+)?"
    r"(?P<cmp>taller|higher|greater|more|larger|bigger|wider|longer|above|over|"
    r"shorter|lower|less|smaller|narrower|below|under|at least|at most|minimum|maximum)"
    r"(?:\s+than)?\s+(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>mm|cm|km|kilomet\w*|m|met\w*)?\b",
    re.I,
)
_CMP_OP = {
    **dict.fromkeys(["taller", "higher", "greater", "more", "larger", "bigger", "wider", "longer", "above", "over"], ">"),
    **dict.fromkeys(["shorter", "lower", "less", "smaller", "narrower", "below", "under"], "<"),
    "at least": ">=", "minimum": ">=", "at most": "<=", "maximum": "<=",
}
# A comparison word that already says which measure is meant.
_CMP_IMPLIES = {
    "taller": "height", "shorter": "height", "higher": "height",
    "wider": "width", "narrower": "width", "longer": "length",
}


_NEGATION = re.compile(
    r"\b(?P<neg>not|except|excluding|other than|without|non)\s+(?:at\s+|in\s+|on\s+|a\s+|an\s+|the\s+)*(?P<rest>.+)$",
    re.I,
)

# "the 10 tallest signals" / "5 largest pipelines"
_SUPERLATIVE = re.compile(
    r"\b(?:top\s+)?(?P<n>\d+)\s+(?P<sup>tallest|highest|largest|biggest|longest|widest|deepest|"
    r"shortest|smallest|lowest|narrowest)\b",
    re.I,
)
_SUP_DESC = {"tallest", "highest", "largest", "biggest", "longest", "widest", "deepest"}
_SUP_IMPLIES = {
    "tallest": "height", "highest": "height", "shortest": "height", "lowest": "height",
    "longest": "length", "widest": "width", "narrowest": "width", "deepest": "depth",
}
# "top 5 pipelines by diameter"
_TOP_BY = re.compile(r"\btop\s+(?P<n>\d+)\b.*?\bby\s+(?P<field>[a-z][a-z_ ]*)$", re.I)
# "height between 4 and 6", "diameter between 100 mm and 300 mm"
_BETWEEN = re.compile(
    r"\b(?:(?P<field>[a-z][a-z_]*)\s+)?(?:is\s+|of\s+)?between\s+(?P<a>\d+(?:\.\d+)?)\s*(?P<ua>mm|cm|km|m|met\w*)?"
    r"\s+and\s+(?P<b>\d+(?:\.\d+)?)\s*(?P<ub>mm|cm|km|kilomet\w*|m|met\w*)?\b",
    re.I,
)
_YES_NO = {"yes", "no", "y", "n", "true", "false"}


def _metres(num: str, unit: Optional[str]) -> float:
    value = float(num)
    return value * 1000 if unit and unit.lower().startswith(("km", "kilo")) else value


def _numeric_fields(layer: LayerInfo):
    return [
        f for f in layer.fields
        if f.type in ("integer", "number") and not re.search(r"(^|_)(id|no|num|number|fid|gid)$", f.name, re.I)
    ]


def _comparison_field(layer: LayerInfo, hints: List[str]):
    """The numeric column a comparison is about: a hint word sharing its
    first 3 letters with a part of the column name ("diameter" ->
    pipe_dia_i, "height" -> height). None when no or several columns fit."""
    found = []
    for f in _numeric_fields(layer):
        parts = [p for p in re.split(r"[_\W]+", f.name.lower()) if len(p) >= 3]
        if any(h[:3] == p[:3] for h in hints if len(h) >= 3 for p in parts):
            found.append(f)
    return found[0] if len(found) == 1 else None


def _comparisons(text: str, target: LayerInfo, words: List[str]) -> Optional[Tuple[List[AttributeFilter], Set[str]]]:
    filters: List[AttributeFilter] = []
    explained: Set[str] = set()
    for m in _COMPARE.finditer(text):
        cmp = m.group("cmp").lower()
        hints = [_CMP_IMPLIES[cmp]] if cmp in _CMP_IMPLIES else []
        if m.group("field"):
            hints.append(m.group("field").lower())
        field = _comparison_field(target, hints)
        if field is None and not hints:
            # "with diameter more than 300": the measure is named elsewhere.
            field = _comparison_field(target, words)
        if field is None:
            return None
        value = _metres(m.group("num"), m.group("unit"))
        filters.append(AttributeFilter(
            field=field.name, op=_CMP_OP[cmp],
            value=int(value) if field.type == "integer" and value.is_integer() else value,
        ))
        explained |= set(_tokens(m.group(0))) | set(_tokens(field.name.replace("_", " ")))
        explained |= {w for w in words if any(w[:3] == p[:3] for p in re.split(r"[_\W]+", field.name.lower()) if len(p) >= 3)}
    return filters, explained


def _number(field, value: float):
    return int(value) if field.type == "integer" and value.is_integer() else value


def _ordering(text: str, op: GisOperation, target: LayerInfo, words: List[str]) -> Optional[Set[str]]:
    """"the 10 tallest" / "top 5 ... by diameter" -> order_by + limit.
    None when the measure cannot be pinned to exactly one column."""
    m = _SUPERLATIVE.search(text)
    if m:
        sup = m.group("sup").lower()
        hints = [_SUP_IMPLIES[sup]] if sup in _SUP_IMPLIES else []
        field = _comparison_field(target, hints) if hints else _comparison_field(target, words)
        if field is None:
            return None
        op.order_by, op.order_desc, op.limit = field.name, sup in _SUP_DESC, int(m.group("n"))
        return set(_tokens(m.group(0))) | set(_tokens(field.name.replace("_", " "))) | {
            w for w in words if any(w[:3] == p[:3] for p in re.split(r"[_\W]+", field.name.lower()) if len(p) >= 3)
        }
    m = _TOP_BY.search(text)
    if m:
        hint = _tokens(m.group("field"))
        field = _comparison_field(target, hint)
        if field is None:
            return None
        op.order_by, op.order_desc, op.limit = field.name, True, int(m.group("n"))
        return set(_tokens(f"top {m.group('n')} by")) | set(hint)
    return set()


def _between(text: str, target: LayerInfo, words: List[str]) -> Optional[Tuple[List[AttributeFilter], Set[str]]]:
    filters: List[AttributeFilter] = []
    explained: Set[str] = set()
    for m in _BETWEEN.finditer(text):
        hints = [m.group("field").lower()] if m.group("field") else []
        field = _comparison_field(target, hints) if hints else None
        if field is None:
            field = _comparison_field(target, words)
        if field is None:
            return None
        unit = m.group("ub") or m.group("ua")
        a, b = sorted((_metres(m.group("a"), unit), _metres(m.group("b"), unit)))
        filters.append(AttributeFilter(field=field.name, op="between", value=_number(field, a), value2=_number(field, b)))
        explained |= set(_tokens(m.group(0))) | set(_tokens(field.name.replace("_", " ")))
    return filters, explained


def _flag_filters(text: str, op: GisOperation, target: LayerInfo) -> Set[str]:
    """Yes/No columns named in the request: "signals at a chowk" ->
    chowk = 'Yes'; "not at a chowk" / "without drain" -> 'No'."""
    explained: Set[str] = set()
    have = {f.field.lower() for f in op.attribute_filters}
    words = set(_tokens(text))
    for f in target.fields:
        values = [v for v in f.sample_values if v != "…(more)"]
        if f.type != "text" or not values or any(v.strip().lower() not in _YES_NO for v in values):
            continue
        if f.name.lower() in have:
            continue
        parts = [p for p in re.split(r"[_\W]+", f.name.lower()) if len(p) >= 3 and p not in ("yes", "no")]
        named = [p for p in parts if p in words]
        if not named:
            continue
        negated = any(
            re.search(rf"\b(not|no|without|non)\s+(?:at\s+|a\s+|an\s+|the\s+|on\s+|in\s+)*{p}", text, re.I)
            for p in named
        )
        want = ("no", "n", "false") if negated else ("yes", "y", "true")
        value = next((v for v in values if v.strip().lower() in want), None)
        if value is None:
            continue
        op.attribute_filters.append(AttributeFilter(field=f.name, op="=", value=value))
        explained |= set(named) | set(_tokens("not no without non"))
    return explained


def _real_negation(text: str, target: LayerInfo):
    """The negation clause of the request, or None. "not working" names the
    value "Not Working" (its words include the negation AND what follows),
    so it is a value, not a negation; "other than Religious" is a negation
    even though "Other" is also a landmark type."""
    m = _NEGATION.search(text)
    if not m:
        return None
    neg_words = set(_tokens(m.group("neg")))
    rest_words = set(_tokens(m.group("rest")))
    for _, _, values in matching_values(m.group(0), [target]):
        for v in values:
            tokens = set(_tokens(v))
            if neg_words <= tokens and tokens & rest_words:
                return None
    return m


def _negate(m, op: GisOperation, target: LayerInfo) -> Set[str]:
    """"landmarks other than Religious" / "signals except Traffic Control":
    the matched value becomes != / not_in."""
    if m is None:
        return set()
    rest = m.group("rest")
    matches = matching_values(rest, [target])
    if not matches:
        return set()  # e.g. "not at a chowk" — handled by _flag_filters
    explained = set(_tokens(m.group("neg")))
    for _, field, values in matches:
        for f in op.attribute_filters:
            if f.field.lower() == field.lower():
                op.attribute_filters.remove(f)
                break
        op.attribute_filters.append(
            AttributeFilter(field=field, op="!=", value=values[0])
            if len(values) == 1
            else AttributeFilter(field=field, op="not_in", values=list(values))
        )
    return explained


def _value_words(op: GisOperation) -> Set[str]:
    out: Set[str] = set()
    filters = list(op.attribute_filters)
    for sf in [op.spatial_filter, *op.spatial_filters]:
        if sf is not None:
            filters += sf.reference_filters
    for f in filters:
        for v in ([f.value] if f.value is not None else []) + list(f.values or []):
            if isinstance(v, str):
                out |= set(_tokens(v))
    return out


# Step 1 count per area, step 2 filter / rank the areas.
_AREA_CMP = {
    "more than": ">", "over": ">", "above": ">", "at least": ">=", "less than": "<",
    "fewer than": "<", "under": "<", "below": "<", "at most": "<=", "exactly": "=",
}
_AREA_HAVING = re.compile(
    r"^\s*(?:which|show|list|find|get)?\s*(?:me\s+)?(?:the\s+|all\s+)?(?P<area>[a-z_ ]+?)\s+"
    r"(?:with|having|that have|which have|where there are|containing)\s+"
    r"(?P<cmp>more than|over|above|at least|less than|fewer than|under|below|at most|exactly)\s+"
    r"(?P<n>\d+)\s+(?P<target>.+?)\s*$",
    re.I,
)
_AREA_TOP = re.compile(
    r"^\s*(?:show\s+|list\s+)?(?:me\s+)?(?:the\s+)?(?P<dir>top|bottom)\s+(?P<n>\d+)\s+(?P<area>[a-z_ ]+?)\s+"
    r"by\s+(?:the\s+)?(?:number of|count of|no\.? of)?\s*(?P<target>.+?)\s*$",
    re.I,
)
_AREA_MOST = re.compile(
    r"^\s*which\s+(?P<area>[a-z_ ]+?)\s+(?:has|have)\s+(?:the\s+)?"
    r"(?P<sup>most|highest number of|fewest|least|lowest number of)\s+(?P<target>.+?)\s*$",
    re.I,
)


_NEAREST_EACH = re.compile(
    r"^\s*(?:show|find|get|list)?\s*(?:me\s+)?(?:the\s+)?(?:nearest|closest)\s+(?:(?P<n>\d+)\s+)?(?P<target>.+?)\s+"
    r"(?:to|from|for|of)\s+(?:each|every|all the|all)\s+(?P<ref>.+?)\s*$"
    r"|^\s*(?:for\s+)?(?:each|every)\s+(?P<ref2>.+?)[,]?\s+(?:show\s+|find\s+)?(?:the\s+)?(?:nearest|closest)\s+"
    r"(?:(?P<n2>\d+)\s+)?(?P<target2>.+?)\s*$",
    re.I,
)


def _nearest_each(text: str, layers: List[LayerInfo]) -> Optional[PlanResult]:
    """"nearest pumping station to each lake", "for each school, the nearest
    2 signals": both sides are planned by the fast path itself, so each may
    carry its own conditions ("educational landmarks")."""
    m = _NEAREST_EACH.search(text)
    if not m:
        return None
    target_text, ref_text = m.group("target") or m.group("target2"), m.group("ref") or m.group("ref2")
    n = m.group("n") or m.group("n2")
    t = fast_plan(f"show {target_text}", layers)
    r = fast_plan(f"show {ref_text}", layers)
    if t is None or r is None or t.operation.kind != "select" or r.operation.kind != "select":
        return None
    op = t.operation.model_copy(deep=True)
    op.kind, op.per_reference, op.count = "nearest", True, int(n) if n else 1
    op.reference_layer = r.operation.target_layer
    op.reference_filters = list(r.operation.attribute_filters)
    target = next(l for l in layers if l.code == op.target_layer)
    explanation = f"Nearest {op.count} {target.name} to each {op.reference_layer}" + (
        " where " + " and ".join(f"{f.field} {f.op} {f.value}" for f in op.reference_filters) if op.reference_filters else "") + "."
    return PlanResult(answer_kind="gis_operation", explanation=explanation, operation=op, planner="fast")


def _area_step(text: str, layers: List[LayerInfo]) -> Optional[PlanResult]:
    """"wards with more than 100 signals", "top 3 zones by number of
    signals", "which ward has the most Not Working signals": count the
    target per polygon, then keep / rank the polygons. The target part is
    planned by the fast path itself, so it may carry its own conditions."""
    m = _AREA_HAVING.search(text) or _AREA_TOP.search(text) or _AREA_MOST.search(text)
    if not m:
        return None
    areas = [a for a, _, _ in _mentioned_layers(m.group("area"), layers) if (a.geometry_type or "").upper() == "POLYGON"]
    if len(areas) != 1:
        return None
    inner = fast_plan(f"show {m.group('target')}", [l for l in layers if l.code != areas[0].code])
    if inner is None or inner.operation.kind != "select" or inner.operation.limit or inner.operation.order_by:
        return None
    op = inner.operation.model_copy(deep=True)
    op.kind, op.metric, op.group_by_layer = "aggregate", "count", areas[0].code
    groups = m.groupdict()
    if groups.get("cmp"):
        op.having_op, op.having_value = _AREA_CMP[groups["cmp"].lower()], float(groups["n"])
    elif groups.get("dir"):
        op.limit, op.order_desc = int(groups["n"]), groups["dir"].lower() == "top"
    else:
        op.limit, op.order_desc = 1, groups["sup"].lower() in ("most", "highest number of")
    target = next(l for l in layers if l.code == op.target_layer)
    return PlanResult(answer_kind="gis_operation", explanation=_describe(op, target), operation=op, planner="fast")


def fast_plan(
    message: str,
    layers: List[LayerInfo],
    previous: Optional[GisOperation] = None,
) -> Optional[PlanResult]:
    text = message.strip().rstrip("?.! ")
    if not text:
        return None
    stepped = _area_step(text, layers) or _nearest_each(text, layers)
    if stepped is not None:
        return stepped
    follow_up = is_follow_up(text, layers, previous)
    if _FOLLOW_UP.search(text) and not follow_up:
        return None  # "those" with nothing to refer back to
    words = _tokens(text)
    explained: Set[str] = set(_FILLER)
    counting = bool(_COUNTING.search(text))
    area_words: Set[str] = {t for w, _ in _NUMBERED.findall(text) for t in _tokens(w)}

    # --- "within N m of <layer> [<value>]", possibly several, ANDed -------
    body = text
    within_filters: List[SpatialFilter] = []
    ref_codes: Set[str] = set()
    heads = list(_WITHIN_HEAD.finditer(text))
    if heads:
        parts = [text[: heads[0].start()]]
        for i, h in enumerate(heads):
            tail = text[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(text)]
            tail = re.sub(r"[\s,]+(and|or)?\s*$", "", tail)
            refs = [
                m[0] for m in _mentioned_layers(tail, layers)
                if not (area_words & set(_tokens(f"{m[0].name} {m[0].code}")))
            ]
            if len(refs) != 1:
                return None
            ref = refs[0]
            ref_codes.add(ref.code)
            within_filters.append(SpatialFilter(
                relation="within_distance",
                reference_layer=ref.code,
                distance_meters=_metres(h.group("num"), h.group("unit")),
                reference_filters=[value_filter(f, v) for _, f, v in matching_values(tail, [ref])],
            ))
            explained |= set(_tokens(f"within {h.group('num')} {h.group('unit')} of from around"))
            explained |= set(_tokens(f"{ref.name} {ref.code}"))
            parts.append(_strip_ref(tail, ref))
        body = " ".join(parts)

    # --- target ------------------------------------------------------------
    if follow_up:
        target = _find_layer(layers, previous.target_layer)
        if target is None:
            return None
        op = previous.model_copy(deep=True)
        explained |= _FOLLOW_WORDS
        if counting and op.kind == "select":
            op.kind, op.metric = "aggregate", "count"
    else:
        group_code, _ = _grouping(body, layers, None) if counting else (None, None)
        targets = [
            m[0] for m in _mentioned_layers(body, layers)
            if m[0].code != group_code and m[0].code not in ref_codes
            and not (area_words & set(_tokens(f"{m[0].name} {m[0].code}")))
        ]
        if not targets:
            # "temples in ward 3": no layer named, but the value is a real
            # category of exactly one layer -> that layer.
            implied = [
                l for l in implied_layers(body, layers)
                if l.code != group_code and l.code not in ref_codes
                and not (area_words & set(_tokens(f"{l.name} {l.code}")))
            ]
            targets = implied if len(implied) == 1 else []
        if len(targets) != 1:
            return None
        target = targets[0]
        op = GisOperation(kind="aggregate" if counting else "select", target_layer=target.code)
        if counting:
            op.metric = "count"
    explained |= set(_tokens(f"{target.name} {target.code}"))
    if counting:
        explained |= _COUNT_WORDS
        if not (op.group_by or op.group_by_layer):
            op.group_by_layer, op.group_by = _grouping(body, layers, target)
        if op.group_by_layer or op.group_by:
            explained |= _GROUP_WORDS
            group = _find_layer(layers, op.group_by_layer)
            if group is not None:
                explained |= set(_tokens(f"{group.name} {group.code}"))
            if op.group_by:
                explained |= set(_tokens(op.group_by.replace("_", " ")))

    # --- comparisons, area numbers, category values -------------------------
    compared = _comparisons(body, target, words)
    if compared is None:
        return None
    cmp_filters, cmp_words = compared
    have = {(f.field.lower(), f.op) for f in op.attribute_filters}
    op.attribute_filters += [f for f in cmp_filters if (f.field.lower(), f.op) not in have]
    explained |= cmp_words

    ranged = _between(body, target, words)
    if ranged is None:
        return None
    op.attribute_filters += ranged[0]
    explained |= ranged[1]
    ordered = _ordering(body, op, target, words)
    if ordered is None or (ordered and counting):
        return None
    explained |= ordered

    _numbered_filters(body, op, target, layers)
    _drop_redundant_area_filter(body, op, target, layers)
    explained |= _flag_filters(body, op, target)
    negation = _real_negation(body, target)
    # Positive values come from the text before the negation clause only.
    _value_phrase_filters(body[: negation.start()] if negation else body, op, target)
    explained |= _negate(negation, op, target)
    for word, number in _NUMBERED.findall(body):
        if _numbered_field(target, word) or op.spatial_filter is not None:
            explained |= set(_tokens(word)) | _NUMBER_MARKERS | {number}
    _coded_filters(body, op, target)
    for word, code in _CODED.findall(body):
        if any(f.field == getattr(_numbered_field(target, word), "name", None) for f in op.attribute_filters):
            explained |= set(_tokens(word)) | _NUMBER_MARKERS | {code.lower()}

    if within_filters:
        # An area condition already set ("in zone no 13" via the zone
        # polygon) stays first; the distance conditions are ANDed after it.
        if op.spatial_filter is None:
            op.spatial_filter, extra = within_filters[0], within_filters[1:]
        else:
            extra = within_filters
        op.spatial_filters = list(op.spatial_filters) + [sf for sf in extra if sf not in op.spatial_filters]
    value_words = _value_words(op)
    explained |= value_words
    # "cast iron" stands behind the abbreviation 'C.I'.
    string_values = [v for f in op.attribute_filters for v in ([f.value] if isinstance(f.value, str) else []) + list(f.values or [])]
    explained |= abbreviation_words(text, [v for v in string_values if isinstance(v, str)])

    # A misspelt value word ("Aalandi") is accounted for by the value it matched.
    if any(t not in explained and not _has_word(t, value_words) for t in words):
        return None
    return PlanResult(answer_kind="gis_operation", explanation=_describe(op, target), operation=op, planner="fast")


def _strip_ref(tail: str, ref: LayerInfo) -> str:
    """The part of a "within ... of <ref> ..." tail that is NOT about the
    reference layer (its name and value words go with the spatial filter),
    e.g. "the BRTS in zone 13" -> "in zone 13"."""
    ref_words = set(_tokens(f"{ref.name} {ref.code}"))
    for _, _, values in matching_values(tail, [ref]):
        for v in values:
            ref_words |= set(_tokens(v))
    kept = [t for t in re.split(r"(\s+)", tail) if not (set(_tokens(t)) and set(_tokens(t)) <= ref_words)]
    return "".join(kept)


def _describe(op: GisOperation, target: LayerInfo) -> str:
    def cond(f: AttributeFilter) -> str:
        if f.op == "between":
            return f"{f.field} between {f.value} and {f.value2}"
        value = ", ".join(map(str, f.values)) if f.values else f.value
        return f"{f.field} {f.op} {value}"

    conditions = [cond(f) for f in op.attribute_filters]
    for sf in [op.spatial_filter, *op.spatial_filters]:
        if sf is None:
            continue
        where = f" where {' and '.join(cond(f) for f in sf.reference_filters)}" if sf.reference_filters else ""
        if sf.relation == "within_distance":
            conditions.append(f"within {sf.distance_meters:g} m of {sf.reference_layer}{where}")
        else:
            conditions.append(f"inside {sf.reference_layer}{where}")
    if op.kind == "aggregate":
        group = op.group_by_layer or op.group_by
        what = f"Count of {target.name}" + (f" per {group}" if group else "")
        if op.having_op:
            what += f", keeping {group} with a count {op.having_op} {op.having_value:g}"
        elif op.limit:
            what += f", {'top' if op.order_desc is not False else 'lowest'} {op.limit}"
    else:
        what = f"{target.name} features"
    if op.order_by:
        order = f", {'highest' if op.order_desc else 'lowest'} {op.order_by} first" + (f", top {op.limit}" if op.limit else "")
    else:
        order = ""
    return what + (" where " + " and ".join(conditions) if conditions else "") + order + "."
