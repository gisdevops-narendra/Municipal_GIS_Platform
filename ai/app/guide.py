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
from .schema import AttributeFilter, ChatTurn, ClarifyOption, GisOperation, Instruction, LayerInfo, PlanResult

# "near / close to / next to / around / adjacent to <X>" with no distance.
_NEAR = re.compile(r"\b(near(?:by)?|close to|next to|adjacent to|around|surrounding)\b", re.I)
_WITHIN_DISTANCE = re.compile(
    r"\bwithin\s+\d+(?:\.\d+)?\s*(?:km|kilomet\w*|m|met\w*)\s+(?:of|from|around)\b", re.I
)
_NEAR_CHOICES = (50, 100, 250, 500)


_CHOSEN_DISTANCE = re.compile(r"\bwithin\s+(\d+(?:\.\d+)?)\s*m\s+of\b", re.I)


def remember_near(message: str, history: List[ChatTurn], rule_m: Optional[float] = None):
    """Follow the user's earlier choice: once they picked how close "near"
    is (or asked "within N m of" themselves) in this chat, a later "near"
    uses that distance instead of asking again — stated in a note, with
    chips to pick another. Returns (message to plan, note, options)."""
    near = _NEAR.search(message)
    if not near or _DISTANCE.search(message) or _NEAREST.search(message):
        return message, None, []
    if rule_m:
        d = f"{rule_m:g}"
        rewritten = (message[: near.start()] + f"within {d} m of" + message[near.end():]).strip()
        return rewritten, f"Used {d} m for “near”, as you asked.", []
    for turn in reversed(history):
        if turn.role != "user":
            continue
        chosen = _CHOSEN_DISTANCE.search(turn.content)
        if chosen:
            d = chosen.group(1)
            rewrite = lambda n: (message[: near.start()] + f"within {n} m of" + message[near.end():]).strip()
            note = f"Used {d} m for “near”, as earlier in this chat."
            options = [ClarifyOption(label=f"Use {n} m", message=rewrite(n)) for n in _NEAR_CHOICES if str(n) != d]
            return rewrite(d), note, options
    return message, None, []


def preflight(message: str) -> Optional[PlanResult]:
    text = message.strip()
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


def annotate(
    message: str, plan: PlanResult, layers: List[LayerInfo], previous: Optional[GisOperation] = None
) -> PlanResult:
    """Fuzzy-matched values are stated, with close alternatives to pick —
    only for conditions this message introduced (not ones carried over
    from the previous answer)."""
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
    carried = {(c.field, c.op, str(c.value), tuple(c.values or [])) for c in (previous.attribute_filters if previous else [])}
    for index, f in enumerate(op.attribute_filters):
        if (f.field, f.op, str(f.value), tuple(f.values or [])) in carried:
            continue
        values = [v for v in ([f.value] if f.value is not None else []) + list(f.values or []) if isinstance(v, str)]
        if not values or any(v.lower() in lower for v in values):
            continue  # the user typed it as stored
        if all(v.strip().lower() in {"yes", "no", "y", "n", "true", "false"} for v in values):
            continue  # "at a chowk" -> chowk = Yes needs no explaining
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


# ---------------------------------------------------------------------------
# Conversation that is not a map query: greetings, help, questions about the
# data itself, GIS terms. Deterministic — answered from the real catalog.

_GREETING = re.compile(r"^\s*(hi|hii+|hello|hey|namaste|namaskar|good (morning|afternoon|evening))\b[\s!.]*$", re.I)
_THANKS = re.compile(r"^\s*(ok(ay)?[, ]*)?(thanks|thank you|thx|great|awesome|nice|perfect|good job)\b.{0,20}$", re.I)
_HELP = re.compile(r"\b(what can you do|what do you do|help me|how (do|can) i use|what (questions|can i ask)|who are you)\b", re.I)
_LIST_LAYERS = re.compile(r"\b(what|which|list|show)\b.*\blayers?\b.*\b(do i have|are there|available|exist|have)\b|^\s*(list|show)\s+(all\s+)?layers\s*$", re.I)
_FIELDS_OF = re.compile(r"\b(what|which|list|show)\b.*\b(fields|columns|attributes)\b.*\b(of|in|does|for)\s+(?:the\s+)?(?P<layer>[a-z_ ]+?)(?:\s+(?:have|layer|contain))?\s*\??$|^\s*describe\s+(?:the\s+)?(?P<layer2>[a-z_ ]+?)(?:\s+layer)?\s*\??$", re.I)
_VALUES_OF = re.compile(r"\b(what|which)\s+(values|types|kinds|categories)\b.*?\b(?P<field>[a-z_]+)\b(?:\s+(?:have|has|contain))?(?:\s+in\s+(?:the\s+)?(?P<layer>[a-z_ ]+?))?\s*\??$", re.I)
_MEANS = re.compile(r"\bwhat\s+(does|is)\s+(the\s+)?(field\s+)?[\"“']?(?P<field>[a-z][a-z0-9_]*)[\"”']?\s+(mean|contain|stand for|field)\b", re.I)

