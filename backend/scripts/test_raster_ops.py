#!/usr/bin/env python3
"""Self-test for raster_ops.py on synthetic rasters (no database, no network).

Run inside the backend container:  python3 scripts/test_raster_ops.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raster_ops.py")
# A 200 × 200 grid of 10 m pixels in UTM 43N, over Vadodara.
ORIGIN = (300000.0, 2468000.0)


def centre_lonlat():
    utm = osr.SpatialReference()
    utm.ImportFromEPSG(32643)
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    utm.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    lon, lat, _ = osr.CoordinateTransformation(utm, wgs).TransformPoint(ORIGIN[0] + 1000, ORIGIN[1] - 1000)
    return [lon, lat]


LONLAT_INSIDE = centre_lonlat()


def run(request):
    proc = subprocess.run([sys.executable, SCRIPT], input=json.dumps(request), capture_output=True, text=True)
    body = json.loads(proc.stdout.strip().splitlines()[-1])
    return proc.returncode, body


def write(path, bands, dtype=gdal.GDT_Float32, nodata=None):
    h, w = bands[0].shape
    ds = gdal.GetDriverByName("GTiff").Create(path, w, h, len(bands), dtype)
    ds.SetGeoTransform((ORIGIN[0], 10, 0, ORIGIN[1], 0, -10))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32643)
    ds.SetProjection(srs.ExportToWkt())
    for i, arr in enumerate(bands, start=1):
        band = ds.GetRasterBand(i)
        if nodata is not None:
            band.SetNoDataValue(nodata)
        band.WriteArray(arr)
    ds = None
    return path


class RasterOpsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        y, x = np.mgrid[0:200, 0:200]
        # A tilted plane (high in the north-west) with a 5 m deep pit.
        dem = 100 + 0.2 * (200 - x) + 0.1 * (200 - y)
        dem[95:105, 95:105] -= 5
        cls.dem = write(os.path.join(cls.dir, "dem.tif"), [dem])
        # 4 bands (B, G, R, NIR): left half "vegetation", right half "water".
        veg = x < 100
        blue = np.where(veg, 300, 400).astype(float)
        green = np.where(veg, 600, 900).astype(float)
        red = np.where(veg, 400, 500).astype(float)
        nir = np.where(veg, 3000, 200).astype(float)
        cls.image = write(os.path.join(cls.dir, "img.tif"), [blue, green, red, nir], gdal.GDT_UInt16)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def out(self, name):
        return os.path.join(self.dir, name)

    def ok(self, request):
        code, body = run(request)
        self.assertEqual(code, 0, body)
        return body

    def test_info_and_statistics(self):
        info = self.ok({"op": "info", "path": self.image})
        self.assertEqual(info["bandCount"], 4)
        self.assertAlmostEqual(info["pixelSizeM"], 10, places=3)
        stats = self.ok({"op": "statistics", "path": self.dem, "bins": 10})
        self.assertEqual(sum(stats["histogram"]["counts"]), stats["validCells"])
        self.assertLessEqual(stats["min"], stats["median"])

    def test_identify(self):
        r = self.ok({"op": "identify", "path": self.dem, "point": LONLAT_INSIDE})
        self.assertTrue(r["inside"])
        self.assertIsNotNone(r["values"][0]["value"])

    def test_terrain_kinds(self):
        for kind in ("slope", "aspect", "hillshade", "roughness", "TRI", "TPI"):
            with self.subTest(kind=kind):
                r = self.ok({"op": "terrain", "kind": kind, "path": self.dem, "output": self.out(f"{kind}.tif")})
                self.assertIsNotNone(r["stats"]["max"])

    def test_fill_sinks_fills_the_pit(self):
        r = self.ok({"op": "fill_sinks", "path": self.dem, "output": self.out("filled.tif")})
        self.assertGreater(r["filledCells"], 0)
        self.assertGreater(r["maxFillDepth"], 1)

    def test_reclassify_and_polygonize(self):
        rules = [{"min": 0, "max": 130, "value": 1}, {"min": 130, "max": 1000, "value": 2}]
        r = self.ok({"op": "reclassify", "path": self.dem, "rules": rules, "output": self.out("rc.tif")})
        self.assertEqual(len(r["classes"]), 2)
        p = self.ok({"op": "polygonize", "path": self.out("rc.tif"), "output": self.out("rc.gpkg")})
        self.assertGreater(p["count"], 0)

    def test_calculator_rejects_builtins(self):
        self.ok({"op": "calc", "inputs": [{"path": self.dem}], "expression": "A * 2", "output": self.out("c.tif")})
        code, body = run({"op": "calc", "inputs": [{"path": self.dem}], "expression": "__import__('os')", "output": self.out("x.tif")})
        self.assertEqual(code, 1, body)

    def test_spectral_indices(self):
        ndvi = self.ok({"op": "ndvi", "path": self.image, "redBand": 3, "nirBand": 4, "output": self.out("ndvi.tif")})
        self.assertAlmostEqual(ndvi["vegetationPct"], 50, delta=1)
        ndwi = self.ok({"op": "index", "kind": "ndwi", "path": self.image, "bandA": 2, "bandB": 4, "output": self.out("ndwi.tif")})
        self.assertAlmostEqual(ndwi["openWaterPct"], 50, delta=1)
        bands = {"blue": 1, "green": 2, "red": 3, "nir": 4}
        for kind in ("ndvi", "ndwi", "savi", "evi"):
            with self.subTest(kind=kind):
                r = self.ok({"op": "index", "kind": kind, "path": self.image, "bands": bands, "sensor": "sentinel2",
                             "output": self.out(f"{kind}.tif")})
                self.assertEqual(r["values"], "dn")
                self.assertLessEqual(r["stats"]["max"], 1)
        evi = self.ok({"op": "index", "kind": "evi", "path": self.image, "bands": bands, "output": self.out("evi2.tif")})
        self.assertAlmostEqual(evi["vegetationPct"], 50, delta=1)
        code, body = run({"op": "index", "kind": "ndbi", "path": self.image, "bands": bands, "output": self.out("x.tif")})
        self.assertEqual(code, 1, body)

    def test_classify_separates_two_covers(self):
        r = self.ok({"op": "classify", "path": self.image, "classes": 2, "output": self.out("cls.tif")})
        self.assertEqual([round(c["pct"]) for c in r["classes"]], [50, 50])

    def test_flood_and_viewshed(self):
        f = self.ok({"op": "flood", "path": self.dem, "level": 120, "output": self.out("flood.tif")})
        self.assertGreater(f["areaM2"], 0)
        v = self.ok({"op": "viewshed", "path": self.dem, "point": LONLAT_INSIDE, "output": self.out("vs.tif")})
        self.assertGreater(v["visibleCells"], 0)

    def test_mosaic_and_resample(self):
        m = self.ok({"op": "mosaic", "paths": [self.dem, self.out("filled.tif") if os.path.exists(self.out("filled.tif")) else self.dem],
                     "output": self.out("mosaic.tif")})
        self.assertEqual(m["inputs"], 2)
        r = self.ok({"op": "resample", "path": self.dem, "pixelSize": 20, "targetCrs": "same", "output": self.out("rs.tif")})
        self.assertAlmostEqual(r["pixelSizeM"], 20, places=3)

    def test_stream_network(self):
        r = self.ok({"op": "streams", "path": self.dem, "thresholdKm2": 0.05, "output": self.out("streams.gpkg")})
        self.assertGreater(r["count"], 0)
        self.assertGreaterEqual(r["maxOrder"], 1)

    def test_multi_observer_viewshed(self):
        lon, lat = LONLAT_INSIDE
        r = self.ok({"op": "viewshed_multi", "path": self.dem, "points": [[lon, lat], [lon + 0.003, lat + 0.003]],
                     "output": self.out("vsm.tif")})
        self.assertEqual(r["observers"], 2)
        self.assertGreater(r["multiVisibleM2"], 0)

    def test_change_matrix(self):
        a = np.ones((200, 200), dtype=np.uint8)
        b = a.copy()
        b[:, 150:] = 2
        before = write(self.out("lc_a.tif"), [a], gdal.GDT_Byte, 0)
        after = write(self.out("lc_b.tif"), [b], gdal.GDT_Byte, 0)
        r = self.ok({"op": "change_matrix", "before": before, "after": after, "output": self.out("cm.tif")})
        self.assertAlmostEqual(r["changedPct"], 25, delta=0.5)
        self.assertEqual(r["codes"][0]["from"], 1)
        self.assertEqual(r["codes"][0]["to"], 2)

    def test_supervised_classification(self):
        lon, lat = LONLAT_INSIDE
        # Training squares well inside the vegetated (west) and water (east) halves.
        def square(dlon):
            x0, y0 = lon + dlon, lat
            return {"type": "Polygon", "coordinates": [[[x0, y0], [x0 + 0.002, y0], [x0 + 0.002, y0 + 0.002],
                                                        [x0, y0 + 0.002], [x0, y0]]]}
        classes = [{"label": "Vegetation", "geometry": square(-0.008)}, {"label": "Water", "geometry": square(0.005)}]
        r = self.ok({"op": "supervised", "path": self.image, "classes": classes, "output": self.out("sup.tif")})
        self.assertGreater(r["accuracyPct"], 95)
        self.assertEqual([round(c["pct"]) for c in r["classes"]], [50, 50])

    def test_mesh_for_3d_view(self):
        r = self.ok({"op": "mesh", "path": self.dem, "size": 50})
        self.assertEqual(len(r["z"]), r["width"] * r["height"])
        self.assertLessEqual(max(r["width"], r["height"]), 50)
        self.assertAlmostEqual(r["cellX"], 40, delta=2)

    def test_find_raster_in_zip(self):
        import zipfile
        archive = self.out("bundle.zip")
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("readme.txt", "hello")
            z.write(self.dem, "data/dem.tif")
        r = self.ok({"op": "find_raster", "path": archive})
        self.assertTrue(r["path"].endswith("data/dem.tif"))
        self.ok({"op": "info", "path": r["path"]})

    def test_suitability(self):
        slope = self.out("slope_s.tif")
        self.ok({"op": "terrain", "kind": "slope", "path": self.dem, "output": slope})
        r = self.ok({"op": "suitability", "output": self.out("suit.tif"), "exclude": [],
                     "criteria": [{"path": self.dem, "direction": "lower", "weight": 1, "name": "dem"},
                                  {"path": slope, "direction": "lower", "weight": 1, "name": "slope"}]})
        self.assertAlmostEqual(sum(c["weightPct"] for c in r["criteria"]), 100, delta=0.01)
        self.assertLessEqual(r["stats"]["max"], 100)
        self.assertGreater(r["highlySuitableM2"], 0)

    def test_flood_risk_hand(self):
        r = self.ok({"op": "hand", "path": self.dem, "thresholdKm2": 0.05, "classes": [1, 3, 6], "output": self.out("hand.tif")})
        self.assertEqual([c["value"] for c in r["classes"]], [1, 2, 3, 4])
        self.assertAlmostEqual(sum(c["pct"] for c in r["classes"]), 100, delta=0.1)

    def test_area_report_for_drawn_polygon(self):
        lon, lat = LONLAT_INSIDE
        poly = {"type": "Polygon", "coordinates": [[[lon - 0.004, lat - 0.004], [lon + 0.004, lat - 0.004],
                                                     [lon + 0.004, lat + 0.004], [lon - 0.004, lat + 0.004], [lon - 0.004, lat - 0.004]]]}
        r = self.ok({"op": "area_report", "polygon": poly,
                     "rasters": [{"path": self.dem, "name": "DEM", "layerId": "a"},
                                 {"path": self.out("lc_a.tif") if os.path.exists(self.out("lc_a.tif")) else self.dem,
                                  "name": "Classes", "layerId": "b", "classes": [{"value": 1, "label": "One"}]}]})
        self.assertGreater(r["areaM2"], 500_000)
        self.assertIn("mean", r["sections"][0])

    def test_exposure(self):
        pop = write(self.out("pop.tif"), [np.full((200, 200), 2.0)])
        r = self.ok({"op": "exposure", "population": pop, "hazard": self.dem, "operator": "<=", "threshold": 120})
        self.assertAlmostEqual(r["population"], 80000, delta=1)
        self.assertGreater(r["exposed"], 0)
        self.assertLess(r["exposed"], r["population"])

    def test_least_cost_path(self):
        lon, lat = LONLAT_INSIDE
        r = self.ok({"op": "least_cost", "path": self.dem, "from": [lon - 0.008, lat - 0.008], "to": [lon + 0.008, lat + 0.008],
                     "baseCost": 1, "output": self.out("lcp.gpkg")})
        self.assertGreaterEqual(r["lengthM"], r["straightM"] * 0.99)
        self.assertEqual(r["path"]["type"], "LineString")

    def test_fill_nodata(self):
        arr = np.full((50, 50), 10.0)
        arr[20:25, 20:25] = -9999
        holey = write(self.out("holey.tif"), [arr], nodata=-9999)
        r = self.ok({"op": "fill_nodata", "path": holey, "maxDistance": 20, "smoothPasses": 1, "output": self.out("filled2.tif")})
        self.assertEqual(r["filledCells"], 25)

    def test_object_heights(self):
        y, x = np.mgrid[0:200, 0:200]
        dsm = 100 + 0.2 * (200 - x) + 0.1 * (200 - y)
        dsm[50:60, 50:60] += 12
        top = write(self.out("dsm.tif"), [dsm])
        ground = write(self.out("dtm.tif"), [100 + 0.2 * (200 - x) + 0.1 * (200 - y)])
        r = self.ok({"op": "heights", "dsm": top, "dtm": ground, "minHeight": 2, "output": self.out("ndsm.tif")})
        self.assertAlmostEqual(r["maxHeight"], 12, delta=0.1)
        self.assertAlmostEqual(r["objectAreaM2"], 100 * 100, delta=1)

    def test_curvature_and_multihillshade(self):
        c = self.ok({"op": "terrain", "kind": "curvature", "path": self.dem, "output": self.out("curv.tif")})
        self.assertLess(c["stats"]["min"], 0)
        self.ok({"op": "terrain", "kind": "multihillshade", "path": self.dem, "output": self.out("mhs.tif")})

    def test_stockpile_volume(self):
        lon, lat = LONLAT_INSIDE
        y, x = np.mgrid[0:200, 0:200]
        heap = np.full((200, 200), 50.0)
        heap[90:110, 90:110] += 5
        pile = write(self.out("pile.tif"), [heap])
        poly = {"type": "Polygon", "coordinates": [[[lon - 0.0015, lat - 0.0015], [lon + 0.0015, lat - 0.0015],
                                                     [lon + 0.0015, lat + 0.0015], [lon - 0.0015, lat + 0.0015], [lon - 0.0015, lat - 0.0015]]]}
        r = self.ok({"op": "cut_fill", "path": pile, "polygon": poly, "baseFromBoundary": True})
        self.assertAlmostEqual(r["baseLevel"], 50, delta=0.01)
        self.assertAlmostEqual(r["cutM3"], 20 * 20 * 100 * 5, delta=1)

    def test_errors_are_reported_as_json(self):
        code, body = run({"op": "contour", "path": self.dem, "interval": 100000, "output": self.out("ct.gpkg")})
        self.assertEqual(code, 1)
        self.assertIn("error", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
