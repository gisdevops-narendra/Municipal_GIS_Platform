-- Routing layers: routing is enabled only on line layers the uploader
-- explicitly marked as a road network. Everything existing starts off.
ALTER TABLE "gis_layers" ADD COLUMN "routing_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "gis_layer_uploads" ADD COLUMN "routing_enabled" BOOLEAN NOT NULL DEFAULT false;
