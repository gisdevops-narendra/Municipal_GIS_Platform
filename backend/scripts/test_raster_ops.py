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

    def test_errors_are_reported_as_json(self):
        code, body = run({"op": "contour", "path": self.dem, "interval": 100000, "output": self.out("ct.gpkg")})
        self.assertEqual(code, 1)
        self.assertIn("error", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