GLOSSARY = {
    "buffer": "A buffer is the area within a set distance of features — e.g. a 200 m buffer around lakes. Try: “Make a 200 m buffer around the lakes”.",
    "crs": "A CRS (coordinate reference system) defines how coordinates map to places on Earth. Your layers are stored in a metric CRS, so distances are in metres.",
    "layer": "A layer is one set of map features of the same kind (signals, wards, pipelines) with the same attribute fields.",
    "attribute": "Attributes are the columns of a layer (type, ward_no, height…). You can filter by them: “signals where type is Not Working”.",
    "polygon": "Polygons are area features (wards, zones, lakes); points are single locations (signals); lines are networks (pipelines, roads).",
    "spatial join": "A spatial join combines layers by location — e.g. counting signals inside each ward: “How many signals are there in each ward?”.",
    "gis": "GIS (Geographic Information System) stores and analyses data by location. Here you can ask about your municipality's layers in plain language and see results on the map.",
}
_GLOSSARY = re.compile(r"^\s*what\s+(is|are|does)\s+(an?\s+)?(?P<term>buffer|crs|coordinate reference system|layer|attribute|polygon|spatial join|gis)\b", re.I)


def _layer_named(text: str, layers: List[LayerInfo]) -> Optional[LayerInfo]:
    from .repair import _mentioned_layers
    found = _mentioned_layers(text or "", layers)
    return found[0][0] if found else None


def _field_line(f) -> str:
    values = [v for v in f.sample_values if v != "…(more)"][:5]
    return f"{f.name} ({f.type})" + (f" — e.g. {', '.join(values)}" if values else "")


def converse(message: str, layers: List[LayerInfo]) -> Optional[PlanResult]:
    """Greetings, help, questions about the data (layers, fields, values,
    what a field means) and GIS terms — answered from the real catalog, no
    model. None when the message is a map question."""
    text = message.strip()
    ask = lambda qs: [ClarifyOption(label=q, message=q) for q in qs]  # noqa: E731
    sugg = suggestions(layers, limit=4)

    if _GREETING.search(text):
        return PlanResult(answer_kind="answer", explanation=(
            "Hello! Ask me about your GIS data in plain language — find, count, compare areas, "
            "measure distances. Here are a few questions that work on your layers:"), options=ask(sugg))
    if _THANKS.search(text):
        return PlanResult(answer_kind="answer", explanation="You're welcome! Ask another question any time.", options=ask(sugg[:2]))
    if _HELP.search(text):
        return PlanResult(answer_kind="answer", explanation=(
            "I answer questions about your municipality's GIS layers and show the results on the map and in the "
            "Attribute Table. I can: find features by their values (“signals that are Not Working”), count and "
            "group them (“signals by type”, “in each ward”), filter and rank areas (“wards with more than 100 "
            "signals”), measure distance to other layers (“within 100 m of the BRTS”), find the nearest features, "
            "make buffers, and follow up on a previous answer (“only those in ward 5”). I can also tell you which "
            "layers, fields and values you have."), options=ask(sugg))

    term = _GLOSSARY.search(text)
    if term:
        key = term.group("term").lower()
        key = "crs" if key == "coordinate reference system" else key
        return PlanResult(answer_kind="answer", explanation=GLOSSARY[key])

    if _LIST_LAYERS.search(text):
        lines = []
        for l in layers:
            useful = [f.name for f in l.fields if f.type != "id"][:6]
            lines.append(f"• {l.name} ({(l.geometry_type or 'raster').lower()}) — fields: {', '.join(useful)}")
        return PlanResult(answer_kind="answer", explanation=f"You have {len(layers)} layers:\n" + "\n".join(lines),
                          options=ask([f"What fields does {l.name} have?" for l in layers[:3]]))

    fields_q = _FIELDS_OF.search(text)
    if fields_q:
        layer = _layer_named(fields_q.group("layer") or fields_q.group("layer2"), layers)
        if layer:
            lines = [f"• {_field_line(f)}" for f in layer.fields if f.type != "id"]
            return PlanResult(answer_kind="answer", explanation=f"{layer.name} ({(layer.geometry_type or '').lower()}) has these fields:\n" + "\n".join(lines),
                              options=ask([q for q in sugg if layer.name.replace('_', ' ') in q][:3]))

    for pattern in (_VALUES_OF, _MEANS):
        q = pattern.search(text)
        if not q:
            continue
        word = q.group("field").lower()
        scope = [_layer_named(q.groupdict().get("layer") or text, layers)] if pattern is _VALUES_OF else []
        candidates = [l for l in (scope if scope and scope[0] else layers)]
        for layer in candidates:
            field = next((f for f in layer.fields if f.name.lower() == word or f.name.lower().startswith(word[:5])), None)
            if field:
                values = [v for v in field.sample_values if v != "…(more)"]
                more = " (and more)" if "…(more)" in field.sample_values else ""
                body = (f"{layer.name}.{field.name} is a {field.type} field"
                        + (f" with values such as: {', '.join(values[:15])}{more}." if values else "."))
                return PlanResult(answer_kind="answer", explanation=body,
                                  options=ask([f"Count {layer.name.replace('_', ' ')} by {field.name}"]) if field.type == "text" else [])
    return None


