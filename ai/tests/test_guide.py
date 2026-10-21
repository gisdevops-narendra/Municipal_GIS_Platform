"""Clarification / did-you-mean / suggestion checks (no LLM).

    docker exec -w /app municipal-gis-ai python -m tests.test_guide
"""
from app.fastpath import fast_plan
from app.guide import annotate, preflight, suggestions
from app.schema import LayerField, LayerInfo

LAYERS = [
    LayerInfo(id="s", code="SIGNAL", name="signal", geometry_type="POINT", fields=[
        LayerField(name="type", type="text", sample_values=["Not Working", "Pedestrian", "Traffic Control"]),
        LayerField(name="road_name", type="text", sample_values=["Aalandi Road", "Dehu - Alandi Road", "…(more)"]),
        LayerField(name="zone_no", type="integer")]),
    LayerInfo(id="l", code="LANDMARKS", name="landmarks", geometry_type="POINT", fields=[
        LayerField(name="type", type="text", sample_values=["Educational", "Religious"])]),
    LayerInfo(id="z", code="ZONE", name="zone", geometry_type="POLYGON", fields=[LayerField(name="zone_no", type="integer")]),
    LayerInfo(id="b", code="BRTS", name="brts", geometry_type="POLYGON", fields=[]),
]
results = []


def check(name, ok, got=""):
    ok = bool(ok)
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name} {got}")


near = preflight("Show signals near educational landmarks")
check("near -> clarification with distance chips",
      near is not None and near.answer_kind == "clarification" and [o.label for o in near.options] == ["50 m", "100 m", "250 m", "500 m"])
picked = near.options[1].message
check("chip re-asks with the distance filled in", picked == "Show signals within 100 m of educational landmarks", picked)
check("...and that question plans instantly", fast_plan(picked, LAYERS) is not None)
check("nearest is not 'near'", preflight("Nearest 3 signals to the BRTS") is None)
check("near with a distance is fine", preflight("signals near the BRTS within 50 m") is None)
two = fast_plan("signals within 100 m of the BRTS and within 200 m of the zone", LAYERS)
got = two and [(sf.reference_layer, sf.distance_meters) for sf in [two.operation.spatial_filter, *two.operation.spatial_filters]]
check("two distance conditions -> both kept (ANDed)", got == [("BRTS", 100.0), ("ZONE", 200.0)], got)
three = fast_plan("Show signals within 100 m of the BRTS and within 300 m of educational landmarks", LAYERS)
got = three and [(sf.reference_layer, [(f.field, f.value) for f in sf.reference_filters]) for sf in [three.operation.spatial_filter, *three.operation.spatial_filters]]
check("second condition keeps its own value filter", got == [("BRTS", []), ("LANDMARKS", [("type", "Educational")])], got)

plan = fast_plan("Show signals on Dehu Aalandi Road", LAYERS)
noted = annotate("Show signals on Dehu Aalandi Road", plan, LAYERS)
check("fuzzy correction is stated", any("Dehu - Alandi Road" in n for n in noted.notes), noted.notes)
check("close alternative offered", any("Aalandi Road" in o.label and o.operation for o in noted.options), [o.label for o in noted.options])
exact = annotate("Show signals that are Not Working", fast_plan("Show signals that are Not Working", LAYERS), LAYERS)
check("typed-as-stored value adds no note", not exact.notes)

sugg = suggestions(LAYERS)
check("suggestions are all plannable", bool(sugg) and all(fast_plan(q, LAYERS) for q in sugg), sugg)
# Conversation: refinements build on the previous answer.
from app.repair import carry_over, is_follow_up
from app.schema import AttributeFilter, ChatTurn, GisOperation, PlanResult
LAYERS[0].fields.append(LayerField(name="prabhag_no", type="text", sample_values=list("ABCDEFGH")))
prev = GisOperation(kind="select", target_layer="SIGNAL",
                    attribute_filters=[AttributeFilter(field="road_name", op="=", value="Dehu - Alandi Road")])
check("'which are in prabhag no c' is a follow-up", is_follow_up("which are in prabhag no c", LAYERS, prev))
check("'count signals by type' starts fresh", not is_follow_up("Count signals by type", LAYERS, prev))
check("'how many?' is a follow-up", is_follow_up("how many?", LAYERS, prev))
refined = fast_plan("which are in prabhag no c", LAYERS, prev)
got = [(f.field, f.value) for f in refined.operation.attribute_filters] if refined else None
check("refinement keeps the road and adds prabhag_no = C",
      got == [("road_name", "Dehu - Alandi Road"), ("prabhag_no", "C")], got)
forgot = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="SIGNALS", attribute_filters=[AttributeFilter(field="prabhag_no", op="=", value="C")]))
kept = carry_over(prev, forgot, LAYERS).operation.attribute_filters
check("model path: earlier condition carried over", [f.field for f in kept] == ["road_name", "prabhag_no"])

