-- Raster Analysis: scheduled Green Cover / Encroachment monitors.
CREATE TABLE "raster_monitors" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "frequency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_summary" TEXT,
    "last_result" JSONB,
    "alert" BOOLEAN NOT NULL DEFAULT false,
    "alert_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "raster_monitors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "raster_monitors_municipality_id_idx" ON "raster_monitors"("municipality_id");
CREATE INDEX "raster_monitors_active_next_run_at_idx" ON "raster_monitors"("active", "next_run_at");
