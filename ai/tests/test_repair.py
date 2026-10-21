"""Plan-repair checks on the shapes qwen2.5:1.5b actually produced.

    docker cp ai/tests municipal-gis-ai:/app/tests
    docker exec -w /app municipal-gis-ai python -m tests.test_repair
"""
from app.repair import repair_plan
from app.schema import AttributeFilter, GisOperation, LayerField, LayerInfo, PlanResult, SpatialFilter

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

# "display all signals in zone no 13" — the model's JSON failed validation,
# leaving an `unsupported` plan with no operation.
AREA_LAYERS = [
    LayerInfo(id="s", code="SIGNAL", name="signal", geometry_type="POINT",
              fields=[LayerField(name="type", type="text", sample_values=[
                          "Fixed time", "Manually operated", "Not Working", "Pedestrian", "Traffic Control",
                          "Traffic actuated (automatic)", "Working"]),
                      LayerField(name="ward_no", type="integer"), LayerField(name="zone_no", type="integer"),
                      LayerField(name="height", type="number")]),
    LayerInfo(id="z", code="ZONE", name="zone", geometry_type="POLYGON",
              fields=[LayerField(name="zone_no", type="integer"), LayerField(name="zone_name", type="text")]),
    LayerInfo(id="l", code="LANDMARKS", name="landmarks", geometry_type="POINT",
              fields=[LayerField(name="name", type="text")]),
]


def check_area(name, message, before, **expect):
    after = repair_plan(message, before, AREA_LAYERS)
    op = after.operation
    got = {k: (getattr(op, k) if op else None) for k in expect}
    ok = after.answer_kind == "gis_operation" and got == expect
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {got}")
    return ok


def flt(field, value):
    return [AttributeFilter(field=field, op="=", value=value)]


results += [
    check_area("unsupported -> select signals, zone_no = 13", "display all signals in zone no 13",
               plan(), kind="select", target_layer="SIGNAL", attribute_filters=flt("zone_no", 13)),
    check_area("select missing the zone filter", "show signals in zone 13",
               plan("select", target_layer="SIGNAL"), attribute_filters=flt("zone_no", 13)),
    check_area("ward no. on a layer with ward_no", "list signals of ward no. 7",
               plan("select", target_layer="SIGNAL"), attribute_filters=flt("ward_no", 7)),
    check_area("no zone column -> within the zone polygon", "show landmarks in zone no 13",
               plan(), kind="select", target_layer="LANDMARKS",
               spatial_filter=SpatialFilter(relation="within", reference_layer="ZONE",
                                            reference_filters=flt("zone_no", 13))),
    check_area("count in a zone", "how many signals are in zone 13?",
               plan("aggregate", target_layer="SIGNAL", metric="count"),
               metric="count", attribute_filters=flt("zone_no", 13)),
]

# Real chat: "Count signals by type" right after "...Not Working" came back
# with the earlier type = 'Not Working' filter copied in.
nw = [AttributeFilter(field="type", op="=", value="Not Working")]
results += [
    check_area("carried-over filter dropped from a group-by", "Count signals by type",
               plan("aggregate", target_layer="SIGNAL", metric="count", group_by="type",
                    attribute_filters=list(nw)), attribute_filters=[], group_by="type"),
    check_area("carried-over filter dropped from a plain list", "show signals in zone 13",
               plan("select", target_layer="SIGNAL", attribute_filters=list(nw)),
               attribute_filters=flt("zone_no", 13)),
]
results.append(check_area("invented zone_no dropped from a per-zone count", "How many signals are there in each zone?",
    plan("aggregate", target_layer="SIGNAL", metric="count", group_by_layer="ZONE",
         attribute_filters=flt("zone_no", 1)), attribute_filters=[], group_by_layer="ZONE"))