from app.guide import remember_near
history = [ChatTurn(role="user", content="Show signals within 250 m of educational landmarks")]
msg, note, opts = remember_near("show landmarks near the BRTS", history)
check("remembered 'near' distance is reused", msg == "show landmarks within 250 m of the BRTS" and note and opts, msg)
check("no earlier choice -> still asks", remember_near("signals near BRTS", [])[0] == "signals near BRTS")
# "cast iron" vs stored abbreviations; never widen silently.
from app.repair import repair_plan
PIPES = LayerInfo(id="p", code="DISTRIBUTION_PIPELINE", name="distribution_pipeline", geometry_type="LINE", fields=[
    LayerField(name="constructi", type="text", sample_values=["A.C.", "C.I", "C.I Gravity", "C.I.", "D.I", "M.S."])])
cast = fast_plan("Show pipelines made of cast iron", [PIPES])
got = [(f.field, f.op, tuple(f.values or [f.value])) for f in cast.operation.attribute_filters] if cast else None
check("'cast iron' -> constructi IN (C.I, C.I.) on the fast path", got == [("constructi", "in", ("C.I", "C.I."))], got)
model = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="DISTRIBUTION_PIPELINE",
    attribute_filters=[AttributeFilter(field="constructi", op="=", value="copper")]))
asked = repair_plan("Show pipelines made of copper", model, [PIPES])
check("impossible value -> asks with real values, does not show all",
      asked.answer_kind == "clarification" and asked.operation is None and len(asked.options) >= 3, asked.clarification)
model_ci = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="DISTRIBUTION_PIPELINE",
    attribute_filters=[AttributeFilter(field="constructi", op="=", value="cast iron")]))
fixed = repair_plan("Show pipelines made of cast iron", model_ci, [PIPES])
got = [(f.field, tuple(f.values or [f.value])) for f in fixed.operation.attribute_filters] if fixed.operation else fixed.clarification
check("model's 'cast iron' replaced by the real C.I values", got == [("constructi", ("C.I", "C.I."))], got)
# One word -> one condition; layer found from a value.
LM = LayerInfo(id="lm", code="LANDMARKS", name="landmarks", geometry_type="POINT", fields=[
    LayerField(name="name", type="text", sample_values=["Ganesh Temple", "…(more)"]),
    LayerField(name="locality", type="text", sample_values=["Akurdi", "…(more)"]),
    LayerField(name="subtype", type="text", sample_values=["Hospital", "School", "Temple"]),
    LayerField(name="ward_no", type="integer")])
SIG = LAYERS[0]
t = fast_plan("show me all temples in ward 3", [SIG, LM])
got = (t.operation.target_layer, [(f.field, f.value) for f in t.operation.attribute_filters]) if t else None
check("'temples in ward 3' -> landmarks, subtype = Temple, ward_no = 3 (instant)",
      got == ("LANDMARKS", [("ward_no", 3), ("subtype", "Temple")]), got)
stacked = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="LANDMARKS", attribute_filters=[
        AttributeFilter(field="name", op="ilike", value="Temple"),
        AttributeFilter(field="locality", op="ilike", value="Temple"),
        AttributeFilter(field="ward_no", op="=", value=3)]))
fixed = repair_plan("show me all temples in ward 3", stacked, [SIG, LM])
got = sorted((f.field, f.op) for f in fixed.operation.attribute_filters)
check("model's stacked conditions -> one per word", got == [("subtype", "="), ("ward_no", "=")], got)
check("value of another layer is a new question, not a follow-up",
      not is_follow_up("show me all temples in ward 3", [SIG, LM], prev))
# Multi-step: count per area, then filter / rank the areas.
def step(q):
    p = fast_plan(q, LAYERS)
    o = p.operation if p else None
    return o and (o.kind, o.target_layer, o.group_by_layer, o.having_op, o.having_value, o.limit, o.order_desc,
                  [(f.field, f.value) for f in o.attribute_filters])
check("zones with more than 100 signals", step("zones with more than 100 signals") ==
      ("aggregate", "SIGNAL", "ZONE", ">", 100.0, None, None, []), step("zones with more than 100 signals"))
check("top 3 zones by number of signals", step("top 3 zones by number of signals") ==
      ("aggregate", "SIGNAL", "ZONE", None, None, 3, True, []), step("top 3 zones by number of signals"))
check("which zone has the fewest Not Working signals", step("which zone has the fewest Not Working signals") ==
      ("aggregate", "SIGNAL", "ZONE", None, None, 1, False, [("type", "Not Working")]), step("which zone has the fewest Not Working signals"))
