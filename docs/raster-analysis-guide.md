# Raster Analysis — User Guide

Raster Analysis turns elevation models, satellite images and other gridded
data into answers for city planning: where water collects, which wards are
losing green cover, where new construction appears, how many people live in
flood-prone land.

Open it from the map: **Municipal GIS → left toolbar → Raster Analysis**.

- The **rail** on the left of the panel holds the categories:
  **Data · Terrain · Analytics · Imagery · Planning · Workspace**.
- Click a category to see its tools as cards; click a card to open the tool.
  **← back** returns to the cards.
- You only see the tools your role has been granted in **Module Access**
  (Raster Analysis, modules 69 / 9xx). The server enforces the same rule.

## How every tool works

1. **Input** — most tools start from a raster chosen in *Raster layer*.
   A raster you just uploaded, downloaded or produced is selected
   automatically, so tools chain naturally (Download DEM → Slope → …).
2. **Settings** — each tool explains its options under the form.
3. **Run** — long tools run on the server as a *background job*. The panel
   shows the current step, elapsed time and a **Cancel** button; you can keep
   using the map. Jobs survive a server restart (they resume automatically).
4. **Result** — a new layer appears in the **Layers panel → Raster
   Analysis** group, already styled, plus numbers in the result list.
   - 📌 next to a number pins it to the **Dashboard**.
   - **CSV / PNG** buttons export tables and charts.
   - The layer's description records how it was made (tool, inputs, date).
5. **Save the result to** (owner only) chooses the department that owns the
   new layer; otherwise it is municipality-wide (owner) or your department.

## Data

