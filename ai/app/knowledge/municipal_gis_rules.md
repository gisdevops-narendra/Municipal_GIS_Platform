# Municipal GIS analysis reference

Reference guidance for interpreting natural-language planning questions as
spatial operations on municipal GIS layers. These are general Indian urban
local body norms (URDPFI Guidelines, Model Building Bye-laws, common
Development Control Regulations). They are *reference knowledge for phrasing
a query*, not a substitute for the sanctioned Development Plan / GDCR of a
specific municipality. Every result returned to the user is computed from
that municipality's own GIS data, never from these numbers.

## Roads and right-of-way

- "Near a road", "abutting a road", "road frontage" without a stated
  distance is commonly assessed at 0–12 m from the road centreline or
  edge, depending on road hierarchy. When the user does not give a
  distance, ask or use a small default (e.g. 15 m) and say so.
- Road hierarchy typically recorded in a `type` / `road_type` /
  `hierarchy` / `class` field: arterial / sub-arterial, collector,
  local / access, plus named categories such as "National Highway",
  "State Highway", "Ring Road", "Municipal Road", "Collector Road".
- Building line / setback from major roads is often 4.5 m to 12 m; along
  highways the regulated buffer can be 30 m or more from the road edge.

## Buffers around sensitive features

- Water bodies, lakes, rivers: a no-development buffer of 30 m (small
  water bodies) up to 100 m+ (rivers, large lakes) is common.
- Around schools and hospitals, certain uses (e.g. liquor outlets,
  polluting industry) are restricted within ~100–200 m.
- Around a fire station, effective response is usually planned for a
  service radius of ~1–3 km.
- "Walkable to" a facility is usually taken as ~400–800 m (5–10 min walk).

## Zoning and land use

- Land-use / zone is usually a polygon layer with a `zone` / `land_use` /
  `zone_no` / `category` field: Residential (R1/R2), Commercial (C1/C2),
  Industrial (I1/I2/general/special/hazardous), Public & Semi-Public,
  Recreational / Green / Open Space, Agricultural, Transport & Communication.
- "Vacant land", "vacant plot", "vacant property" maps to a plot/parcel
  layer filtered by a status/land-use field whose value indicates the plot
  is unbuilt — e.g. `status = 'Vacant'`, `land_use = 'Vacant'`,
  `use = 'Open'`, or `is_built = false`. Confirm the exact field/value from
  the layer's own sampled values.
- Plot area is normally stored in square metres; 1 sq ft = 0.092903 sq m,
  so "2000 sq ft" ≈ 185.8 sq m and "1 acre" = 4046.86 sq m.

## Wards and administrative units

- Ward / prabhag / zone number fields: `ward`, `ward_no`, `ward_number`,
  `prabhag_no`, `zone_no`. "Ward 5" means the ward layer (or any layer
  carrying a ward field) filtered to that number, often as a string or an
  integer — check the sampled values.
- "In ward 5" on a non-ward layer means: features of that layer that fall
  within (spatially) ward 5's polygon, OR that carry `ward_no = 5`
  directly if the layer has that attribute — prefer the attribute when it
  exists, it is exact and cheap.

## Distance and unit conventions

- Municipal GIS in India is typically stored in a projected CRS in metres
  (UTM zone, e.g. EPSG:32643 / 32644, or a state grid). Distances given by
  the user in metres or kilometres are true ground distances.
- "within 50 m", "within 1 km", "closer than 200 m" → a distance
  (proximity) predicate between two layers.
- "inside", "within the boundary of", "falls in" → a containment predicate.
- "crosses", "passes through", "touches", "overlaps" → an intersection
  predicate.

## Phrasing examples

- "buildings within 50 m of roads" → target = buildings/plots layer,
  spatial = within_distance 50 m of the roads layer.
- "vacant properties larger than 2000 sq ft in Ward 5" → target = plot /
  property layer, attribute filters = vacancy field + area > 185.8 (sq m),
  ward scoping via `ward_no = 5` attribute if present else spatial within
  the ward-5 polygon.
- "schools within 1 km of hospitals" → target = schools layer, spatial =
  within_distance 1000 m of the hospitals layer (or the amenities layer
  filtered to hospitals).
- "signals on ring roads" → target = signals/junction layer, spatial =
  intersects (or within_distance ~10 m of) the roads layer filtered to
  `type ILIKE '%ring%'`.
