-- Raster jobs survive a page reload: their live stage / progress, final
-- result and the panel tool that started them are kept on the job row, so
-- a reopened Raster Analysis panel can reattach to it or show its result.
ALTER TABLE "raster_job_history" ADD COLUMN "stage" TEXT;
ALTER TABLE "raster_job_history" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "raster_job_history" ADD COLUMN "result" JSONB;
ALTER TABLE "raster_job_history" ADD COLUMN "client_tool" TEXT;
ALTER TABLE "raster_job_history" ADD COLUMN "started_at" TIMESTAMP(3);
ALTER TABLE "raster_job_history" ADD COLUMN "seen_at" TIMESTAMP(3);
