"""No-LLM fast-path checks.

    docker cp ai/tests municipal-gis-ai:/app/tests
    docker exec -w /app municipal-gis-ai python -m tests.test_fastpath
"""
from app.fastpath import fast_plan
from app.schema import AttributeFilter, GisOperation, LayerField, LayerInfo

LAYERS = [
    LayerInfo(id="s", code="SIGNAL", name="signal", geometry_type="POINT",
              fields=[LayerField(name="type", type="text", sample_values=[
                          "Fixed time", "Manually operated", "Not Working", "Pedestrian", "Traffic Control",
                          "Traffic actuated (automatic)", "Working"]),
                      LayerField(name="ward_no", type="integer"), LayerField(name="zone_no", type="integer"),
                      LayerField(name="height", type="number"),
                      LayerField(name="road_name", type="text", sample_values=[
                          "Dehu - Alandi Road", "Dehu Alandi Road", "Spine Road", "…(more)"])]),
    LayerInfo(id="z", code="ZONE", name="zone", geometry_type="POLYGON",
              fields=[LayerField(name="zone_no", type="integer"), LayerField(name="zone_name", type="text")]),
    LayerInfo(id="l", code="LANDMARKS", name="landmarks", geometry_type="POINT",
              fields=[LayerField(name="name", type="text"),
                      LayerField(name="type", type="text", sample_values=["Commercial", "Educational", "Health Services", "Religious"]),
                      LayerField(name="subtype", type="text", sample_values=["ATM", "Commercial", "Hospital", "…(more)"])]),
    LayerInfo(id="r", code="RIVER", name="river", geometry_type="POLYGON",
              fields=[LayerField(name="waterbody_", type="text", sample_values=["Indrayani River", "Mutha River", "Pawna River"])]),
    LayerInfo(id="b", code="BRTS", name="brts", geometry_type="POLYGON", fields=[]),
    LayerInfo(id="p", code="DISTRIBUTION_PIPELINE", name="distribution_pipeline", geometry_type="LINE",
              fields=[LayerField(name="pipe_dia_i", type="number"), LayerField(name="zone_no", type="integer")]),
]


def summary(message, previous=None):
    plan = fast_plan(message, LAYERS, previous)
    if plan is None:
        return None
    op = plan.operation
    return {
        "kind": op.kind,
        "target": op.target_layer,
        "filters": sorted((f.field, f.op, tuple(f.values) if f.values else f.value) for f in op.attribute_filters),
        "group": op.group_by_layer or op.group_by,
        "within": _within(op.spatial_filter),
    }


def _within(sf):
    if sf is None:
        return None
    refs = tuple((f.field, f.value) for f in sf.reference_filters)
    return (sf.reference_layer, sf.distance_meters) + refs if sf.distance_meters else sf.reference_layer


def check(message, expect, previous=None):
    got = summary(message, previous)
    ok = got == expect
    print(f"{'PASS' if ok else 'FAIL'}  {message!r}: {got}")
    return ok


def eq(field, value):
    return (field, "=", value)


def sel(target="SIGNAL", filters=(), within=None):
    return {"kind": "select", "target": target, "filters": sorted(filters), "group": None, "within": within}


def cnt(filters=(), group=None):
    return {"kind": "aggregate", "target": "SIGNAL", "filters": sorted(filters), "group": group, "within": None}


TA = eq("type", "Traffic actuated (automatic)")
NOT_WORKING = GisOperation(kind="select", target_layer="SIGNAL",
                           attribute_filters=[AttributeFilter(field="type", op="=", value="Not Working")])
results = [
    # answered without the model
    check("Show traffic-actuated signals in zone no. 13.", sel(filters=[eq("zone_no", 13), TA])),
    check("Show all signals that are Not Working", sel(filters=[eq("type", "Not Working")])),
    check("show signals in zone 13", sel(filters=[eq("zone_no", 13)])),
    check("list signals of ward no. 7", sel(filters=[eq("ward_no", 7)])),
    check("show signals", sel()),
    check("show landmarks in zone no 13", sel(target="LANDMARKS", within="ZONE")),
    check("How many signals are there in each zone?", cnt(group="ZONE")),
    check("How many signals are in zone 13?", cnt(filters=[eq("zone_no", 13)])),
    check("Count signals by type", cnt(group="type")),
    # comparisons
    check("Which signals are taller than 5 metres?", sel(filters=[("height", ">", 5.0)])),
    check("Show signals with height at least 4", sel(filters=[("height", ">=", 4.0)])),
    check("Find distribution pipelines with diameter more than 300 in zone 13",
          sel(target="DISTRIBUTION_PIPELINE", filters=[("pipe_dia_i", ">", 300.0), eq("zone_no", 13)])),
    # values from the database (spelling variants become IN, "road" optional)
    check("Show signals on Dehu Alandi Road",
          sel(filters=[("road_name", "in", ("Dehu - Alandi Road", "Dehu Alandi Road"))])),
    check("show signals on dehu alandi", sel(filters=[("road_name", "in", ("Dehu - Alandi Road", "Dehu Alandi Road"))])),
    # the same word in two columns filters on the more category-like one only
    check("commercial landmarks", sel(target="LANDMARKS", filters=[eq("type", "Commercial")])),
    # typos in value words still match (5+ letters)
    check("Show signals on Dehu Aalandi Road", sel(filters=[("road_name", "in", ("Dehu - Alandi Road", "Dehu Alandi Road"))])),
    check("Show traffic-actuatd signals", sel(filters=[TA])),
    # distance to another layer / a named feature of it
    check("Find signals within 100 m of the BRTS", sel(within=("BRTS", 100.0))),
    check("signals within 1.5 km of the BRTS in zone 13", sel(filters=[eq("zone_no", 13)], within=("BRTS", 1500.0))),
    check("Show Health Services landmarks within 300 m of Pawna River",
          sel(target="LANDMARKS", filters=[eq("type", "Health Services")],
              within=("RIVER", 300.0, ("waterbody_", "Pawna River")))),
    # follow-ups extend the previous plan
    check("now only those in ward 5", sel(filters=[eq("type", "Not Working"), eq("ward_no", 5)]), NOT_WORKING),
    check("count them", cnt(filters=[eq("type", "Not Working")]), NOT_WORKING),
    check("only those within 100 m of the BRTS",
          sel(filters=[eq("type", "Not Working")], within=("BRTS", 100.0)), NOT_WORKING),
    # anything it cannot fully account for goes to the model
    check("Nearest 3 signals to the zone 13 office", None),
    check("What is the average height of all signals?", None),
    check("now only those in ward 5", None),  # no previous plan
    check("Show traffic signals in zone 13", None),
    check("Make a 100 m buffer around Not Working signals", None),
    check("Show signals with value more than 5", None),
    check("now only the broken ones", None, NOT_WORKING),
]
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
