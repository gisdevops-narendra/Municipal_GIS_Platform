-- Multi-format rendering, part 1: the new rendering formats (enum values
-- must be committed before a later statement may use them).
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'AUTO';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'PMTILES';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'WMTS';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'XYZ';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'COG';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'WFS';
ALTER TYPE "GisRenderMode" ADD VALUE IF NOT EXISTS 'OGC_FEATURES';