| Tool | What it does | Tips |
|---|---|---|
| **Raster Upload & Publish** | Publishes a GeoTIFF, JPEG 2000, Erdas `.img` or a `.zip` of them. | Converted to Cloud-Optimised GeoTIFF; a progress bar shows the upload. |
| **Download from Online Sources** | Free data for an area (map view, a layer's extent, or drawn): **Elevation** (Copernicus 30 m), **Land cover** (ESA WorldCover 10 m), **Satellite image** (Sentinel-2 10 m — single scene with map preview, or a **cloud-free composite**), **Population** (Meta HRSL 30 m), **Surface water** (JRC 1984–2021). | Sentinel-2 bands are saved as 1 Blue · 2 Green · 3 Red · 4 NIR · 5 SWIR, ready for every index tool. Clouds are masked by default. |
| **Raster Styling** | Colour ramp, RGB imagery (with presets: true colour, false colour, urban, agriculture, land/water) or **Classes** (rename / recolour). | *Auto range (1–99 %)* fixes washed-out colours. |
| **Pixel Identify** | Reads pixel values; stays active for repeated clicks. | |
| **Statistics & Histogram** | Min / max / mean / percentiles, NoData share, histogram. | |
| **Download Raster** | GeoTIFF of the whole layer or the current view. | Needs the layer's Export permission. |
| **Mosaic**, **Resample / Reproject**, **Rasterize Vector**, **Fill NoData / Smooth** | Merge tiles, change pixel size / CRS, burn vectors to a grid, repair gaps. | |

## Terrain (needs an elevation raster / DEM)

| Tool | Municipal use |
|---|---|
| **Elevation Profile** | Road / pipeline gradients — hover the chart to see the spot on the map. |
| **Slope, Aspect, Hillshade** (incl. multi-directional), **Contours**, **Curvature**, **Terrain Ruggedness** | Site screening, base maps, drainage reading. |
| **Fill Sinks** → **Stream Network** → **Drainage / Watershed** | Natural drainage lines (with Strahler order) and catchments for storm-water planning. Run *Fill Sinks* first on noisy DEMs. |
| **Flood Inundation** | Area and depth under a chosen water level. |
| **Cut & Fill / Volume** | Earthwork for a design level, or **Stockpile** mode (volume of a heap above its edges). |
| **Line of Sight**, **Viewshed** (one or several observers) | CCTV / tower coverage — with several observers the map shows how many see each place. |
| **Object Heights (DSM − DTM)** | Building and tree heights from drone / LiDAR models. |
| **3D Terrain View** | Rotate the DEM in 3D, draped with any layer; save as PNG. |

## Analytics

| Tool | Municipal use |
|---|---|
| **Raster Calculator** | Map algebra with recipes (normalised difference, % change, threshold, mask); errors are shown as you type. |
| **Reclassify** | Turn values into classes — *Generate* gives equal-interval, quantile or natural-break ranges. |
| **Clip to Boundary** | Cut a raster to a polygon layer (e.g. `vmc_aoi`, or *only `wardno` = 10*), a drawn shape or selected features. |
| **Raster to Vector** | Polygons from classes. |
| **Zonal Statistics** | Mean / sum etc. per ward — optionally published as a ready-coloured choropleth. |
| **IDW Interpolation**, **Heatmap**, **Hotspot Analysis (Gi\*)**, **Proximity** | Surfaces from point readings; hotspots of trees / complaints / incidents (Gi\* shows which are statistically significant); distance to the nearest facility. |
| **Extract Values to Points** | Adds raster values as fields (e.g. elevation and NDVI at each tree). |
| **Least-cost Path** | Cheapest route across a cost raster (slope, suitability) for pipelines or drains. |

## Imagery (best with Sentinel-2 from Online Sources)

| Tool | Municipal use |
|---|---|
| **NDVI**, **Spectral Indices** (NDWI water, NDBI built-up, SAVI) | Vegetation, water and built-up maps. |
| **Index Time Series** | NDVI / NDWI / NDBI of a point or area on every clear date — park health, crop cycles. |
| **Water Body Monitor** | Area (ha) of a lake or pond over time. |
| **Urban Heat Island** | Land surface temperature (°C) from Landsat; use March–May to find heat hotspots. |
| **Air Quality (NO₂)** | Sentinel-5P nitrogen dioxide averaged over a period (~5 km — compare months / districts, not streets). |
| **Unsupervised / Supervised Classification** | Land-cover maps; supervised: draw a few areas per class, get the training accuracy. |
| **Change Detection**, **Land-cover Change Matrix**, **Swipe / Spyglass** | What changed between two dates — e.g. *cropland → built-up: 2.3 km²*. |

## Planning (decision support)

| Tool | What you get |
|---|---|
| **Site Suitability** | Weighted overlay of criteria (each "lower is better" or "higher is better") → 0–100 score; exclude water / protected rasters. Example — school site: slope 40 %, distance to roads 40 %, flood risk 20 %. |
| **Flood Risk (HAND)** | Very high / high / moderate / low flood-prone land from the DEM's height above the nearest drain — no water level needed. |
| **Population Exposure** | People living where a hazard condition holds (e.g. flood class ≤ 2, heat ≥ 42 °C), per ward. Needs the Population raster. |
| **Green Cover Report** | Green % per ward from a cloud-free composite, with change vs. the same dates last year; optional choropleth layer. |
| **Encroachment Monitor** | New construction inside protected zones between two periods (use the same season both years). *Sensitivity* trades misses for false alarms; click a site to zoom to it. |
| **Automatic Monitoring** | Re-runs Green Cover or Encroachment weekly / monthly (last 60 days vs. the same 60 days a year earlier). Alerts appear in the list **and are emailed** to the monitor's creator. |
| **Area Report** | One-page printable report (Print → *Save as PDF*) of a ward or drawn area: a map and statistics for each chosen raster. |

## Workspace

| Tool | Use |
|---|---|
| **Saved Workflows** | Tick tools you ran this session (e.g. Fill Sinks, then Streams on its result) and save; re-run the chain on any DEM in one click. |
| **Job History** | All past runs with their settings — *Show* the result or *Run again*. |
| **Time Slider** | Tick rasters in time order and press Play. |
| **Storage Manager** (owner) | Disk used per department; clean temporary and orphaned files. |
| **Share** (under a raster's info) | *Copy link* opens the map on that layer (sign-in needed); *Image URL* is a PNG of the layer. |

## Data sources and limits

| Source | Resolution | Area limit |
|---|---|---|
| Copernicus DEM GLO-30 | 30 m | 20 000 km² |
| ESA WorldCover 2021 | 10 m | 2 500 km² |
| Sentinel-2 L2A scene / composite | 10 m | 2 500 / 400 km² |
| Meta HRSL population, JRC surface water | 30 m | 5 000 km² |
| Landsat 8/9 surface temperature | 30 m | 2 500 km² |
| Sentinel-5P NO₂ | ~5 km | any |

All are free and need no account; the backend server needs internet access.
New grids are capped at 25 million cells — the error message tells you the
smallest pixel size that fits.

## Troubleshooting

| Message | What to do |
|---|---|
| *Your module access does not include this raster tool* | Ask the owner to grant the module in Module Access. |
| *The area is too large…* | Zoom in, draw a smaller area, or filter to fewer wards. |
| *No Sentinel-2 scenes…* / *all scenes were cloudy* | Widen the dates or allow more cloud; avoid the monsoon months. |
| *The boundary does not overlap this raster* | The raster and the polygon are in different places — check both on the map. |
| *The job was lost (the server restarted)* | Run it again (Job History → *Run again*). |

## For administrators

- **Modules:** Raster Analysis is module 69; tools are 910–996 (see Module
  Access). Owners always have every module; grant department heads / users as
  needed.
- **Alert email:** set `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` and
  `APP_PUBLIC_URL` for the backend (plain SMTP). In development the Mailpit
  container is used — read alerts at <http://localhost:8025>.
- **Self-tests:**
  `docker exec municipal-gis-backend python3 scripts/test_raster_ops.py`
  (offline processing) and
  `docker exec municipal-gis-backend npx ts-node -r tsconfig-paths/register scripts/e2e-raster.ts`
  (every tool end-to-end against the real services; cleans up after itself).