# Real chat: the model kept zone_no = 13 but dropped "traffic-actuated" and
# added `within ZONE where id = '13-0-0-0-0-4'` (a zone id sample) -> 0 rows.
results += [
    check_area("named category added, made-up spatial filter dropped", "Show traffic-actuated signals in zone no. 13.",
               plan("select", target_layer="SIGNAL", attribute_filters=flt("zone_no", 13),
                    spatial_filter=SpatialFilter(relation="within", reference_layer="ZONE",
                                                 reference_filters=[AttributeFilter(field="id", op="=", value="13-0-0-0-0-4")])),
               attribute_filters=flt("zone_no", 13) + flt("type", "Traffic actuated (automatic)"), spatial_filter=None),
    check_area("half-written filter dropped", "What is the average height of all signals?",
               plan("aggregate", target_layer="SIGNAL", metric="avg", metric_field="height",
                    attribute_filters=[AttributeFilter(field="height", op="=")]),
               attribute_filters=[], metric="avg", metric_field="height"),
    check_area("'not working' picks Not Working, not Working", "show signals that are not working",
               plan(), kind="select", target_layer="SIGNAL", attribute_filters=flt("type", "Not Working")),
]
# Real chat: "within 100 m of the BRTS" came back as kind nearest with
# prabhag_no = 'BRTS' (prabhag_no only holds A-H) -> "Nearest to what?".
BRTS_LAYERS = AREA_LAYERS + [LayerInfo(id="b", code="BRTS", name="brts", geometry_type="POLYGON", fields=[])]
BRTS_LAYERS[0] = BRTS_LAYERS[0].model_copy(update={"fields": BRTS_LAYERS[0].fields + [
    LayerField(name="prabhag_no", type="text", sample_values=list("ABCDEFGH"))]})
brts = repair_plan("Find signals within 100 m of the BRTS", plan(
    "nearest", target_layer="SIGNALS", attribute_filters=[AttributeFilter(field="prabhag_no", op="=", value="BRTS")],
    spatial_filter=SpatialFilter(relation="within_distance", reference_layer="BRTS", distance_meters=100)), BRTS_LAYERS)
ok = brts.operation.kind == "select" and brts.operation.attribute_filters == [] and brts.operation.spatial_filter is not None
results.append(ok)
print(f"{'PASS' if ok else 'FAIL'}  nearest -> select, impossible prabhag value dropped: "
      f"{brts.operation.kind} {brts.operation.attribute_filters}")
road = repair_plan("Find signals within 100 m of the BRTS", plan(
    "select", target_layer="SIGNAL", attribute_filters=[AttributeFilter(field="road_name", op="ilike", value="BRTS")],
    spatial_filter=SpatialFilter(relation="within_distance", reference_layer="BRTS", distance_meters=100)), BRTS_LAYERS)
ok = road.operation.attribute_filters == []
results.append(ok)
print(f"{'PASS' if ok else 'FAIL'}  value that only names the reference layer dropped: {road.operation.attribute_filters}")
asked = repair_plan("Show all signals that are Not Working",
                    plan("select", target_layer="SIGNAL", attribute_filters=list(nw)), AREA_LAYERS)
ok = asked.operation.attribute_filters == nw
results.append(ok)
print(f"{'PASS' if ok else 'FAIL'}  filter the request states is kept")
follow = repair_plan("now only those in zone 13",
                     plan("select", target_layer="SIGNAL", attribute_filters=list(nw)), AREA_LAYERS)
ok = follow.operation.attribute_filters == nw + flt("zone_no", 13)
results.append(ok)
print(f"{'PASS' if ok else 'FAIL'}  follow-up keeps the earlier filter and adds zone 13")

# Must NOT touch a correct plan, nor invent an operation for a general question.
untouched = plan("select", target_layer="VALVES")
same = repair_plan("Show valves with valve diameter above 300", untouched, LAYERS)
results.append(same is untouched)
print(f"{'PASS' if same is untouched else 'FAIL'}  plain select left alone")
correct = PlanResult(answer_kind="gis_operation", explanation="x", operation=GisOperation(
    kind="select", target_layer="SIGNAL", attribute_filters=flt("zone_no", 13)))
kept_ok = repair_plan("display all signals in zone no 13", correct, AREA_LAYERS)
results.append(kept_ok is correct)
print(f"{'PASS' if kept_ok is correct else 'FAIL'}  plan that already has zone_no = 13 left alone")
general = PlanResult(answer_kind="answer", explanation="You have 3 layers.")
kept = repair_plan("What layers do I have?", general, LAYERS)
results.append(kept is general)
print(f"{'PASS' if kept is general else 'FAIL'}  general question left alone")

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
