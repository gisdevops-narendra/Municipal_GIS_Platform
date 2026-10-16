-- Raster Analysis workspace tools: saved workflows, job history, dashboard pins.
CREATE TABLE "raster_workflows" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "raster_workflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "raster_workflows_municipality_id_idx" ON "raster_workflows"("municipality_id");

CREATE TABLE "raster_job_history" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "layer_id" TEXT,
    "layer_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "raster_job_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "raster_job_history_user_id_created_at_idx" ON "raster_job_history"("user_id", "created_at");

CREATE TABLE "raster_pins" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "detail" TEXT,
    "layer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "raster_pins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "raster_pins_municipality_id_idx" ON "raster_pins"("municipality_id");
