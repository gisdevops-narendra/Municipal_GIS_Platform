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
two = preflight("signals within 100 m of BRTS and within 200 m of the zone")
check("two distance conditions -> unsupported, not silently dropped", two is not None and two.answer_kind == "unsupported")

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
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