# Not a map question at all ("how can GIS help my city?") -> short chat.
_DATA_WORDS = re.compile(
    r"\b(show|find|list|count|how many|where|which|nearest|closest|within|buffer|route|near|total|average|"
    r"sum|map|highlight|filter|select|display|get|top|most|fewest|more than|less than|between)\b", re.I)


def is_small_talk(message: str, layers: List[LayerInfo]) -> bool:
    from .repair import _mentioned_layers, implied_layers
    return not _DATA_WORDS.search(message) and not _mentioned_layers(message, layers) and not implied_layers(message, layers)


# ---------------------------------------------------------------------------
# Field confidence: is the value really in the column the plan uses?

def field_confidence(
    message: str, plan: PlanResult, layers: List[LayerInfo], previous: Optional[GisOperation] = None
) -> PlanResult:
    """Checks every text condition against where its value is stored.

    * value not in the chosen column but in exactly one other category
      column -> switch to that column (stated in a note);
    * value stored in several category columns and the user did not name
      one ("commercial": type AND subtype) -> ask which, with chips;
    Name / locality / road / remark columns never compete, and conditions
    carried over from the previous answer are not re-asked.
    """
    from .repair import _NAME_LIKE_FIELD, _tokens as tok

    op = plan.operation
    if op is None or plan.answer_kind != "gis_operation":
        return plan
    target = next((l for l in layers if l.code == op.target_layer), None)
    if target is None:
        return plan
    carried = {(c.field, str(c.value), tuple(c.values or [])) for c in (previous.attribute_filters if previous else [])}
    words = set(tok(message))
    category = [
        f for f in target.fields
        if f.type == "text" and not _FREE_TEXT_FIELD.search(f.name) and not _NAME_LIKE_FIELD.search(f.name)
    ]
    stored = {f.name: {v.lower() for v in f.sample_values if v != "…(more)"} for f in category}
    notes = list(plan.notes)
    for index, f in enumerate(list(op.attribute_filters)):
        if (f.field, str(f.value), tuple(f.values or [])) in carried or f.op not in ("=", "in", "ilike", "like"):
            continue
        values = [v for v in ([f.value] if f.value is not None else []) + list(f.values or []) if isinstance(v, str)]
        values = [v.strip("%").lower() for v in values if v.strip("%")]
        if not values or any(v in {"yes", "no", "y", "n", "true", "false"} for v in values):
            continue  # Yes/No belongs to the column the user named ("at a chowk")
        holders = [name for name, vals in stored.items() if all(v in vals for v in values)]
        named = [h for h in holders if set(tok(h.replace("_", " "))) & words]
        if f.field in holders and (len(holders) == 1 or named == [f.field]):
            continue  # stored where the plan looks, and nothing competes
        if f.field not in holders and len(holders) == 1:
            new = holders[0]
            op = op.model_copy(deep=True)
            op.attribute_filters[index] = f.model_copy(update={"field": new, "op": "in" if f.values else "="})
            notes.append(f"Used the field {new} — that is where “{', '.join(f.values or [f.value])}” is stored.")
            plan = plan.model_copy(update={"operation": op, "notes": notes})
            continue
        if len(holders) >= 2 and not named:
            shown = ", ".join(f.values or [str(f.value)])
            options = []
            for h in holders[:5]:
                changed = op.model_copy(deep=True)
                changed.attribute_filters[index] = f.model_copy(update={"field": h, "op": "in" if f.values else "="})
                options.append(ClarifyOption(label=f"{h} = {shown}", operation=changed))
            return PlanResult(
                answer_kind="clarification",
                explanation=plan.explanation,
                clarification=f"“{shown}” appears in more than one field of {target.name}. Which field do you mean?",
                options=options,
                planner=plan.planner,
            )
    return plan


