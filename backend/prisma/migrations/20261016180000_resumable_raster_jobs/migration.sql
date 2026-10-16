-- Raster jobs are recorded when queued (not only when finished) so they can
-- be resumed after a backend restart.
ALTER TABLE "raster_job_history" ALTER COLUMN "finished_at" DROP NOT NULL;
ALTER TABLE "raster_job_history" ADD COLUMN "output_department_id" TEXT;
