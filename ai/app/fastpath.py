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
    _FOLLOW_UP,
    _NUMBERED,
    _drop_redundant_area_filter,
    _find_layer,
    _grouping,
    _has_word,
    _mentioned_layers,
    _numbered_field,
    _numbered_filters,
    _tokens,
    _value_phrase_filters,
    matching_values,
    value_filter,
)
from .schema import AttributeFilter, GisOperation, LayerInfo, PlanResult, SpatialFilter

# Words that carry no condition of their own.
_FILLER = set(_tokens(
    "show display list find get locate highlight view see give me please all the a an "
    "of in on at with that which who are is there where what feature features layer "
    "layers map data record records every entire whole any have has or and"
))
_COUNT_WORDS = set(_tokens("how many count number total no"))
_GROUP_WORDS = set(_tokens("each every per by"))
_NUMBER_MARKERS = set(_tokens("no number num"))
_FOLLOW_WORDS = set(_tokens("now only those these them they ones one same previous of among just also"))

_COUNTING = re.compile(r"^\s*(how many|count|number of)\b", re.I)

# "within 300 m of Pawna River", "within 1.5 km from the BRTS"
_WITHIN = re.compile(
    r"\bwithin\s+(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>km|kilomet\w*|m|met\w*)\s+(?:of|from|around)\s+(?P<tail>.+)$",
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
    filters = list(op.attribute_filters) + (op.spatial_filter.reference_filters if op.spatial_filter else [])
    for f in filters:
        for v in ([f.value] if f.value is not None else []) + list(f.values or []):
            if isinstance(v, str):
                out |= set(_tokens(v))
    return out


def fast_plan(
    message: str,
    layers: List[LayerInfo],
    previous: Optional[GisOperation] = None,
) -> Optional[PlanResult]:
    text = message.strip().rstrip("?.! ")
    if not text:
        return None
    follow_up = bool(_FOLLOW_UP.search(text))
    if follow_up and (previous is None or previous.kind not in ("select", "aggregate")):
        return None
    words = _tokens(text)
    explained: Set[str] = set(_FILLER)
    counting = bool(_COUNTING.search(text))
    area_words: Set[str] = {t for w, _ in _NUMBERED.findall(text) for t in _tokens(w)}

    # --- "within N m of <layer> [<value>]" ---------------------------------
    body = text
    within_filter: Optional[SpatialFilter] = None
    ref_code: Optional[str] = None
    w = _WITHIN.search(text)
    if w:
        tail = w.group("tail")
        refs = [
            m[0] for m in _mentioned_layers(tail, layers)
            if not (area_words & set(_tokens(f"{m[0].name} {m[0].code}")))
        ]
        if len(refs) != 1:
            return None
        ref = refs[0]
        ref_code = ref.code
        within_filter = SpatialFilter(
            relation="within_distance",
            reference_layer=ref.code,
            distance_meters=_metres(w.group("num"), w.group("unit")),
            reference_filters=[value_filter(f, v) for _, f, v in matching_values(tail, [ref])],
        )
        explained |= set(_tokens(f"within {w.group('num')} {w.group('unit')} of from around"))
        explained |= set(_tokens(f"{ref.name} {ref.code}"))
        body = text[: w.start()] + " " + _strip_ref(tail, ref)

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
            if m[0].code not in (group_code, ref_code)
            and not (area_words & set(_tokens(f"{m[0].name} {m[0].code}")))
        ]
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

    if within_filter is not None:
        if op.spatial_filter is not None and op.spatial_filter != within_filter:
            return None  # two spatial conditions: let the model decide
        op.spatial_filter = within_filter
    value_words = _value_words(op)
    explained |= value_words

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
    sf = op.spatial_filter
    if sf is not None:
        where = f" where {' and '.join(cond(f) for f in sf.reference_filters)}" if sf.reference_filters else ""
        if sf.relation == "within_distance":
            conditions.append(f"within {sf.distance_meters:g} m of {sf.reference_layer}{where}")
        else:
            conditions.append(f"inside {sf.reference_layer}{where}")
    if op.kind == "aggregate":
        group = op.group_by_layer or op.group_by
        what = f"Count of {target.name}" + (f" per {group}" if group else "")
    else:
        what = f"{target.name} features"
    if op.order_by:
        order = f", {'highest' if op.order_desc else 'lowest'} {op.order_by} first" + (f", top {op.limit}" if op.limit else "")
    else:
        order = ""
    return what + (" where " + " and ".join(conditions) if conditions else "") + order + "."
