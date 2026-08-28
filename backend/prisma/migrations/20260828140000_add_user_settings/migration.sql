-- Settings module — per-user application settings.
--
-- Hand-written (same convention as the GIS migrations): a plain
-- `prisma migrate diff` against this database also proposes dropping the
-- unmanaged runtime tables (`gis_demo_*`, GDAL-created `layer_<uuid>`) and
-- re-adding their GIST indexes — recurring false positives, omitted here.
-- This migration only adds the new `user_settings` table.

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- AddForeignKey
ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
