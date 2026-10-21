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
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
