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
  * "show / list / find <layer> ..." with no usable operation -> select
  * "zone no 13" / "ward 5" -> zone_no = 13 when the target has that
    column, else `within` the Zone / Ward polygon whose column matches
  * a filter the request never states — a text value it never mentions,
    or any number when it contains no number ("in each zone" -> zone_no = 1)
    — is dropped, unless the request refers back ("those"); the same goes
    for the reference filters of a spatial filter
  * half-written filters ("height =" with no value) are dropped
  * a spatial filter that only repeats "zone no 13" (already zone_no = 13
    on the target) is dropped
  * a named category the plan left out ("traffic-actuated signals") is
    added as a filter when it matches one of the layer's real values
  * a text filter whose value is not among the column's values (when all
    of them are known) is dropped — prabhag_no = 'BRTS'
  * a text value that only repeats the name of a layer the plan already
    uses ("within 100 m of the BRTS" + road_name ilike 'BRTS') is dropped
  * kind "nearest" with no nearest/closest in the request, but a distance
    filter, is a plain select ("signals within 100 m of the BRTS")

It only ever names layers / fields from AVAILABLE LAYERS, and the Node
backend still validates every field — a wrong repair becomes a
clarification, never an unsafe query.
"""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher
from typing import List, Optional, Tuple

from .schema import AttributeFilter, GisOperation, LayerInfo, PlanResult, SpatialFilter

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
_SELECT = re.compile(r"\b(show|display|list|find|get|locate|highlight|which|where|all)\b", re.I)
# "now only those in ward 5", "of them", "same" — a request that builds on
# the previous one, so its conditions may legitimately carry over.
_FOLLOW_UP = re.compile(r"\b(those|these|them|they|same|previous|of them|now only|only those|among)\b", re.I)
# Values that stand for "has it / doesn't" rather than a named category.
_FLAG_VALUES = {"yes", "no", "y", "n", "true", "false", "1", "0"}
# "zone no 13", "ward no. 5", "prabhag number 4", "ward 7", "zone #2"
_NUMBERED = re.compile(r"\b([a-z]+)\s*(?:no\.?|number|num|#)?\s*[-:]?\s*(\d+)\b", re.I)
# "prabhag no C", "sector no. B": a letter code needs the "no" marker, so
# ordinary words are never read as codes.
_CODED = re.compile(r"\b([a-z]+)\s*(?:no\.?|number|num|#)\s*[-:]?\s*([a-z])\b", re.I)


def is_follow_up(message: str, layers: List[LayerInfo], previous: Optional[GisOperation]) -> bool:
    """Does this message build on the previous answer? Yes when it refers
    back ("those", "now only"), or names no layer of its own ("which are in
    prabhag no C", "only the working ones", "how many?"). A message naming
    its own layer ("count signals by type", "show landmarks") starts fresh."""
    if previous is None or previous.kind not in ("select", "aggregate"):
        return False
    if _FOLLOW_UP.search(message):
        return True
    area_words = {t for w, _ in _NUMBERED.findall(message) + _CODED.findall(message) for t in _tokens(w)}
    named = [
        m[0] for m in _mentioned_layers(message, layers)
        if not (area_words & set(_tokens(f"{m[0].name} {m[0].code}")))
    ]
    return not named


def carry_over(previous: GisOperation, plan: PlanResult, layers: List[LayerInfo]) -> PlanResult:
    """A follow-up keeps the previous answer's conditions even when the
    model forgot them: same layer -> previous filters on fields the new plan
    does not set, and the previous spatial condition if it has none."""
    op = plan.operation
    if op is None:
        return plan
    same = _find_layer(layers, op.target_layer)
    before = _find_layer(layers, previous.target_layer)
    if same is None or before is None or same.code != before.code:
        return plan
    have = {f.field.lower() for f in op.attribute_filters}
    added = [f for f in previous.attribute_filters if f.field.lower() not in have]
    if not added and (op.spatial_filter is not None or previous.spatial_filter is None):
        return plan
    op = op.model_copy(deep=True)
    op.attribute_filters = added + op.attribute_filters
    if op.spatial_filter is None and previous.spatial_filter is not None:
        op.spatial_filter = previous.spatial_filter.model_copy(deep=True)
    log.info("follow-up kept %d earlier condition(s)", len(added))
    return plan.model_copy(update={"operation": op})


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


def _similar(a: str, b: str) -> bool:
    """Same word, or a close spelling of a longer one ("aalandi" ~ "alandi",
    "motorss" ~ "motor"). Short words must match exactly — "ward"/"word"
    are different things."""
    if a == b:
        return True
    if min(len(a), len(b)) < 5:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.8


def _has_word(word: str, words) -> bool:
    return word in words or any(_similar(word, w) for w in words)


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


def mentioned_layer_codes(text: str, layers: List[LayerInfo]) -> List[str]:
    """Codes of the layers a request names, best match first."""
    return [lyr.code for lyr, _, _ in _mentioned_layers(text, layers)]


def _find_layer(layers: List[LayerInfo], ref: Optional[str]) -> Optional[LayerInfo]:
    """Exact code / name / id first, then the same words ignoring plurals
    and separators — the model writes "ZONES" or "Zone" for code ZONE."""
    if not ref:
        return None
    needle = ref.strip().lower()
    for lyr in layers:
        if needle in (lyr.code.lower(), lyr.name.lower(), lyr.id.lower()):
            return lyr
    want = _tokens(needle)
    if not want:
        return None
    for lyr in layers:
        if want in (_tokens(lyr.code), _tokens(lyr.name)):
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


def _numbered_field(layer: LayerInfo, word: str):
    """The column of `layer` that a "<word> no N" phrase refers to:
    zone -> zone_no / zone_number / zoneno / zone_num / zone."""
    word = word.lower()
    wanted = (f"{word}_no", f"{word}no", f"{word}_number", f"{word}_num", f"{word}_id", word)
    by_name = {f.name.lower(): f for f in layer.fields}
    for name in wanted:
        field = by_name.get(name)
        if field and field.type in ("integer", "number", "text"):
            return field
    return None


def _drop_impossible_values(op: GisOperation, target: LayerInfo) -> List[str]:
    """`prabhag_no = 'BRTS'` can never match when prabhag_no only holds
    A-H. Applies only when the catalog sampled EVERY distinct value (no
    '…(more)' marker), so a rare real value is never dropped."""
    complete = {
        f.name.lower(): {v.lower() for v in f.sample_values}
        for f in target.fields
        if f.type == "text" and f.sample_values and "…(more)" not in f.sample_values
    }
    kept, notes = [], []
    for f in op.attribute_filters:
        known = complete.get(f.field.lower())
        if known and f.op in ("=", "!=") and isinstance(f.value, str) and f.value.lower() not in known:
            notes.append(f"dropped impossible filter {f.field} = {f.value!r}")
            continue
        kept.append(f)
    op.attribute_filters = kept
    return notes


def _drop_layer_name_values(op: GisOperation, layers: List[LayerInfo]) -> List[str]:
    """In "signals within 100 m of the BRTS", BRTS names the reference
    layer; the model also turned it into road_name ilike 'BRTS'."""
    refs = [op.reference_layer, op.to_layer, op.group_by_layer,
            op.spatial_filter.reference_layer if op.spatial_filter else None]
    names: set = set()
    for ref in refs:
        lyr = _find_layer(layers, ref)
        if lyr is not None:
            names |= set(_tokens(f"{lyr.name} {lyr.code}")) - _GENERIC
    if not names:
        return []
    kept, notes = [], []
    for f in op.attribute_filters:
        if isinstance(f.value, str):
            core = set(_tokens(f.value.strip("%"))) - _GENERIC
            if core and core <= names:
                notes.append(f"dropped filter {f.field} {f.op} {f.value!r} (it names a layer)")
                continue
        kept.append(f)
    op.attribute_filters = kept
    return notes


def _drop_redundant_area_filter(text: str, op: GisOperation, target: LayerInfo, layers: List[LayerInfo]) -> List[str]:
    """"signals in zone no 13" needs zone_no = 13 OR within zone 13 — not
    both; the model's spatial half tends to filter on the wrong column."""
    sf = op.spatial_filter
    if sf is None:
        return []
    ref = _find_layer(layers, sf.reference_layer)
    if ref is None:
        return []
    have = {f.field.lower() for f in op.attribute_filters}
    for word, _ in _NUMBERED.findall(text):
        field = _numbered_field(target, word)
        if field and field.name.lower() in have and set(_tokens(word)) & set(_tokens(f"{ref.name} {ref.code}")):
            op.spatial_filter = None
            return [f"dropped spatial filter on {ref.name} (already {field.name} filtered)"]
    return []


def _numbered_value(field, number: str):
    return int(number) if field.type == "integer" else float(number) if field.type == "number" else number


def _numbered_filters(text: str, op: GisOperation, target: LayerInfo, layers: List[LayerInfo]) -> List[str]:
    """Adds the filter a "<area> no N" phrase implies, when the plan lacks it:
    an attribute filter if the target has the column (preferred — cheaper and
    exactly what the data says), else `within` the polygon layer named by
    the phrase, filtered on its own column."""
    notes: List[str] = []
    have = {f.field.lower() for f in op.attribute_filters}
    for m in _NUMBERED.finditer(text):
        word, number = m.group(1), m.group(2)
        field = _numbered_field(target, word)
        if field:
            if field.name.lower() not in have:
                op.attribute_filters.append(
                    AttributeFilter(field=field.name, op="=", value=_numbered_value(field, number))
                )
                have.add(field.name.lower())
                notes.append(f"filter {field.name} = {number}")
            continue
        if op.spatial_filter is not None:
            continue
        for area in layers:  # (numbered area via another polygon layer)
            if area.code == target.code or (area.geometry_type or "").upper() != "POLYGON":
                continue
            if not set(_tokens(word)) & set(_tokens(f"{area.name} {area.code}")):
                continue
            area_field = _numbered_field(area, word)
            if area_field:
                op.spatial_filter = SpatialFilter(
                    relation="within",
                    reference_layer=area.code,
                    reference_filters=[
                        AttributeFilter(field=area_field.name, op="=", value=_numbered_value(area_field, number))
                    ],
                )
                notes.append(f"within {area.name} where {area_field.name} = {number}")
                break
    return notes


_FREE_TEXT_FIELD = re.compile(r"remark|note|comment|desc|detail|observation", re.I)

_NEEDS_VALUE = {"=", "!=", ">", ">=", "<", "<=", "like", "ilike"}


def _complete(f: AttributeFilter) -> bool:
    if f.op in _NEEDS_VALUE:
        return f.value is not None and str(f.value).strip() != ""
    if f.op == "between":
        return f.value is not None and f.value2 is not None
    if f.op in ("in", "not_in"):
        return bool(f.values)
    return True  # is_null / is_not_null


def _drop_incomplete_filters(op: GisOperation) -> List[str]:
    """The model sometimes emits a filter with no value ("height =" for
    "average height of all signals"), which can never run."""
    notes: List[str] = []
    for attr in ("attribute_filters", "reference_filters", "to_filters"):
        filters = getattr(op, attr)
        kept = [f for f in filters if _complete(f)]
        notes.extend(f"dropped incomplete filter {f.field} {f.op}" for f in filters if not _complete(f))
        setattr(op, attr, kept)
    if op.spatial_filter is not None:
        sf = op.spatial_filter
        kept = [f for f in sf.reference_filters if _complete(f)]
        notes.extend(f"dropped incomplete filter {f.field} {f.op}" for f in sf.reference_filters if not _complete(f))
        sf.reference_filters = kept
    return notes


# Street-type words people often leave out: "Dehu Alandi" means "Dehu - Alandi Road".
_VALUE_SUFFIX = {"road", "rd", "marg", "path", "street", "st", "lane", "highway"}


def _value_core(value: str) -> List[str]:
    """A category value's distinctive words, ignoring a bracketed note and
    street-type words: 'Traffic actuated (automatic)' -> ['traffic',
    'actuated'], 'Dehu - Alandi Road' -> ['dehu', 'alandi']."""
    words = [t for t in _tokens(re.sub(r"\(.*?\)", " ", value)) if t not in _GENERIC]
    core = [t for t in words if t not in _VALUE_SUFFIX]
    return core or words


def matching_values(text: str, layers: List[LayerInfo]) -> List[Tuple[LayerInfo, str, List[str]]]:
    """(layer, field, values) for every sampled text value whose words all
    appear in the request (exactly or as a close spelling). A value whose
    words are all inside a longer match is dropped ('not working' picks
    'Not Working', not also 'Working'); others are all kept — several
    values ('Pedestrian or Fixed time') and spelling variants ('Akurdi
    Railway Station Road' / '... road'). Single short words, numbers and
    yes/no flags are too weak a signal and never match on their own."""
    words = set(_tokens(text))
    out: List[Tuple[LayerInfo, str, List[str]]] = []
    for lyr in layers:
        layer_words = set(_tokens(f"{lyr.name} {lyr.code}"))
        for field in lyr.fields:
            if field.type != "text":
                continue
            found: List[Tuple[str, set]] = []
            for value in field.sample_values:
                if value == "…(more)" or value.strip().lower() in _FLAG_VALUES:
                    continue
                core = _value_core(value)
                if not core or set(core) <= layer_words or not all(_has_word(c, words) for c in core):
                    continue
                if len(core) == 1 and (len(core[0]) < 4 or core[0].isdigit()):
                    continue
                if value not in (v for v, _ in found):
                    found.append((value, set(core)))
            # Keep every value not contained in a longer match: "Pedestrian
            # or Fixed time" keeps both, "not working" drops "Working" for
            # "Not Working"; spelling variants (same words) are all kept.
            best = [v for v, c in found if not any(_inside(c, other) for _, other in found)]
            if best:
                out.append((lyr, field.name, best))
    return out


def _inside(words: set, other: set) -> bool:
    """`words` is a weaker match than `other`: fewer words, each the same
    as or a close spelling of one of `other`'s — 'Aalandi Road' (aalandi)
    is inside 'Dehu - Alandi Road' (dehu, alandi)."""
    return len(words) < len(other) and all(any(_similar(w, o) for o in other) for w in words)


def value_filter(field: str, values: List[str]) -> AttributeFilter:
    return (
        AttributeFilter(field=field, op="=", value=values[0])
        if len(values) == 1
        else AttributeFilter(field=field, op="in", values=list(values))
    )


def _value_phrase_filters(text: str, op: GisOperation, target: LayerInfo) -> List[str]:
    """Adds `field = value` when the request names one of the target's real
    category values and the plan has no filter on that field — e.g.
    "traffic-actuated signals" -> type = 'Traffic actuated (automatic)'.
    Matches on the value's words outside brackets; the longest match per
    field wins ("not working" picks "Not Working" over "Working")."""
    have = {f.field.lower() for f in op.attribute_filters}
    notes: List[str] = []
    # Most category-like column first (fewest sampled values; a truncated
    # sample list counts as many). The same words matching a second column
    # — "commercial" is both type and subtype — must not add a second,
    # narrowing condition (type = 'Commercial' AND subtype = 'Commercial'
    # matched nothing).
    size = {f.name: (len(f.sample_values) + (1000 if "…(more)" in f.sample_values else 0)) for f in target.fields}
    # Free-text columns (remarks, notes...) rank after real category columns:
    # "Not Working" is a signal type AND appears in gis_remark.
    rank = lambda m: (bool(_FREE_TEXT_FIELD.search(m[1])), size.get(m[1], 0))
    used_words: set = set()
    for _, field, values in sorted(matching_values(text, [target]), key=rank):
        if field.lower() in have:
            continue
        if (op.group_by or "").lower() == field.lower():
            continue  # "count signals by type" groups on it, never filters
        words = {w for v in values for w in _value_core(v)}
        if words and words <= used_words:
            continue
        used_words |= words
        op.attribute_filters.append(value_filter(field, values))
        have.add(field.lower())
        notes.append(f"filter {field} = {values!r} from the request's words")
    return notes


def _coded_filters(text: str, op: GisOperation, target: LayerInfo) -> List[str]:
    """"prabhag no C" -> prabhag_no = 'C' when the column holds that code."""
    notes: List[str] = []
    have = {f.field.lower() for f in op.attribute_filters}
    for word, code in _CODED.findall(text):
        field = _numbered_field(target, word)
        if field is None or field.type != "text" or field.name.lower() in have:
            continue
        stored = next((v for v in field.sample_values if v.strip().lower() == code.lower()), None)
        if stored is None:
            continue
        op.attribute_filters.append(AttributeFilter(field=field.name, op="=", value=stored))
        have.add(field.name.lower())
        notes.append(f"filter {field.name} = {stored}")
    return notes


def _drop_unasked_filters(text: str, op: GisOperation, follow_up: bool = False) -> List[str]:
    """The small model copies a condition from an earlier chat turn into an
    unrelated request ("Count signals by type" after "...Not Working" ran as
    type = 'Not Working'). Drop a text filter whose value the request never
    mentions — when its field is not mentioned either, or it is the very
    field being grouped by. Follow-ups ("those", "now only") keep them."""
    if follow_up or _FOLLOW_UP.search(text):
        return []
    notes: List[str] = []
    op.attribute_filters = _unasked(text, op, op.attribute_filters, notes)
    sf = op.spatial_filter
    if sf is not None and sf.reference_filters:
        sf.reference_filters = _unasked(text, op, sf.reference_filters, notes)
        if not sf.reference_filters and sf.relation in ("within", "intersects", "contains"):
            # Its only condition was made up; "inside any zone" adds nothing.
            op.spatial_filter = None
            notes.append(f"dropped spatial filter on {sf.reference_layer}")
    return notes


def _unasked(text: str, op: GisOperation, filters: List[AttributeFilter], notes: List[str]) -> List[AttributeFilter]:
    words = set(_tokens(text))
    has_number = bool(re.search(r"\d", text))
    kept = []
    for f in filters:
        values = f.values if f.op in ("in", "not_in") and f.values else [f.value]
        numbers = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if numbers and not has_number:
            # Unit conversions (2000 sq ft -> 185.8) still need a number in
            # the request, so no digits at all means the model made it up.
            notes.append(f"dropped unasked filter {f.field} {f.op} {numbers[0]}")
            continue
        texts = [str(v).strip("%").strip() for v in values if isinstance(v, str)]
        if not texts or any(t.lower() in _FLAG_VALUES for t in texts):
            kept.append(f)
            continue
        value_said = all(
            set(_tokens(t)) - _GENERIC <= words for t in texts if set(_tokens(t)) - _GENERIC
        )
        field_said = bool(set(_tokens(f.field.replace("_", " "))) - _GENERIC <= words)
        grouped_on = op.kind == "aggregate" and (op.group_by or "").lower() == f.field.lower()
        if value_said or (field_said and not grouped_on):
            kept.append(f)
        else:
            notes.append(f"dropped unasked filter {f.field} {f.op} {texts[0]!r}")
    return kept


_IDENTIFIER = re.compile(r"(^|_)(id|gisid|objectid|fid|gid|code|no|num|number)$", re.I)


def _is_identifier(field: str) -> bool:
    """valve_id, gisid, ... — one value per feature, never a useful grouping."""
    return bool(_IDENTIFIER.search(field))


def repair_plan(message: str, plan: PlanResult, layers: List[LayerInfo], follow_up: bool = False) -> PlanResult:
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

    # No operation at all, but the request clearly asks for an aggregate /
    # buffer / plain listing of a layer the question names: build it.
    if op is None:
        kind = wants if wants in ("aggregate", "buffer") else "select" if _SELECT.search(text) and not wants else None
        if kind is None or not mentioned:
            return plan
        group_layer, _ = _grouping(text, layers, None)
        # "signals in zone 13": the numbered area is the filter, not the target.
        areas = {t for w, _ in _NUMBERED.findall(text) for t in _tokens(w)}
        candidates = [
            f for f in mentioned
            if f[0].code != group_layer and not (areas & set(_tokens(f"{f[0].name} {f[0].code}")))
        ] or [f for f in mentioned if f[0].code != group_layer]
        if not candidates:
            return plan
        target = candidates[0][0]
        op = GisOperation(kind=kind, target_layer=target.code)
        notes.append(f"built a {kind} operation on {target.name} from the question")

    if target is None and mentioned:
        target = mentioned[0][0]
        op.target_layer = target.code
        notes.append(f"target layer -> {target.name}")

    if op.kind == "nearest" and not nearest and op.spatial_filter is not None:
        notes.append("kind nearest -> select (no nearest/closest in the request)")
        op.kind = "select"

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

    notes.extend(_drop_incomplete_filters(op))
    notes.extend(_drop_unasked_filters(text, op, follow_up))

    if target is not None and op.kind in ("select", "aggregate"):
        notes.extend(_numbered_filters(text, op, target, layers))
        notes.extend(_coded_filters(text, op, target))
        notes.extend(_drop_redundant_area_filter(text, op, target, layers))
        notes.extend(_drop_impossible_values(op, target))
        notes.extend(_drop_layer_name_values(op, layers))
        notes.extend(_value_phrase_filters(text, op, target))

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
