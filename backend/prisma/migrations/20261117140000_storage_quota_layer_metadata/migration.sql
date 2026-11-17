-- Storage limits (MB) and Data Catalog metadata.
ALTER TABLE "municipalities" ADD COLUMN "storage_quota_mb" INTEGER;
ALTER TABLE "departments" ADD COLUMN "storage_quota_mb" INTEGER;
ALTER TABLE "gis_layers" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