# ---------------------------------------------------------------------------
# Standing instructions: "from now on only show working signals".

_INSTRUCTION = re.compile(
    r"^\s*(?:from now on|going forward|for all (?:the )?next questions|by default|always)[,:]?\s+(?P<rest>.+?)\s*[.!]?\s*$"
    r"|^\s*(?P<rest2>.+?)\s+(?:from now on|going forward|by default)\s*[.!]?\s*$",
    re.I,
)
_CLEAR = re.compile(r"\b(forget|clear|remove|stop applying|reset|delete)\b.*\b(instructions?|rules?|filters?|settings?)\b", re.I)
_NEAR_RULE = re.compile(r"\b(?:use|treat|take|consider)?\s*(?P<d>\d+(?:\.\d+)?)\s*m(?:etres?|eters?)?\s+(?:for|as)\s+(?:“|\")?near|near\s+(?:means|is|=)\s+(?P<d2>\d+(?:\.\d+)?)\s*m", re.I)
_RULE_LEAD = re.compile(r"^\s*(?:only\s+show|show\s+only|only|just|show|use|consider|include\s+only)\s+", re.I)


def parse_instruction(message: str, layers: List[LayerInfo]) -> Optional[PlanResult]:
    """Turns "from now on ..." / "always ..." / "forget my instructions"
    into a saved rule (or clears them). The rule part is planned by the
    fast path, so it is a real layer + real values — or it is refused."""
    text = message.strip()
    if _CLEAR.search(text):
        return PlanResult(
            answer_kind="answer", instruction_action="clear",
            explanation="Done — I've removed your standing instructions for this chat.",
        )
    m = _INSTRUCTION.search(text)
    near = _NEAR_RULE.search(text)
    if not m and not near:
        return None
    if near:
        d = float(near.group("d") or near.group("d2"))
        rule = Instruction(text=f"“near” means {d:g} m", near_m=d)
        return PlanResult(answer_kind="answer", instruction_action="add", instruction=rule,
                          explanation=f"Got it — from now on “near” means {d:g} m in this chat.")
    rest = _RULE_LEAD.sub("", (m.group("rest") or m.group("rest2")))
    plan = fast_plan(f"show {rest}", layers)
    if plan is None or plan.operation.kind != "select" or not (plan.operation.attribute_filters or plan.operation.spatial_filter):
        return PlanResult(
            answer_kind="clarification",
            explanation="Rule not understood.",
            clarification=(
                "I couldn't turn that into a rule. Use a layer and a condition, e.g. "
                "“From now on only show signals that are Working” or “Always use 200 m for near”."
            ),
        )
    op = plan.operation
    target = next(l for l in layers if l.code == op.target_layer)
    conditions = " and ".join(f"{f.field} {f.op} {', '.join(map(str, f.values)) if f.values else f.value}" for f in op.attribute_filters)
    rule = Instruction(text=f"{target.name}: {conditions}" if conditions else f"{target.name}: {rest}",
                       layer=op.target_layer, filters=op.attribute_filters)
    return PlanResult(
        answer_kind="answer", instruction_action="add", instruction=rule,
        explanation=f"Got it — from now on, questions about {target.name} will only include {conditions or rest}. "
                    "Say “forget my instructions” to remove it.",
    )


def apply_instructions(plan: PlanResult, instructions: List["Instruction"]) -> PlanResult:
    """Adds standing-instruction conditions to a plan on the same layer
    (unless the question already sets that field), with a note."""
    op = plan.operation
    if op is None or plan.answer_kind != "gis_operation" or not instructions:
        return plan
    have = {f.field.lower() for f in op.attribute_filters}
    added, notes = [], list(plan.notes)
    for rule in instructions:
        if rule.layer != op.target_layer:
            continue
        new = [f for f in rule.filters if f.field.lower() not in have]
        if new:
            added += new
            have |= {f.field.lower() for f in new}
            notes.append(f"Applying your instruction: {rule.text}.")
    if not added:
        return plan
    op = op.model_copy(deep=True)
    op.attribute_filters = op.attribute_filters + added
    return plan.model_copy(update={"operation": op, "notes": notes})
