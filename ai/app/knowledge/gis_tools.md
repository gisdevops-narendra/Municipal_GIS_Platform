# GIS operations the platform can execute

The chatbot translates a request into ONE structured `operation` object.
The Node.js backend validates it against the municipality's real layers and
compiles it to a single read-only, parameterised PostGIS query. These are
the same capabilities already exposed by the Query Builder, Attribute Table
and Buffer/Overlay tools — the chatbot is a natural-language front door to
them, not a new engine.

## operation.kind = "select"

Selects features of one `target_layer` that satisfy attribute and/or
spatial conditions ("show / find / list / which ...").

Every other kind below starts from the same selection: `target_layer` +
`attribute_filters` + `spatial_filter` pick the features it works on.

### attribute_filters[]  (like the Query Builder)

`{ "field": <column>, "op": <operator>, "value": ..., "value2": ..., "values": [...] }`

Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not_in`, `like`,
`ilike` (case-insensitive contains — value need not include `%`),
`between` (needs `value` + `value2`), `is_null`, `is_not_null`.

`field` MUST be one of the target layer's real columns (see the layer
metadata in context). Never invent a column. If the user's wording doesn't
map cleanly to a real column/value, return `answer_kind = "clarification"`.

### spatial_filter  (like the Query Builder's spatial tab + Buffer/Overlay)

`{ "relation": <r>, "reference_layer": <layer>, "distance_meters": <n>,
   "reference_filters": [ ...attribute_filters on the reference layer... ] }`

Relations:
- `within_distance` — target features within `distance_meters` ground
  metres of any reference feature (proximity / buffer-and-select). Requires
  `distance_meters`.
- `intersects` — target geometry touches or overlaps a reference geometry.
- `within` — target geometry lies completely inside a reference geometry
  (e.g. points/lines inside a ward or zone polygon).
- `contains` — target geometry completely contains a reference geometry.
- `disjoint` — target features that are NOT near / not touching any
  reference feature (use with care, can be large).

`reference_filters` narrows the reference layer first (e.g. roads where
`type ILIKE 'ring'`, or the single ward polygon where `ward_no = 5`).

### limit

Optional integer cap on returned features. The backend also enforces a
hard maximum.

## operation.kind = "aggregate"

"How many", "count", "total", "average", "per ward / zone / type".
- `metric`: `count` | `sum` | `avg` | `min` | `max`.
- `metric_field`: a numeric column for sum/avg/min/max (null for count).
  For "total road / pipe length" or "total plot area" on a layer without
  such a column, use `length` (line layers) or `area` (polygon layers):
  the backend measures the geometry in metres / square metres.
- Group by a column of the target layer: `group_by` (e.g. `valve_type`).
- Group by area: `group_by_layer` (a polygon layer such as wards or zones)
  + `group_by_layer_field` (its name/number column). Each feature counts
  once, in the polygon containing it; polygons with none show 0.

## operation.kind = "nearest"

"Nearest / closest N X to Y". `target_layer` = X (what to rank),
`reference_layer` + `reference_filters` = Y (where to measure from),
`count` = N (default 1, max 50). Straight-line distance.

## operation.kind = "buffer"

"Buffer / zone / area of N m around X". `target_layer` = X,
`distance_meters` = N (max 10 km). Returns one dissolved buffer polygon
and its area. To *select features inside* a buffer, use `select` with a
`within_distance` spatial_filter instead.

## operation.kind = "route"

"Route / path / road distance from A to B". `target_layer` +
`attribute_filters` = A, `to_layer` + `to_filters` = B, `network_layer` =
the road (line) layer, or null to use the municipality's road layer.
The first feature matching each side is used.

## operation.kind = "service_area"

"Area reachable within N m by road from X". `target_layer` +
`attribute_filters` = X, `distance_meters` = N, `network_layer` as for
route.

## When NOT to produce an operation

- The request needs a layer the municipality doesn't have → `unsupported`,
  and say which layers *are* available.
- The request is a general question ("what layers do I have?", "what does
  this field mean?") → `answer` with a direct textual answer.
- The mapping is ambiguous (which field is "vacant"? which layer is
  "buildings"?) → `clarification` with a specific question.
- Anything requiring editing or writing data, styling layers, raster
  analysis, or multi-step chained analysis ("buffer, then intersect, then
  export") → `unsupported`.
