CREATE TABLE "gis_aqi_snapshots" (
    "station" TEXT NOT NULL,
    "hour" TIMESTAMPTZ(6) NOT NULL,
    "city" TEXT,
    "aqi" INTEGER,
    "pm25" DOUBLE PRECISION,
    "pm10" DOUBLE PRECISION,
    CONSTRAINT "gis_aqi_snapshots_pkey" PRIMARY KEY ("station", "hour")
);
CREATE INDEX "gis_aqi_snapshots_city_hour_idx" ON "gis_aqi_snapshots"("city", "hour");