# Conversation that is not a map query.
from app.guide import converse, is_small_talk
hi = converse("hello", LAYERS)
check("greeting answered with working suggestion chips", hi and hi.answer_kind == "answer" and hi.options)
lay = converse("what layers do I have?", LAYERS)
check("lists the real layers", lay and "signal" in lay.explanation and "landmarks" in lay.explanation)
flds = converse("what fields does signal have?", LAYERS)
check("lists a layer's fields with sample values", flds and "type (text)" in flds.explanation and "Not Working" in flds.explanation, flds and flds.explanation[:80])
vals = converse("what values does type have in landmarks?", LAYERS)
check("lists a field's values", vals and "Educational" in vals.explanation, vals and vals.explanation)
check("glossary", (converse("what is a buffer?", LAYERS) or PlanResult(answer_kind="answer", explanation="")).explanation.startswith("A buffer"))
check("map question is not conversation", converse("show signals in zone 13", LAYERS) is None)
check("small talk detected", is_small_talk("how can GIS help my municipality?", LAYERS))
check("data question is not small talk", not is_small_talk("signals that are Not Working", LAYERS))
# Field confidence.
from app.guide import field_confidence
LM2 = LayerInfo(id="lm2", code="LANDMARKS", name="landmarks", geometry_type="POINT", fields=[
    LayerField(name="type", type="text", sample_values=["Commercial", "Educational", "Religious"]),
    LayerField(name="subtype", type="text", sample_values=["ATM", "Commercial", "Temple"]),
    LayerField(name="name", type="text", sample_values=["Commercial Plaza"])])
plan_c = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="LANDMARKS", attribute_filters=[AttributeFilter(field="type", op="=", value="Commercial")]))
amb = field_confidence("show commercial landmarks", plan_c, [LM2])
check("value in two category fields -> asks which field",
      amb.answer_kind == "clarification" and sorted(o.label for o in amb.options) == ["subtype = Commercial", "type = Commercial"], amb.clarification)
named = field_confidence("show landmarks whose type is commercial", plan_c, [LM2])
check("field named by the user -> no question", named.answer_kind == "gis_operation")
wrong = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="LANDMARKS", attribute_filters=[AttributeFilter(field="type", op="=", value="Temple")]))
sw = field_confidence("show temples", wrong, [LM2])
check("value only stored elsewhere -> switched with a note",
      sw.operation.attribute_filters[0].field == "subtype" and sw.notes, sw.notes)
# Standing instructions.
from app.guide import apply_instructions, parse_instruction
rule = parse_instruction("From now on only show signals that are Not Working", LAYERS)
check("instruction parsed into a real rule",
      rule and rule.instruction_action == "add" and rule.instruction.layer == "SIGNAL"
      and [(f.field, f.value) for f in rule.instruction.filters] == [("type", "Not Working")], rule and rule.instruction)
later = apply_instructions(fast_plan("show signals in zone 13", LAYERS), [rule.instruction])
check("rule applied to a later question on that layer",
      sorted(f.field for f in later.operation.attribute_filters) == ["type", "zone_no"] and later.notes)
other = apply_instructions(fast_plan("show landmarks that are Educational", LAYERS), [rule.instruction])
check("rule not applied to another layer", [f.field for f in other.operation.attribute_filters] == ["type"] and not other.notes)
check("near rule", parse_instruction("always use 200 m for near", LAYERS).instruction.near_m == 200)
check("clear rules", parse_instruction("forget my instructions", LAYERS).instruction_action == "clear")
check("normal question is not an instruction", parse_instruction("show signals in zone 13", LAYERS) is None)
# Nearest per feature.
ne = fast_plan("nearest signal to each educational landmarks", LAYERS)
got = ne and (ne.operation.kind, ne.operation.target_layer, ne.operation.reference_layer, ne.operation.per_reference,
              ne.operation.count, [(f.field, f.value) for f in ne.operation.reference_filters])
check("nearest X to each Y (with Y's own condition)",
      got == ("nearest", "SIGNAL", "LANDMARKS", True, 1, [("type", "Educational")]), got)
ne2 = fast_plan("for each zone, the nearest 2 Not Working signals", LAYERS)
got = ne2 and (ne2.operation.count, ne2.operation.reference_layer, [(f.field, f.value) for f in ne2.operation.attribute_filters])
check("for each Y, the nearest N X (with X's condition)", got == (2, "ZONE", [("type", "Not Working")]), got)
# Function words never fuzzy-match a value; examples come from real layers.
from app.repair import matching_values
APT = LayerInfo(id="a", code="LANDMARKS", name="landmarks", geometry_type="POINT", fields=[
    LayerField(name="type", type="text", sample_values=["Other", "Others", "Residential"]),
    LayerField(name="subtype", type="text", sample_values=["Apartment", "ATM", "Temple"])])
apt = fast_plan("how many appartment are there", [APT])
got = apt and [(f.field, f.value) for f in apt.operation.attribute_filters]
check("'are there' is not the type 'Other'; 'appartment' -> Apartment", got == [("subtype", "Apartment")], got)
help_text = converse("what can you do?", [APT]).explanation
check("help examples come from the real layers", "landmarks" in help_text and "signals that are Not Working" not in help_text)
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
