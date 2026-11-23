-- More vector upload formats, all read through GDAL: KML / KMZ (Google
-- Earth), GPX (GPS), GeoPackage, Excel (.xlsx with coordinate columns, read
-- like a CSV) and AutoCAD DXF.
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'KML';
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'KMZ';
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'GPX';
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'GEOPACKAGE';
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'XLSX';
ALTER TYPE "GisUploadFileFormat" ADD VALUE IF NOT EXISTS 'DXF';
