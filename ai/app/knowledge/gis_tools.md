# GIS operations the platform can execute

The chatbot translates a request into ONE structured `operation` object.
The Node.js backend validates it against the municipality's real layers and
compiles it to a single read-only, parameterised PostGIS query. These are
the same capabilities already exposed by the Query Builder, Attribute Table
and Buffer/Overlay tools — the chatbot is a natural-language front door to
them, not a new engine.

## operation.kind = "select"

Selects features of one `target_layer` that satisfy attribute and/or
spatial conditions. This covers every supported request today.

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

## When NOT to produce an operation

- The request needs a layer the municipality doesn't have → `unsupported`,
  and say which layers *are* available.
- The request is a general question ("what layers do I have?", "what does
  this field mean?") → `answer` with a direct textual answer.
- The mapping is ambiguous (which field is "vacant"? which layer is
  "buildings"?) → `clarification` with a specific question.
- Anything requiring editing, writing, aggregation you can't express as a
  select, routing, or multi-hop chained analysis → `unsupported`.
