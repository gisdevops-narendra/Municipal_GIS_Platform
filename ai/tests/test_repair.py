"""Plan-repair checks on the shapes qwen2.5:1.5b actually produced.

    docker cp ai/tests municipal-gis-ai:/app/tests
    docker exec -w /app municipal-gis-ai python -m tests.test_repair
"""
from app.repair import repair_plan
from app.schema import GisOperation, LayerField, LayerInfo, PlanResult

LAYERS = [
    LayerInfo(id="w", code="ELECTION_WARD_BOUNDARY", name="Election_Ward_Boundary", geometry_type="POLYGON",
              fields=[LayerField(name="election_w", type="text"), LayerField(name="total_ppln", type="integer")]),
    LayerInfo(id="v", code="VALVES", name="Valves", geometry_type="POINT",
              fields=[LayerField(name="valve_id", type="text"),
                      LayerField(name="water_valv", type="text"), LayerField(name="valve_dia", type="number"),
                      LayerField(name="curr_statu", type="text")]),
    LayerInfo(id="p", code="PROPOSED_WATER_DISTRIBUTION_NETWORK", name="Proposed_Water_Distribution_Network",
              geometry_type="LINE",
              fields=[LayerField(name="pipe_dia", type="number"), LayerField(name="cons_mat", type="text")]),
]


def plan(kind=None, **op):
    if kind is None:
        return PlanResult(answer_kind="unsupported", explanation="Count of Valves grouped by Election Ward.")
    return PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(kind=kind, **op))


def check(name, message, before, **expect):
    after = repair_plan(message, before, LAYERS)
    op = after.operation
    got = {k: getattr(op, k) if op else None for k in expect}
    ok = after.answer_kind == "gis_operation" and got == expect
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {got}")
    return ok


results = [
    # the two real failures from the chat probe
    check("unsupported -> aggregate per ward", "How many valves are there in each election ward?",
          plan(), kind="aggregate", target_layer="VALVES", metric="count",
          group_by_layer="ELECTION_WARD_BOUNDARY"),
    check("aggregate without metric -> sum length", "What is the total length of the water distribution network?",
          plan("aggregate", target_layer="PROPOSED_WATER_DISTRIBUTION_NETWORK"),
          metric="sum", metric_field="length"),
    # other likely gaps
    check("select -> count", "How many valves are there?",
          plan("select", target_layer="VALVES"), kind="aggregate", metric="count"),
    check("group by field", "Count valves by valve type",
          plan("aggregate", target_layer="VALVES", metric="count"), group_by="water_valv"),
    # real probe failure: the model grouped by the id column
    check("id grouping -> type field", "Count valves by valve type",
          plan("aggregate", target_layer="VALVES", metric="count", group_by="valve_id"), group_by="water_valv"),
    check("average numeric field", "Average valve diameter",
          plan("aggregate", target_layer="VALVES"), metric="avg", metric_field="valve_dia"),
    check("nearest count", "Nearest 3 valves to election ward 05",
          plan("nearest", target_layer="VALVES", reference_layer="ELECTION_WARD_BOUNDARY"), count=3),
    check("buffer distance in km", "Make a 1.5 km buffer around the valves",
          plan("buffer", target_layer="VALVES"), distance_meters=1500.0),
]

# Must NOT touch a correct plan, nor invent an operation for a general question.
untouched = plan("select", target_layer="VALVES")
same = repair_plan("Show valves with valve diameter above 300", untouched, LAYERS)
results.append(same is untouched)
print(f"{'PASS' if same is untouched else 'FAIL'}  plain select left alone")
general = PlanResult(answer_kind="answer", explanation="You have 3 layers.")
kept = repair_plan("What layers do I have?", general, LAYERS)
results.append(kept is general)
print(f"{'PASS' if kept is general else 'FAIL'}  general question left alone")

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
